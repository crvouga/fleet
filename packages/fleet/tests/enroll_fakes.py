"""A local stand-in for GitHub's issues API, a negative control: node
enrollment uses the Fleet controller and must never contact it. A plain HTTP
server on loopback, no stubs on PATH."""
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

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
