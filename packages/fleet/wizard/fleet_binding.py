"""The installer's binding to the controller that issued it.

The Fleet app hands out `fleet-bind.json` next to the installer download: the
issuing controller's origin, a single-use expiring enrollment grant and an
HMAC-SHA256 signature only that controller can check. This module finds the
file, validates it offline (shape, https origin, not expired) and, at review
time, asks the controller to validate it read-only (`POST /v1/enrollment/check`)
so a person never copies a token. Nothing here weakens TLS: the controller is
reached with the same verified context as every other download, redirects are
refused so the grant can only ever travel to the bound origin, and a binding
whose origin differs from the controller the installer is set to use is refused.

The grant is a credential until it is used, expires or is revoked: it is never
logged, returned by the wizard's API or put in arguments.
"""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import fleet_tls

BINDING_FILE = "fleet-bind.json"
MAX_BYTES = 4096
FIELD = re.compile(r"[\x21-\x7e]{1,600}")
SIG = re.compile(r"[0-9a-f]{64}")
GRANT = re.compile(r"[A-Za-z0-9._-]{8,512}")
FIELDS = ("origin", "grant", "grantId", "issuedAt", "expiresAt", "keyId", "sig")
LOOPBACK = ("127.0.0.1", "localhost", "::1")


class BindingError(Exception):
    """A binding that must not be used. `fix` says what the person does next."""

    def __init__(self, code, message, fix):
        super().__init__(message)
        self.code, self.message, self.fix = code, message, fix


def parse_time(value):
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    moment = datetime.datetime.fromisoformat(text)
    return moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)


def normal_origin(value):
    """`https://host[:port]` (or loopback http for local testing) with nothing else, else None."""
    parsed = urllib.parse.urlsplit(str(value).strip())
    loopback = parsed.scheme == "http" and parsed.hostname in LOOPBACK
    if not (parsed.scheme == "https" or loopback) or not parsed.hostname or parsed.username or parsed.password:
        return None
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return None
    return f"{parsed.scheme}://{parsed.netloc.lower()}"


def parse(raw):
    """A well-formed binding from file bytes. Raises BindingError; never returns a partial one."""
    fix = "Download a new installer binding (fleet-bind.json) from Add node in your Fleet app."
    try:
        if len(raw) > MAX_BYTES:
            raise ValueError("too large")
        document = json.loads(raw.decode("utf-8"))
        if not isinstance(document, dict) or document.get("v") != 1:
            raise ValueError("unsupported version")
        binding = {}
        for key in FIELDS:
            value = document.get(key)
            if not isinstance(value, str) or not FIELD.fullmatch(value):
                raise ValueError(f"bad {key}")
            binding[key] = value
        if not SIG.fullmatch(binding["sig"]) or not GRANT.fullmatch(binding["grant"]):
            raise ValueError("bad signature or grant")
        if normal_origin(binding["origin"]) != binding["origin"]:
            raise ValueError("bad origin")
        issued, expires = parse_time(binding["issuedAt"]), parse_time(binding["expiresAt"])
        if expires <= issued:
            raise ValueError("bad validity")
    except (ValueError, UnicodeError) as exc:
        raise BindingError("invalid", f"the installer binding file is not valid ({exc})", fix) from None
    binding["v"] = 1
    return binding


def check_fresh(binding, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if parse_time(binding["expiresAt"]) <= now:
        raise BindingError("expired", "the installer binding has expired",
                           "Create a new installer binding under Add node in your Fleet app and download fleet-bind.json again.")


def candidate_dirs(environ=None):
    """Next to the program first, then where a browser saved it."""
    environ = os.environ if environ is None else environ
    found = []
    here = Path(sys.executable if getattr(sys, "frozen", False) else sys.argv[0] or ".").resolve().parent
    # A macOS app keeps its program three folders deep; the person unzipped beside the .app.
    found.append(here)
    for parent in list(here.parents)[:4]:
        if parent.suffix == ".app":
            found.append(parent.parent)
    found.append(Path.cwd())
    home = Path(environ.get("HOME") or environ.get("USERPROFILE") or "~").expanduser()
    found.append(Path(environ.get("XDG_DOWNLOAD_DIR") or home / "Downloads"))
    return list(dict.fromkeys(found))


def candidate_files(environ=None):
    environ = os.environ if environ is None else environ
    explicit = environ.get("FLEET_BINDING_FILE")
    if explicit:
        return [Path(explicit)]
    files = []
    for directory in candidate_dirs(environ):
        try:
            names = sorted(directory.iterdir(), key=lambda entry: entry.stat().st_mtime, reverse=True)
        except OSError:
            continue
        # A browser renames repeat downloads "fleet-bind (1).json".
        files += [entry for entry in names if re.fullmatch(r"fleet-bind(?: \(\d+\))?\.json", entry.name)]
    return files


def read(path):
    with open(path, "rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    return parse(raw)


def find(now=None, environ=None):
    """The binding this installer uses: {"state": none|ok|expired|invalid, ...}. Never raises.

    The newest valid, unexpired file wins; when only bad ones exist the state names the first
    so the person is told why it was not used."""
    problem = None
    for path in candidate_files(environ):
        try:
            if not path.is_file():
                continue
            binding = read(path)
            check_fresh(binding, now)
            return {"state": "ok", "binding": binding, "path": str(path)}
        except BindingError as exc:
            problem = problem or {"state": exc.code, "binding": None, "path": str(path), "detail": exc.message, "fix": exc.fix}
        except OSError:
            continue
    return problem or {"state": "none", "binding": None, "path": None}


def public(found, configured=None):
    """What the wizard's API may show: the origin and expiry, never the grant, signature or file contents."""
    binding = found.get("binding")
    mismatch = binding is not None and configured is not None and normal_origin(configured) != binding["origin"]
    state = "mismatch" if mismatch else found["state"]
    shown = {"state": state, "path_name": Path(found["path"]).name if found.get("path") else None}
    if binding is not None:
        shown.update(origin=binding["origin"], expires_at=binding["expiresAt"])
    if mismatch:
        shown.update(detail=f"This installer is bound to {binding['origin']}, but this computer is set to use {normal_origin(configured)}.",
                     fix=f"Use the installer from {binding['origin']}, or remove the fleet-bind.json file and download an installer from the Fleet app you mean to use.")
    elif found.get("detail"):
        shown.update(detail=found["detail"], fix=found.get("fix", ""))
    return shown


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def check_controller(binding, timeout=15, opener=None):
    """Ask the bound controller whether the grant is usable, without consuming it.

    Returns {"state": "ok"|"used"|"unreachable", "role": str|None, "approval": "automatic"|"manual"} or raises
    BindingError for a grant the controller refuses. The grant is only ever sent to binding["origin"], over
    verified TLS, and a redirect is refused."""
    request = urllib.request.Request(
        binding["origin"] + "/v1/enrollment/check",
        data=json.dumps({"enrollmentToken": binding["grant"], "binding": {**{key: binding[key] for key in FIELDS}, "v": 1}}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    opener = opener or urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=fleet_tls.context()))
    try:
        with opener.open(request, timeout=timeout) as reply:
            document = json.loads(reply.read(4097))
    except urllib.error.HTTPError as error:
        return refused(error)
    except (urllib.error.URLError, OSError, ValueError):
        return {"state": "unreachable", "role": None, "approval": "manual"}
    if not isinstance(document, dict) or document.get("ok") is not True or document.get("kind") != "grant":
        return {"state": "unreachable", "role": None, "approval": "manual"}
    return {"state": "used" if document.get("state") == "used" else "ok", "role": document.get("role"),
            "approval": "automatic" if document.get("approval") == "automatic" else "manual"}


REFUSALS = {
    "enrollment_grant_expired": ("expired", "the installer binding has expired",
                                 "Create a new installer binding under Add node in your Fleet app and download fleet-bind.json again."),
    "enrollment_grant_revoked": ("revoked", "the installer binding was revoked in the Fleet app",
                                 "Create a new installer binding under Add node in your Fleet app."),
    "enrollment_binding_invalid": ("rejected", "the Fleet app did not issue this binding or it was modified",
                                   "Download a new installer binding from Add node in your Fleet app. Do not edit fleet-bind.json."),
    "enrollment_not_ready": ("rejected", "the Fleet app does not recognise this installer binding",
                             "Download a new installer binding from Add node in the Fleet app this installer came from."),
}


def refused(error):
    try:
        code = json.loads(error.read(4097)).get("error")
    except (ValueError, OSError, AttributeError):
        code = None
    if error.code in (401, 400) and code in REFUSALS:
        state, message, fix = REFUSALS[code]
        raise BindingError(state, message, fix)
    # A 404 is an older controller and a 5xx an outage: registration and approval still decide.
    return {"state": "unreachable", "role": None, "approval": "manual"}
