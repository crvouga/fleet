"""Local stand-ins for the two services node enrollment talks to: GitHub's
issues API (what the node polls) and Vault plus the Actions OIDC endpoint (what
the approval workflow calls). Plain HTTP servers on loopback, no stubs on PATH."""
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

REPO = "crvouga/fleet"


class _Server:
    def __init__(self, handler):
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.http.owner = self
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.http.server_address[1]}"

    def close(self):
        self.http.shutdown()
        self.http.server_close()


class _GitHubHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_GET(self):
        owner = self.server.owner
        path = urlparse(self.path).path
        owner.requests.append(self.path)
        if path == f"/repos/{REPO}/issues":
            payload = list(reversed(owner.issues))
        elif path.startswith(f"/repos/{REPO}/issues/") and path.endswith("/comments"):
            payload = owner.comments.get(int(path.split("/")[-2]), [])
        else:
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(payload).encode()
        etag = '"' + hashlib.md5(body).hexdigest() + '"'
        if self.headers.get("If-None-Match") == etag:
            owner.not_modified += 1
            self.send_response(304)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("ETag", etag)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FakeGitHub(_Server):
    def __init__(self):
        self.issues, self.comments, self.requests, self.not_modified = [], {}, [], 0
        super().__init__(_GitHubHandler)

    def open_issue(self, title, body, pull_request=False):
        number = len(self.issues) + 1
        issue = {"number": number, "title": title, "body": body, "user": {"login": "owner"}}
        if pull_request:
            issue["pull_request"] = {}
        self.issues.append(issue)
        return number

    def comment(self, number, body, login="github-actions[bot]"):
        self.comments.setdefault(number, []).append({"body": body, "user": {"login": login}})


class _VaultHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        owner = self.server.owner
        parsed = urlparse(self.path)
        if parsed.path == "/oidc":
            owner.audiences.append(parse_qs(parsed.query).get("audience", [""])[0])
            if self.headers.get("Authorization") != "bearer request-token":
                return self._json(401, {})
            return self._json(200, {"value": "github-oidc-jwt"})
        if parsed.path.startswith("/v1/secret/data/fleet/"):
            role = parsed.path.rsplit("/", 1)[1]
            if self.headers.get("X-Vault-Token") != "client-token":
                return self._json(403, {})
            if role not in owner.keys:
                return self._json(404, {"errors": []})
            owner.reads.append({"role": role, "wrap": self.headers.get("X-Vault-Wrap-TTL")})
            if not self.headers.get("X-Vault-Wrap-TTL"):
                # What the real policy forbids. If the workflow ever asks like
                # this, the test sees the raw key and fails.
                return self._json(200, {"data": {"data": {"age_key": owner.keys[role]}}})
            return self._json(200, {"wrap_info": {"token": f"hvs.wrapped-{role}-0001", "ttl": 3600}})
        return self._json(404, {})

    def do_POST(self):
        owner = self.server.owner
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/v1/auth/jwt/login":
            owner.logins.append(body)
            if body.get("role") != "fleet-enroll" or body.get("jwt") != "github-oidc-jwt":
                return self._json(403, {})
            return self._json(200, {"auth": {"client_token": "client-token"}})
        return self._json(404, {})


class FakeVault(_Server):
    def __init__(self, keys=None):
        self.keys = keys if keys is not None else {"ci": "AGE-SECRET-KEY-1TESTONLYNOTREAL"}
        self.audiences, self.logins, self.reads = [], [], []
        super().__init__(_VaultHandler)
