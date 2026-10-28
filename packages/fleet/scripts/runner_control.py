"""Root-only runner operations; never log credentials or API response bodies.

The filename must not be token.py: that shadows Python's standard token module.

GitHub access belongs to the fleet controller. `register` asks the controller
(POST /v1/runner-registration, with this node's own credential) for a short-lived
registration token, so the GitHub App private key never has to be on a node.
A node that still holds the legacy App key file keeps registering directly with
GitHub, as before; every other mode (status, hold, withdraw, drain) still needs
that legacy key and degrades without it (the controller removes orphaned runners
and the routing labels of drained nodes itself).
"""
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
import jwt

# runners.nix passes this target when no repository is configured on the machine:
# the controller chooses one. It never names a real repository.
PLACEHOLDER_TARGET = "fleet-controller/unassigned"
CONTROLLER_ATTEMPTS = 3
CONTROLLER_MAX_WAIT = 10
SLOT = re.compile(r"^slot-[1-9][0-9]?$")
PUBLIC_CODE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,60}$")
TARGET = re.compile(r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)?$")


class GitHubUnavailable(RuntimeError):
    """Temporary transport, throttling, or server failure; no private body."""

    retry_after = None


class Refused(RuntimeError):
    """A permanent answer: a person has to change a key, an App installation or a
    setting. The code and message are public; they never quote a response body."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def refusal(status, path):
    """What a GitHub refusal means, from its status and the kind of request."""
    if path.startswith("/app/installations/"):
        if status == 401:
            return Refused("FLEET_GITHUB_KEY", "GitHub refused the App credential (HTTP 401): the App ID or private key is wrong, or the key was revoked")
        if status == 404:
            return Refused("FLEET_GITHUB_SCOPE", "GitHub does not know this App installation (HTTP 404): the installation ID is wrong or the App was uninstalled")
    if status == 404:
        return Refused("FLEET_GITHUB_SCOPE", "GitHub answered HTTP 404 for the runner target: the App installation cannot reach this repository or organization")
    if status == 403:
        return Refused("FLEET_GITHUB_SCOPE", "GitHub refused with HTTP 403: the App lacks the runner permission (repository Administration, or organization Self-hosted runners)")
    if status == 401:
        return Refused("FLEET_GITHUB_KEY", "GitHub refused the installation token (HTTP 401)")
    return Refused("FLEET_GITHUB_REGISTRATION", "GitHub refused the request with HTTP " + str(status))


def request(method, path, token, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request("https://api.github.com" + path, data=body, method=method,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "workspace-ci-fleet"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return None if response.status == 204 else json.load(response)
    except urllib.error.HTTPError as error:
        throttled = error.code == 403 and (error.headers.get('Retry-After') or error.headers.get('X-RateLimit-Remaining') == '0')
        if error.code in (408, 429) or error.code >= 500 or throttled:
            raise GitHubUnavailable('GitHub is temporarily unavailable') from None
        raise refusal(error.code, path) from None
    except (urllib.error.URLError, OSError):
        raise GitHubUnavailable('GitHub could not be reached') from None


def app_token(app, installation, key_path):
    try:
        with open(key_path, encoding="utf-8") as key:
            material = key.read()
    except FileNotFoundError:
        raise Refused("FLEET_SECRET_MISSING", "the GitHub App key file is missing: this node's role secrets were not "
                      "decrypted (sops-install-secrets), usually because its age key cannot decrypt them") from None
    now = int(time.time())
    try:
        signed = jwt.encode({"iat": now - 60, "exp": now + 540, "iss": str(app)}, material, algorithm="RS256")
    except Exception:
        raise Refused("FLEET_GITHUB_KEY", "the GitHub App key is not a usable RSA private key") from None
    finally:
        material = None
    return request("POST", "/app/installations/" + str(installation) + "/access_tokens", signed)["token"]


def matching_runners(host, runners):
    return [runner for runner in runners if runner["name"].startswith(host + "-") or runner["name"] == host]


def delete_custom_labels(prefix, access, runners):
    # Remove routing labels so new work cannot be assigned. Do not delete the runner.
    defaults = {"self-hosted", "linux", "x64"}
    for runner in runners:
        labels = [label["name"] for label in runner.get("labels", []) if label["name"].lower() not in defaults]
        for label in labels:
            request("DELETE", prefix + "/" + str(runner["id"]) + "/labels/" + urllib.parse.quote(label, safe=""), access)


def list_runners(scope, target, access):
    endpoint = ("/orgs/" if scope == "organization" else "/repos/") + target + "/actions/runners"
    result = []
    page = 1
    while True:
        response = request("GET", endpoint + "?per_page=100&page=" + str(page), access)
        result.extend(response["runners"])
        if len(response["runners"]) < 100:
            return result
        page += 1



def read_kv(path):
    values = {}
    try:
        with open(path, encoding="utf-8") as stream:
            for line in stream:
                key, separator, value = line.rstrip("\n").partition("=")
                if separator:
                    values[key] = value
    except OSError:
        pass
    return values


def public_text(value, limit=240):
    """Controller text for a log line: printable ASCII only, bounded."""
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value if " " <= c <= "~")[:limit]


def controller_base(url):
    value = (url or "").strip()
    if not value or "TODO" in value:
        raise Refused("FLEET_CONTROLLER_UNCONFIGURED", "this node has no fleet controller address (settings.fleetApi.url) "
                      "and no local GitHub App key, so it cannot obtain a runner registration token")
    parsed = urllib.parse.urlparse(value)
    loopback = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    secure = parsed.scheme == "https" or (parsed.scheme == "http" and loopback)
    if not secure or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise Refused("FLEET_CONTROLLER_UNCONFIGURED", "FLEET_API_URL must be a plain https URL (http only for the loopback address)")
    return value.rstrip("/")


def node_credential():
    """`<node id>.<secret>`: the node's own credential, the one fleet-agent heartbeats with."""
    run = os.environ.get("FLEET_RUN") or "/run/fleet"
    state = os.environ.get("FLEET_AGENT_STATE") or "/nix/fleet-state/agent"
    node_id = read_kv(os.path.join(run, "node")).get("machine_id", "")
    try:
        with open(os.path.join(state, "node.secret"), encoding="utf-8") as stream:
            secret = stream.read().strip()
    except OSError:
        secret = ""
    if not re.fullmatch(r"[0-9a-f]{64}", node_id) or not re.fullmatch(r"[0-9a-f]{64}", secret):
        raise Refused("FLEET_NODE_CREDENTIAL_MISSING", "this node has no registered identity yet (node id or node.secret is missing); "
                      "the fleet agent creates it when the node first reports to the controller")
    return node_id + "." + secret


def controller_error(status, body, retry_after):
    """Map the controller's answer to the exit-code classes. Only its public fields are used."""
    document = body if isinstance(body, dict) else {}
    code = document.get("code") if isinstance(document.get("code"), str) else ""
    message = public_text(document.get("message"))
    if status in (408, 429) or status >= 500:
        error = GitHubUnavailable("the fleet controller or GitHub is temporarily unavailable")
        error.retry_after = retry_after
        return error
    if status == 401:
        return Refused("FLEET_CONTROLLER_AUTH", "the fleet controller does not accept this node's credential; the node must register again")
    if status == 403 and document.get("error") in ("rejected", "retired"):
        return Refused("FLEET_CONTROLLER_AUTH", "the fleet controller refused this node (" + str(document.get("error")) + ")")
    if not PUBLIC_CODE.fullmatch(code):
        code = "FLEET_GITHUB_REGISTRATION" if status == 422 else "FLEET_RUNNER_NOT_ALLOWED"
    return Refused(code, message or "the fleet controller refused the registration (HTTP " + str(status) + ")")


def controller_request(base, credential, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(base + "/v1/runner-registration", data=body, method="POST",
        headers={"Authorization": "Bearer " + credential, "Content-Type": "application/json",
                 "Accept": "application/json", "User-Agent": "fleet-runner-control"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read(65536).decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        try:
            document = json.loads(error.read(65536).decode("utf-8", "replace"))
        except (ValueError, OSError):
            document = None
        retry = error.headers.get("Retry-After") if error.headers else None
        raise controller_error(error.code, document, int(retry) if retry and retry.isdigit() else None) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise GitHubUnavailable("the fleet controller could not be reached") from None


def write_secret_file(path, text):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(text)
    os.replace(path + ".new", path)


def write_public_file(path, text):
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    with open(path + ".new", "w", encoding="utf-8") as stream:
        stream.write(text + "\n")
    os.chmod(path + ".new", 0o644)
    os.replace(path + ".new", path)


def register_with_controller(scope, target, output):
    """Obtain the slot's registration token from the controller and store it (0600).

    The same idempotency key is sent on every retry of this attempt, so the
    controller replays one token instead of minting several. The token is never
    printed or logged. The repository (or organization) the controller chose is
    recorded for the Runner.Listener wrapper (FLEET_ASSIGN_USED_FILE)."""
    base = controller_base(os.environ.get("FLEET_API_URL"))
    credential = node_credential()
    slot = os.environ.get("FLEET_SLOT", "")
    if not SLOT.fullmatch(slot):
        raise Refused("FLEET_CONTROLLER_UNCONFIGURED", "FLEET_SLOT is not set to slot-N for this registration")
    payload = {"slot": slot, "idempotencyKey": secrets.token_hex(12)}
    if scope == "repository" and target != PLACEHOLDER_TARGET and "/" in target:
        payload["repository"] = target
    for attempt in range(1, CONTROLLER_ATTEMPTS + 1):
        try:
            grant = controller_request(base, credential, payload)
            break
        except GitHubUnavailable as error:
            if attempt == CONTROLLER_ATTEMPTS:
                raise
            time.sleep(min(CONTROLLER_MAX_WAIT, getattr(error, "retry_after", None) or 2 * attempt))
    token = grant.get("token") if isinstance(grant, dict) else None
    chosen = grant.get("target") if isinstance(grant, dict) else None
    if not isinstance(token, str) or not 8 <= len(token) <= 512 or not isinstance(chosen, str) or not TARGET.fullmatch(chosen):
        raise GitHubUnavailable("the fleet controller sent an unusable registration answer")
    write_secret_file(output, token)
    used = os.environ.get("FLEET_ASSIGN_USED_FILE")
    if used:
        write_public_file(used, chosen)
    group = os.environ.get("FLEET_ASSIGN_GROUP_FILE")
    if group:
        name = grant.get("runnerGroup")
        if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9 _.-]{1,64}", name):
            write_public_file(group, name)
        elif os.path.exists(group):
            os.unlink(group)


def controller_configured():
    value = (os.environ.get("FLEET_API_URL") or "").strip()
    return bool(value) and "TODO" not in value


def legacy_key_present(app, installation, key_path):
    """A node that still holds the GitHub App key registers directly, as it always did."""
    try:
        return app.isdigit() and installation.isdigit() and os.path.getsize(key_path) > 0
    except OSError:
        return False


def main():
    mode, scope, target, app, installation, key_path, *args = sys.argv[1:]
    if scope not in ("organization", "repository"):
        raise ValueError("invalid GitHub runner scope")
    if mode == "register" and controller_configured() and not legacy_key_present(app, installation, key_path):
        if len(args) != 1:
            raise ValueError("registration output path is required")
        register_with_controller(scope, target, args[0])
        return
    if not app.isdigit() or not installation.isdigit() or "TODO" in target:
        raise Refused("FLEET_GITHUB_UNCONFIGURED", "the GitHub App ID, installation ID or runner target is not configured on this node, "
                      "and it has no fleet controller address to obtain registration tokens from (settings.fleetApi.url)")
    access = app_token(app, installation, key_path)
    prefix = ("/orgs/" if scope == "organization" else "/repos/") + target + "/actions/runners"
    if mode == "status":
        if len(args) != 1:
            raise ValueError("runner status requires the node hostname")
        runners = matching_runners(args[0], list_runners(scope, target, access))
        slots = {args[0] + "-slot-" + str(slot) for slot in range(1, 65)}
        online_names = sorted({r["name"] for r in runners if r.get("status") == "online" and r["name"] in slots})
        print(json.dumps({"registered": len(runners), "online": sum(r.get("status") == "online" for r in runners),
                          "onlineNames": online_names}))
        return
    if mode == "register":
        if len(args) != 1:
            raise ValueError("registration output path is required")
        output = args[0]
        registration = request("POST", prefix + "/registration-token", access)["token"]
        os.makedirs(os.path.dirname(output), mode=0o700, exist_ok=True)
        fd = os.open(output + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(registration)
        os.replace(output + ".new", output)
        return
    if mode in ("hold", "withdraw"):
        if len(args) != 1:
            raise ValueError("usage: runner-control hold|withdraw SCOPE TARGET APP INSTALL KEY HOST")
        host = args[0]
        runners = matching_runners(host, list_runners(scope, target, access))
        if mode == "hold":
            delete_custom_labels(prefix, access, runners)
            return
        if any(runner.get("busy") for runner in runners):
            delete_custom_labels(prefix, access, runners)
            print("A job is still running. Runners were not deleted.", file=sys.stderr)
            sys.exit(4)
        for runner in runners:
            request("DELETE", prefix + "/" + str(runner["id"]), access)
        return
    if mode != "drain" or len(args) != 2:
        raise ValueError("usage: runner-control drain SCOPE TARGET APP INSTALL KEY HOST TIMEOUT")
    host, timeout_text = args
    timeout = int(timeout_text)
    deadline = time.monotonic() + timeout
    runners = [r for r in list_runners(scope, target, access) if r["name"].startswith(host + "-") or r["name"] == host]
    if not runners:
        sys.exit(3)  # This repository may have no slot due to round-robin placement.
    # Remove every non-default routing label so project workflows cannot assign new jobs.
    defaults = {"self-hosted", "linux", "x64"}
    for runner in runners:
        labels = [label["name"] for label in runner.get("labels", []) if label["name"].lower() not in defaults]
        for label in labels:
            request("DELETE", prefix + "/" + str(runner["id"]) + "/labels/" + urllib.parse.quote(label, safe=""), access)
    refreshed = time.monotonic()
    while True:
        if time.monotonic() - refreshed > 2700:
            access = app_token(app, installation, key_path)
            refreshed = time.monotonic()
        current = [r for r in list_runners(scope, target, access) if r["name"].startswith(host + "-") or r["name"] == host]
        if not current or all(not r.get("busy", False) for r in current):
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("drain timed out; labels remain removed, no jobs were stopped")
        time.sleep(5)


def record(code, message, status):
    """The last registration outcome for this slot, for the node's console and
    readiness (FLEET_REGISTER_STATUS). Public text only."""
    path = os.environ.get("FLEET_REGISTER_STATUS")
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        with open(path + ".new", "w", encoding="utf-8") as stream:
            json.dump({"code": code, "message": message, "exit": status, "at": int(time.time())}, stream)
        os.chmod(path + ".new", 0o644)
        os.replace(path + ".new", path)
    except OSError:
        pass


def run():
    """Exit 0 done, 75 temporary (retry), 78 refused (a person must change something), 1 unexpected."""
    try:
        main()
    except GitHubUnavailable as error:
        message = str(error) + "; retrying after connectivity or throttling recovers"
        print("FLEET_GITHUB_UNAVAILABLE: " + message, file=sys.stderr)
        record("FLEET_GITHUB_UNAVAILABLE", message, 75)
        return 75
    except Refused as error:
        print(error.code + ": " + str(error), file=sys.stderr)
        if sys.argv[1:2] == ["status"]:
            # Readiness reads stdout only: say what was refused there too.
            print(json.dumps({"code": error.code, "message": str(error)}))
        record(error.code, str(error), 78)
        return 78
    except Exception as error:
        message = "unexpected " + type(error).__name__ + "; the cause is not known from this program"
        print("FLEET_GITHUB_OPERATION_FAILED: " + message, file=sys.stderr)
        record("FLEET_GITHUB_OPERATION_FAILED", message, 1)
        return 1
    record("ok", "registered", 0)
    return 0


if __name__ == "__main__":
    sys.exit(run())
