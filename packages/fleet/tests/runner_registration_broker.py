#!/usr/bin/env python3
"""A fake fleet controller for the runner registration path (test only).

Used by tests/runner-registration.nix inside the NixOS VM, and by
tests/test_runner_registration_vm_static.py on a development machine, so that
what the VM test relies on is exercised against the real node scripts
(agent.py, runner_control.py) before CI ever boots a VM.

It speaks only what the node calls:

  POST /v1/nodes/register         the agent registers its id and secret
  POST /v1/heartbeat              the agent reports (Bearer <node id>.<secret>)
  POST /v1/runner-registration    runner_control.py asks for a registration token

Behaviour is switched by one word in a file, read on every request, so a test
can change it while the node keeps running:

  <state>/registration   ok (default) | unavailable | forbidden | notfound
  <state>/heartbeat      minimal (default) | future

  ok           200 with a fake token; one answer per idempotency key
  unavailable  503 github_unavailable with Retry-After: 1
  forbidden    403 runner_not_allowed (the controller's reason: runners_drained)
  notfound     404, a controller that predates the endpoint
  minimal      heartbeat answer with no desired document, credential or maintenance
  future       the same plus fields this node has never heard of

<state>/requests.jsonl records every request without any secret or token;
<state>/issued.jsonl records each token handed out (the tokens are fake).
Loopback only. Python standard library only.
"""
import argparse
import hashlib
import json
import os
import re
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HEX64 = re.compile(r"[0-9a-f]{64}")
BEARER = re.compile(r"Bearer ([0-9a-f]{64})\.([0-9a-f]{64})")
CHOSEN_TARGET = "acme/ci-fixture"
LOCK = threading.Lock()


class Broker:
    def __init__(self, state):
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True)
        self.secrets = {}
        self.answers = {}
        self.sequence = 0

    def word(self, name, default):
        try:
            value = (self.state / name).read_text().strip()
        except OSError:
            return default
        return value or default

    def append(self, name, record):
        with (self.state / name).open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, sort_keys=True) + "\n")

    def authenticate(self, header):
        """The node id when the credential matches what the node registered, else None."""
        match = BEARER.fullmatch(header or "")
        if match and self.secrets.get(match.group(1)) == match.group(2):
            return match.group(1)
        return None

    def token_for(self, node, slot, key):
        identity = (node, slot, key)
        if key and identity in self.answers:
            return self.answers[identity]
        self.sequence += 1
        digest = hashlib.sha256(f"{node}/{slot}/{self.sequence}".encode()).hexdigest()[:24]
        # Never starts with "gh": the upstream module would treat that as a PAT.
        token = f"FAKE-registration-{self.sequence:04d}-{digest}"
        self.answers[identity] = token
        self.append("issued.jsonl", {"slot": slot, "target": CHOSEN_TARGET, "token": token})
        return token


def handler_for(broker):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def reply(self, status, document, headers=None):
            data = json.dumps(document).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            length = min(int(self.headers.get("Content-Length") or 0), 1 << 20)
            try:
                document = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return {}
            return document if isinstance(document, dict) else {}

        def do_POST(self):
            document = self.body()
            with LOCK:
                self.route(document)

        def route(self, document):
            path = self.path.split("?", 1)[0]
            record = {"path": path}
            status, node = 404, None
            if path == "/v1/nodes/register":
                status, node = self.register(document, record)
            elif path == "/v1/heartbeat":
                status, node = self.heartbeat(document, record)
            elif path == "/v1/runner-registration":
                status, node = self.runner_registration(document, record)
            else:
                self.reply(404, {"error": "not_found"})
            record.update(status=status, node=node)
            broker.append("requests.jsonl", record)

        def register(self, document, record):
            node, secret = document.get("nodeId"), document.get("secret")
            if not (isinstance(node, str) and HEX64.fullmatch(node) and isinstance(secret, str) and HEX64.fullmatch(secret)):
                self.reply(400, {"error": "invalid_request"})
                return 400, None
            broker.secrets[node] = secret
            self.reply(200, {"status": "approved"})
            return 200, node

        def heartbeat(self, document, record):
            node = broker.authenticate(self.headers.get("Authorization"))
            if node is None:
                self.reply(401, {"error": "unauthorized"})
                return 401, None
            readiness = document.get("readiness")
            issues = readiness.get("issues") if isinstance(readiness, dict) else None
            record["readiness"] = issues if isinstance(issues, list) else None
            answer = {"status": "approved"}
            if broker.word("heartbeat", "minimal") == "future":
                answer.update({"futureFeature": {"enabled": True, "values": [1, 2, 3]}, "announcements": []})
            self.reply(200, answer)
            return 200, node

        def runner_registration(self, document, record):
            node = broker.authenticate(self.headers.get("Authorization"))
            slot, key = document.get("slot"), document.get("idempotencyKey")
            mode = broker.word("registration", "ok")
            record.update(slot=slot, key=key, mode=mode, repository="repository" in document)
            if node is None:
                self.reply(401, {"error": "unauthorized"})
                return 401, None
            if mode == "unavailable":
                self.reply(503, {"error": "github_unavailable", "code": "FLEET_GITHUB_UNAVAILABLE",
                                 "message": "GitHub is temporarily unavailable.", "retryAfterSeconds": 1},
                           {"Retry-After": "1"})
                return 503, node
            if mode == "forbidden":
                self.reply(403, {"error": "runner_not_allowed", "code": "runners_drained",
                                 "message": "Runner admission is closed for this node."})
                return 403, node
            if mode == "notfound":
                self.reply(404, {"error": "not_found"})
                return 404, node
            if not (isinstance(slot, str) and re.fullmatch(r"slot-[1-9][0-9]?", slot)):
                self.reply(400, {"error": "invalid_request"})
                return 400, node
            token = broker.token_for(node, slot, key)
            self.reply(200, {"token": token, "scope": "repository", "url": "https://github.com/" + CHOSEN_TARGET,
                             "target": CHOSEN_TARGET, "runnerGroup": None, "expiresAt": "2099-01-01T00:00:00.000Z"})
            return 200, node

    return Handler


def notify_ready():
    """Tell systemd (Type=notify) that the socket is listening, so units ordered after this one find it."""
    path = os.environ.get("NOTIFY_SOCKET")
    if not path:
        return
    if path.startswith("@"):
        path = "\0" + path[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notice:
        notice.connect(path)
        notice.sendall(b"READY=1")


def serve(state, port):
    broker = Broker(state)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(broker))
    server.daemon_threads = True
    return broker, server


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args(argv)
    _, server = serve(args.state, args.port)
    notify_ready()
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
