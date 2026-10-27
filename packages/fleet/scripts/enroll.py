#!/usr/bin/env python3
"""The `Fleet enroll` workflow's half of node enrollment.

Runs in GitHub Actions, never on a node. Reads the enrollment issue, logs in to
Vault with the workflow's GitHub OIDC identity (no stored credential), asks for
the role's age key as a response-wrapped token (the Vault policy refuses an
unwrapped read, so this job never holds the key), and seals that token to the
public key in the issue. The result file holds one line the node understands:

  fleet-sealed: <ciphertext>   or   fleet-error: <what to do>

Always exits 0 after writing the result, so the workflow can post either line.
"""
import os
import sys

# Keep standard-library imports isolated from repository helper modules.
# A former token.py shadowed the stdlib module through tokenize/traceback.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [entry for entry in sys.path if os.path.abspath(entry or ".") != _HERE]

import importlib.util
import json
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("decide", HERE / "decide.py")
decide = importlib.util.module_from_spec(spec)
sys.modules["decide"] = decide
spec.loader.exec_module(decide)

AUDIENCE_PATH = "/v1/auth/jwt/login"
LOGIN_ROLE = "fleet-enroll"
WRAP_TTL = "1h"


def call(url, headers=None, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})},
                                     method="POST" if body is not None else "GET")
    with urllib.request.urlopen(request, timeout=30) as reply:
        return json.loads(reply.read().decode("utf-8"))


def oidc_token(vault):
    base = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    joiner = "&" if "?" in base else "?"
    reply = call(f"{base}{joiner}audience={vault}", {"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
    return reply["value"]


def wrapped_key(vault, role):
    login = call(vault + AUDIENCE_PATH, body={"role": LOGIN_ROLE, "jwt": oidc_token(vault)})
    client = login["auth"]["client_token"]
    try:
        reply = call(f"{vault}/v1/secret/data/fleet/{role}", {"X-Vault-Token": client, "X-Vault-Wrap-TTL": WRAP_TTL})
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise LookupError(f"Vault has no age key for the {role} role. Run `just setup` and apply the vault OpenTofu root.") from None
        raise
    token = (reply.get("wrap_info") or {}).get("token")
    decide.invariant(token, "Vault answered without a wrapped token", "Check the fleet-enroll policy's min_wrapping_ttl.")
    return token


def respond(title, body, vault):
    role, public = decide.parse_enroll_request(title, body)
    token = wrapped_key(vault, role)
    print("::add-mask::" + token)
    plain = json.dumps({"role": role, "token": token}).encode()
    return "fleet-sealed: " + decide.seal(plain, public)


def main():
    vault = (os.environ.get("VAULT_ADDR") or decide.VAULT_DEFAULT).rstrip("/")
    try:
        line = respond(os.environ.get("ISSUE_TITLE", ""), os.environ.get("ISSUE_BODY", ""), vault)
    except decide.Invariant as broken:
        line = f"fleet-error: {broken.what}. {broken.fix}"
    except LookupError as missing:
        line = f"fleet-error: {missing}"
    except (urllib.error.URLError, OSError, KeyError, ValueError) as exc:
        line = f"fleet-error: the approval workflow could not reach Vault ({type(exc).__name__}). Check the Vault service and the fleet-enroll JWT role, then run the installer again."
    Path(os.environ.get("RESULT_FILE", "result.txt")).write_text(line + "\n")
    print("fleet-enroll:", line.split(":", 1)[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
