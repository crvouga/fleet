#!/usr/bin/env python3
"""Just enough Vault: sys/wrapping/lookup. Records every request path so the
proof can show the token was only looked up, never unwrapped."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKENS = {
    "hvs.GOODWEB": "secret/data/fleet/web",
    "hvs.GOODCI": "secret/data/fleet/ci",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        with open("/work/vault-requests.log", "a") as log:
            log.write(self.path + "\n")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        path = TOKENS.get(body.get("token"))
        if self.path != "/v1/sys/wrapping/lookup" or path is None:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"errors":["wrapping token is not valid or does not exist"]}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": {"creation_path": path, "creation_ttl": 3600}}).encode())


ThreadingHTTPServer(("127.0.0.1", 8200), Handler).serve_forever()
