#!/usr/bin/env python3
"""One-time fleet setup, run by the repository owner on their own computer.

  python3 scripts/setup.py --repos owner/private-repo[,owner/other]

Creates what a new node cannot make for itself, and nothing a node can:

  1. a check that .sops.yaml names the recipients of secrets/fleet.yaml (render
     it with scripts/fleet-keys.py from your operator keys and the controller's
     GET /v1/recipients; nodes create their own age identities on first boot)
  2. the GitHub App that registers runners, from a manifest, so the only click is
     "Create GitHub App" and then "Install"
  3. secrets/fleet.yaml, the App's private key encrypted to those recipients
  4. settings/github.json: App ids, scope and bootstrap repositories; fleet.nix enables the secret

Every later node needs none of this: it downloads the installer and runs it.
Safe to run twice; a finished step is skipped. Secrets are never printed and
never written under a tracked path in plain text.
"""
import base64
import html
import json
import os
import re
import secrets
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
REPO = os.environ.get("FLEET_GITHUB_REPO", "")
OWNER = REPO.split("/")[0]


def api():
    return os.environ.get("FLEET_GITHUB_API", "https://api.github.com").rstrip("/")


def web():
    return os.environ.get("FLEET_GITHUB_WEB", "https://github.com").rstrip("/")


def say(message):
    print(message, file=sys.stderr)


def manifest(redirect_url, organization):
    permissions = {"administration": "write", "metadata": "read"}
    if organization:
        permissions["organization_self_hosted_runners"] = "write"
    return {
        "name": f"{OWNER} fleet runners",
        "url": f"https://github.com/{REPO}",
        "redirect_url": redirect_url,
        "public": False,
        "default_permissions": permissions,
    }


def form_page(owner_kind, owner, state, document):
    base = f"{web()}/organizations/{owner}/settings/apps/new" if owner_kind == "Organization" else f"{web()}/settings/apps/new"
    action = html.escape(f"{base}?state={state}", quote=True)
    value = html.escape(json.dumps(document), quote=True)
    return admin_page("Set up fleet runners", (
        "<p>Create a private GitHub App to register your fleet runners. "
        "GitHub opens in another tab; press <b>Create GitHub App</b> there.</p>"
        "<p>If GitHub asks you to sign in or confirm access, finish that first. "
        "If it then says it could not find an App Manifest, return to this tab "
        "and press the button again. Keep this page open until setup finishes.</p>"
        f'<form method=post action="{action}" target="_blank" rel="noopener noreferrer">'
        f'<input type=hidden name=manifest value="{value}">'
        '<button class=primary type=submit>Create runner GitHub App</button></form>'
    ))


def admin_page(title, body):
    css = (PACKAGE / "wizard" / "admin.css").read_text()
    script = (PACKAGE / "wizard" / "theme.js").read_text()
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(title)} · Fleet</title><style>{css}</style><script>{script}</script></head><body>'
        '<header class="admin-header"><div class="admin-brand"><span class="admin-mark">▤</span>'
        '<div>Fleet<div class="admin-subtitle">Setup console</div></div></div>'
        '<label class="admin-theme">Appearance <select id="admin-theme" aria-label="Color theme">'
        '<option value="light">Light</option><option value="dark">Dark</option><option value="auto">System</option></select></label></header>'
        f'<main class="admin-main"><div class="admin-intro"><h1>{html.escape(title)}</h1>'
        f'<p>Connect your trusted repositories to the fleet.</p></div><section class="admin-card">{body}</section></main></body></html>'
    ).encode()



class Flow(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def reply(self, code, body, kind="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        flow = self.server.flow
        parsed = urllib.parse.urlparse(self.path)
        if self.headers.get("Host", "") != f"127.0.0.1:{self.server.server_address[1]}":
            return self.reply(403, b"bad host")
        if parsed.path == "/":
            return self.reply(200, flow["page"])
        if parsed.path == "/created":
            query = urllib.parse.parse_qs(parsed.query)
            if query.get("state", [""])[0] != flow["state"] or not query.get("code", [""])[0]:
                return self.reply(400, b"This is not the page GitHub should send you to. Run setup again.")
            flow["code"] = query["code"][0]
            flow["done"].set()
            return self.reply(200, admin_page("Runner app created", "<p>The runner app was created. Now press <b>Install</b> on the GitHub page that opens next, choosing the repositories to run on.</p>"))
        return self.reply(404, b"not found")


def request(method, path, headers=None, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(api() + path, data=data, method=method,
                                 headers={"Accept": "application/vnd.github+json", "User-Agent": "fleet-setup", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as reply:
        return json.loads(reply.read().decode("utf-8") or "{}")


def owner_kind(owner):
    return request("GET", f"/users/{owner}").get("type", "User")


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # Loopback has no need for reverse DNS, which can stall macOS startup.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def create_app(owner, kind, wait):
    """Run the manifest flow. Returns the converted app: id, slug, pem."""
    state = secrets.token_urlsafe(16)
    server = LoopbackServer(("127.0.0.1", 0), Flow)
    port = server.server_address[1]
    document = manifest(f"http://127.0.0.1:{port}/created", kind == "Organization")
    server.flow = {"state": state, "code": None, "done": threading.Event(), "page": form_page(kind, owner, state, document)}
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    say("On the setup page, press 'Create runner GitHub App', then press 'Create GitHub App' on GitHub.")
    say(f"If no page opened, open this address in a browser on this computer: {url}")
    if not os.environ.get("FLEET_NO_BROWSER"):
        webbrowser.open(url)
    try:
        if not server.flow["done"].wait(wait):
            raise SystemExit("Next: the GitHub App was not created in time. Nothing was changed. Run setup again.")
        app = request("POST", f"/app-manifests/{server.flow['code']}/conversions")
    finally:
        server.shutdown()
        server.server_close()
    for field in ("id", "slug", "pem"):
        if not app.get(field):
            raise SystemExit(f"Next: GitHub's answer had no {field}. Run setup again.")
    return {"id": str(app["id"]), "slug": app["slug"], "pem": app["pem"]}


def app_jwt(app_id, pem):
    """RS256 with the openssl on this computer, so no Python package is needed."""
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()
    now = int(time.time())
    signing = part({"alg": "RS256", "typ": "JWT"}) + "." + part({"iat": now - 60, "exp": now + 540, "iss": str(app_id)})
    with tempfile.TemporaryDirectory() as scratch:
        key = Path(scratch) / "key.pem"
        fd = os.open(key, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(pem)
        signature = subprocess.run([os.environ.get("FLEET_OPENSSL", "openssl"), "dgst", "-sha256", "-sign", str(key)],
                                   input=signing.encode(), capture_output=True, check=True).stdout
    return signing + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()


def wait_for_installation(app, owner, wait, poll):
    url = f"{web()}/apps/{app['slug']}/installations/new"
    say("Install the runner app: choose ONLY the private repositories that may run on the fleet, then press Install.")
    say(f"If no page opened, open this address: {url}")
    if not os.environ.get("FLEET_NO_BROWSER"):
        webbrowser.open(url)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        try:
            found = request("GET", "/app/installations", {"Authorization": "Bearer " + app_jwt(app["id"], app["pem"])})
        except urllib.error.URLError:
            found = []
        for item in found:
            if (item.get("account") or {}).get("login", "").lower() == owner.lower():
                return str(item["id"])
        time.sleep(poll)
    raise SystemExit("Next: the app was not installed in time. Run setup again; the app is kept and will not be created twice.")


# ---- files -----------------------------------------------------------------------

def recipient_for(sops_text, name):
    """The comma-separated age recipients .sops.yaml assigns to secrets/<name>.yaml."""
    match = re.search(rf"path_regex:\s*secrets/{re.escape(name)}\\\.[^\n]*\n\s*age:\s*(age1[0-9a-z]+(?:,age1[0-9a-z]+)*)", sops_text)
    if not match:
        raise SystemExit(f"Next: .sops.yaml has no age recipients for secrets/{name}.yaml. Render it with scripts/fleet-keys.py "
                         "--operator <your age public key> (add the controller's GET /v1/recipients JSON when nodes exist) first.")
    return match.group(1)


def encrypt_app_key(pem, recipient, destination):
    body = "github-app-key: |\n" + "".join(f"  {line}\n" for line in pem.strip().splitlines())
    with tempfile.TemporaryDirectory() as scratch:
        plain = Path(scratch) / "plain.yaml"
        fd = os.open(plain, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(body)
        # sops reads the nearest .sops.yaml, which knows nothing about a temp file.
        config = Path(scratch) / "sops.yaml"
        config.write_text(f"creation_rules:\n  - path_regex: .*\n    age: {recipient}\n")
        done = subprocess.run([os.environ.get("FLEET_SOPS_BIN", "sops"), "--config", str(config), "--encrypt", "--age", recipient,
                               "--input-type", "yaml", "--output-type", "yaml", str(plain)], capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit("Next: sops could not encrypt the app key (" + done.stderr.strip()[-200:] + "). Install sops and run setup again.")
    if "PRIVATE KEY-----" in done.stdout:
        raise SystemExit("Next: sops output still holds the private key. Nothing was written.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(done.stdout)


def settings_text(text):
    """Enable the encrypted CI secret after it exists; registration data is JSON."""
    if "secretsFile = ./secrets/fleet.yaml;" in text:
        return text
    updated, count = re.subn(r'(\n  secretsFile = )null;', r'\g<1>./secrets/fleet.yaml;', text, count=1)
    if count != 1:
        raise SystemExit("Next: fleet.nix no longer has the line this setup edits (secretsFile). Restore the settings file before retrying.")
    return updated


def github_settings(current, app_id, installation_id, kind, owner, repositories):
    """Registration defaults live in one data file, never inserted into Nix code."""
    scope = "organization" if kind == "Organization" else "repository"
    return {**current, "scope": scope, "organization": owner if scope == "organization" else "",
            "repositories": list(repositories) if scope == "repository" else [],
            "appId": str(app_id), "installationId": str(installation_id)}


def parse(argv):
    repos, rest = [], list(argv)
    while rest:
        item = rest.pop(0)
        if item == "--repos":
            repos = [r for r in (rest.pop(0) if rest else "").split(",") if r]
        elif item.startswith("--repos="):
            repos = [r for r in item.split("=", 1)[1].split(",") if r]
        else:
            raise SystemExit(f"Next: unknown argument {item}. Usage: setup.py --repos owner/private-repo[,owner/other]")
    return repos


def main(argv):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", REPO):
        raise SystemExit("Set FLEET_GITHUB_REPO=owner/repository to your Fleet deployment repository before setup.")
    package = Path(os.environ.get("FLEET_PACKAGE") or PACKAGE)
    state = Path(os.environ.get("FLEET_SETUP_STATE") or Path.home() / ".fleet" / "setup-github-app.json")
    wait = int(os.environ.get("FLEET_SETUP_WAIT") or 900)
    poll = float(os.environ.get("FLEET_SETUP_POLL") or 3)
    settings = package / "fleet.nix"
    current = settings.read_text()
    registration = package / "settings" / "github.json"
    github = json.loads(registration.read_text())
    configured = all(re.fullmatch(r"[0-9]+", str(github.get(key, ""))) for key in ("appId", "installationId"))
    repositories = parse(argv) or list(github.get("repositories") or [])
    kind = owner_kind(OWNER)
    if kind != "Organization" and not repositories and not configured:
        raise SystemExit("Next: say which private repositories may use the fleet: setup.py --repos owner/private-repo[,owner/other]. "
                         "Repositories are never guessed; a public one would let strangers' pull requests run on your machines.")
    for name in repositories:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
            raise SystemExit(f"Next: {name} is not owner/name.")

    say("1/4 SOPS recipients")
    if configured:
        recipients = None
        say("    secrets/fleet.yaml already exists; re-encrypt it with `sops updatekeys` when recipients change.")
    else:
        sops_config = package / ".sops.yaml"
        recipients = recipient_for(sops_config.read_text() if sops_config.is_file() else "", "fleet")
        say(f"    secrets/fleet.yaml will be encrypted to {len(recipients.split(','))} recipient(s) from .sops.yaml")

    if configured and not (package / "secrets" / "fleet.yaml").is_file():
        raise SystemExit("Next: settings/github.json already names a GitHub App but secrets/fleet.yaml is missing. Restore the file from git. "
                         "If the App's key is lost, delete the App on GitHub and set appId and installationId in settings/github.json back to \"TODO\" before running setup again.")
    if configured:
        say("2/4 GitHub App: already set up (appId and installationId are in settings/github.json).")
        say("3/4 secrets/fleet.yaml: already encrypted.")
        say("4/4 settings/github.json: already filled in.")
    else:
        say("2/4 GitHub App")
        if state.is_file():
            app = json.loads(state.read_text())
            say("    resuming with the app created earlier")
        else:
            app = create_app(OWNER, kind, wait)
            state.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(state, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(app, handle)
        installation = wait_for_installation(app, OWNER, wait, poll)
        say("3/4 secrets/fleet.yaml")
        encrypt_app_key(app["pem"], recipients, package / "secrets" / "fleet.yaml")
        say("4/4 settings/github.json")
        updated = github_settings(github, app["id"], installation, kind, OWNER, repositories)
        registration.write_text(json.dumps(updated, indent=2) + "\n")
        settings.write_text(settings_text(current))
        state.unlink(missing_ok=True)
    say("")
    say("Setup is done on this computer. Two reviewed steps remain, once, and no node ever repeats them:")
    say("  1. Commit packages/fleet (settings/github.json, fleet.nix, secrets/fleet.yaml, .sops.yaml) in a pull request and merge it.")
    say("  2. When Fleet assigns nodes a role, render .sops.yaml again with scripts/fleet-keys.py and run `sops updatekeys` on that role's file.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
