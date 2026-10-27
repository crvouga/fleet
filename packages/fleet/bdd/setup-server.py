"""Real setup form/callback with a local GitHub stand-in that loses POST on login.

No GitHub API calls, App creation, credentials or disks are involved.
"""
import html
import json
import os
import socket
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import setup  # noqa: E402


class Handler(setup.Flow):
    def redirect(self, location):
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/confirm-access":
            return self.reply(200, b'<h1>Confirm access</h1><form method=post action=/authenticate><button>Confirm access</button></form>')
        if path == "/settings/apps/manifest":
            return self.reply(200, b"<h1>We didn't find an App Manifest for your request.</h1>")
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/authenticate":
            self.server.authenticated = True
            return self.redirect("/settings/apps/manifest")
        if parsed.path == "/settings/apps/new":
            form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode())
            if not self.server.authenticated:
                return self.redirect("/confirm-access")
            document = json.loads(form["manifest"][0])
            self.server.manifest = document
            self.server.state = parse_qs(parsed.query)["state"][0]
            return self.reply(200, (
                '<h1>Create GitHub App</h1><pre id=manifest>' + html.escape(json.dumps(document)) +
                '</pre><form method=post action=/approve-app><button>Create GitHub App</button></form>'
            ).encode())
        if parsed.path == "/approve-app":
            document = self.server.manifest
            return self.redirect(document["redirect_url"] + "?code=bdd-only-code&state=" + self.server.state)
        return self.reply(404, b"Not found")


if __name__ == "__main__":
    def no_reverse_dns(*args):
        raise OSError("BDD: reverse DNS is unavailable")

    socket.getfqdn = no_reverse_dns
    server = setup.LoopbackServer(("127.0.0.1", 0), Handler)
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    os.environ["FLEET_GITHUB_WEB"] = origin
    document = setup.manifest(origin + "/created", False)
    server.authenticated = False
    server.flow = {"state": "bdd-state", "code": None, "done": threading.Event(),
                   "page": setup.form_page("User", "crvouga", "bdd-state", document)}
    print(origin + "/", flush=True)
    server.serve_forever()
