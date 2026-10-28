"""A loopback stand-in for the part of GitHub's REST API the Fleet controller uses
(packages/fleet-controller/src/github/client.ts): App installation token,
runner lists, workflow runs and jobs, and registration tokens.

Plain HTTP on 127.0.0.1, never the real api.github.com. It checks what a real
GitHub would: the installation-token request must carry an RS256 App JWT that
verifies against the test public key (checked with `openssl`, so the test needs
no Python crypto package), and every other call must carry an installation token
this server issued. It records every request and can fail on demand.

Failure modes are switchable per endpoint class:

    github.fail("registration-token", 503)
    github.fail("registration-token", 429, headers={"Retry-After": "1"})
    github.fail("access-token", 401, times=1)
    github.fail("any", 503)
    github.clear()
"""
import base64
import json
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENDPOINTS = ("access-token", "registration-token", "any")


def generate_app_key(directory):
    """A throwaway 2048-bit RSA key pair made with `openssl`. Returns (private_pem_text, public_key_path)."""
    private = Path(directory) / "app-private.pem"
    public = Path(directory) / "app-public.pem"
    subprocess.run(["openssl", "genrsa", "-out", str(private), "2048"], check=True, capture_output=True)
    subprocess.run(["openssl", "rsa", "-in", str(private), "-pubout", "-out", str(public)], check=True, capture_output=True)
    return private.read_text(), public


def _b64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_app_jwt(token, public_key_path, app_id):
    """True when `token` is an RS256 JWT for `app_id` signed by the private half of `public_key_path`."""
    parts = token.split(".")
    if len(parts) != 3:
        return False
    try:
        header = json.loads(_b64url(parts[0]))
        claims = json.loads(_b64url(parts[1]))
        signature = _b64url(parts[2])
    except (ValueError, UnicodeDecodeError):
        return False
    if header.get("alg") != "RS256" or str(claims.get("iss")) != str(app_id):
        return False
    if not claims["exp"] > claims["iat"] or claims["exp"] - claims["iat"] > 600:
        return False
    with tempfile.TemporaryDirectory() as work:
        (Path(work) / "message").write_bytes((parts[0] + "." + parts[1]).encode())
        (Path(work) / "signature").write_bytes(signature)
        done = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(public_key_path), "-signature", str(Path(work) / "signature"),
             str(Path(work) / "message")],
            capture_output=True,
        )
    return done.returncode == 0


def _expires(seconds=3600):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + seconds))


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        return

    def _reply(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _classify(self, method, path):
        if method == "POST" and path.startswith("/app/installations/") and path.endswith("/access_tokens"):
            return "access-token"
        if method == "POST" and path.endswith("/actions/runners/registration-token"):
            return "registration-token"
        return "other"

    def _handle(self, method):
        github = self.server.owner
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        bearer = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        kind = self._classify(method, path)
        failure = github._failure(kind)
        github._record(method, path, kind, bearer, failure)
        if failure is not None:
            status, headers = failure
            return self._reply(status, {"message": "injected failure"}, headers)
        if kind == "access-token":
            return self._access_token(github, path, bearer)
        if bearer not in github.installation_tokens:
            return self._reply(401, {"message": "Bad credentials"})
        if kind == "registration-token":
            if github.registration_delay:
                time.sleep(github.registration_delay)
            return self._reply(201, {"token": github._next_registration_token(path), "expires_at": _expires()})
        return self._other(github, method, path)

    def _access_token(self, github, path, bearer):
        if path != f"/app/installations/{github.installation_id}/access_tokens":
            return self._reply(404, {"message": "Not Found"})
        if not verify_app_jwt(bearer, github.public_key_path, github.app_id):
            github.bad_jwts += 1
            return self._reply(401, {"message": "A JSON web token could not be decoded"})
        token = github._next_installation_token()
        return self._reply(201, {"token": token, "expires_at": _expires()})

    def _other(self, github, method, path):
        if method == "DELETE":
            return self._reply(200, {"labels": []})
        if path.endswith("/actions/runners"):
            return self._reply(200, {"total_count": 0, "runners": []})
        if "/actions/runs" in path and path.endswith("/jobs"):
            return self._reply(200, {"total_count": 0, "jobs": []})
        if path.endswith("/actions/runs"):
            return self._reply(200, {"total_count": 0, "workflow_runs": []})
        if path == "/installation/repositories":
            return self._reply(200, {"total_count": 0, "repositories": []})
        return self._reply(404, {"message": "Not Found"})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")


class FakeGitHubApp:
    """Records requests; `registration_delay` holds each registration-token reply so
    concurrent callers overlap."""

    def __init__(self, public_key_path, app_id="424242", installation_id="777"):
        self.public_key_path = public_key_path
        self.app_id = str(app_id)
        self.installation_id = str(installation_id)
        self.requests = []
        self.installation_tokens = set()
        self.registration_tokens = []
        self.registration_delay = 0.0
        self.bad_jwts = 0
        self._lock = threading.Lock()
        self._failures = {}
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.http.daemon_threads = True
        self.http.owner = self
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.http.server_address[1]}"

    def close(self):
        self.http.shutdown()
        self.http.server_close()

    def fail(self, endpoint, status, headers=None, times=None):
        """Answer `status` for every (or the next `times`) request of the endpoint class."""
        if endpoint not in ENDPOINTS:
            raise ValueError("endpoint must be one of " + ", ".join(ENDPOINTS))
        with self._lock:
            self._failures[endpoint] = [status, dict(headers or {}), times]

    def clear(self):
        with self._lock:
            self._failures.clear()
        self.registration_delay = 0.0

    def count(self, kind):
        with self._lock:
            return sum(1 for entry in self.requests if entry["kind"] == kind)

    def mark(self):
        """A position in the request log, for `since(mark)`."""
        with self._lock:
            return len(self.requests)

    def since(self, mark, kind=None):
        with self._lock:
            return [entry for entry in self.requests[mark:] if kind is None or entry["kind"] == kind]

    # -- called from handler threads -------------------------------------------

    def _failure(self, kind):
        with self._lock:
            for endpoint in (kind, "any"):
                found = self._failures.get(endpoint)
                if found is None:
                    continue
                status, headers, times = found
                if times is not None:
                    found[2] = times - 1
                    if found[2] <= 0:
                        del self._failures[endpoint]
                return status, headers
        return None

    def _record(self, method, path, kind, bearer, failure):
        with self._lock:
            self.requests.append({
                "method": method, "path": path, "kind": kind, "failed": failure[0] if failure else None,
                "bearer_is_jwt": bearer.count(".") == 2, "bearer_is_installation": bearer in self.installation_tokens,
            })

    def _next_installation_token(self):
        with self._lock:
            # A fixture label, not a credential: nothing real is ever issued here.
            issued = "ghs_FAKEINSTALLATION%04d" % (len(self.installation_tokens) + 1)  # ggignore
            self.installation_tokens.add(issued)
            return issued

    def _next_registration_token(self, path):
        with self._lock:
            # A fixture label, not a credential: nothing real is ever issued here.
            issued = "REGTOKEN-%04d-%s" % (len(self.registration_tokens) + 1, "-".join(path.split("/")[2:4]))  # ggignore
            self.registration_tokens.append(issued)
            return issued
