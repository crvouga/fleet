#!/usr/bin/env python3
"""The owner's one-time setup: role keys, the runner GitHub App (manifest flow),
the encrypted CI secret, fleet.nix. GitHub is a local fake; the browser click is
played by a thread that follows the same redirects."""

import base64
import html
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fleet_setup", ROOT / "scripts" / "setup.py")
setup = importlib.util.module_from_spec(spec)
sys.modules["fleet_setup"] = setup
spec.loader.exec_module(setup)

OPENSSL = shutil.which("openssl")
KEY_ID = "123456"


def make_pem():
    return subprocess.run([OPENSSL, "genrsa", "2048"], capture_output=True, text=True, check=True).stdout


class FakeGitHub:
    """api.github.com, plus the two github.com pages the owner clicks through."""

    def __init__(self, pem, kind="User"):
        self.pem, self.kind, self.installed, self.requests, self.verified = pem, kind, False, [], 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):
                return

            def send(self, payload, code=200):
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                outer.requests.append(("GET", self.path))
                if self.path == "/users/crvouga":
                    return self.send({"type": outer.kind})
                if self.path == "/app/installations":
                    outer.verify(self.headers.get("Authorization", ""))
                    return self.send([{"id": 777, "account": {"login": "crvouga"}}] if outer.installed else [])
                self.send({}, 404)

            def do_POST(self):
                outer.requests.append(("POST", self.path))
                if re.fullmatch(r"/app-manifests/[^/]+/conversions", self.path):
                    return self.send({"id": int(KEY_ID), "slug": "crvouga-fleet-runners", "pem": outer.pem}, 201)
                self.send({}, 404)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.http.server_address[1]}"

    def verify(self, header):
        """The app JWT must be a real RS256 signature by the app's key."""
        token = header.removeprefix("Bearer ")
        head, claims, signature = token.split(".")
        pad = lambda text: text + "=" * (-len(text) % 4)  # noqa: E731
        claim = json.loads(base64.urlsafe_b64decode(pad(claims)))
        assert claim["iss"] == KEY_ID and claim["exp"] > claim["iat"], claim
        with tempfile.TemporaryDirectory() as tmp:
            key, sig = Path(tmp) / "k.pem", Path(tmp) / "sig"
            key.write_text(self.pem)
            pub = subprocess.run([OPENSSL, "rsa", "-in", str(key), "-pubout"], capture_output=True, check=True).stdout
            (Path(tmp) / "pub.pem").write_bytes(pub)
            sig.write_bytes(base64.urlsafe_b64decode(pad(signature)))
            done = subprocess.run([OPENSSL, "dgst", "-sha256", "-verify", str(Path(tmp) / "pub.pem"), "-signature", str(sig)],
                                  input=f"{head}.{claims}".encode(), capture_output=True)
        assert done.returncode == 0, done.stderr
        self.verified += 1

    def close(self):
        self.http.shutdown()
        self.http.server_close()


SETTINGS = textwrap.dedent("""\
    in {
      role = "ci";
      github = builtins.fromJSON (builtins.readFile ./settings/github.json);
      containers = false;
      secretsFile = null; # set to ./secrets/fleet.yaml AFTER encrypting it
    }
    """)


@unittest.skipUnless(OPENSSL, "openssl is needed to sign the app token")
class SetupFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.package = self.root / "package"
        (self.package / "secrets").mkdir(parents=True)
        (self.package / "fleet.nix").write_text(SETTINGS)
        (self.package / "settings").mkdir()
        self.github_config = self.package / "settings/github.json"
        self.github_config.write_text(json.dumps({"scope": "repository", "organization": "", "repositories": [],
                                                "runnerGroup": None, "appId": "TODO", "installationId": "TODO"}))
        self.state = self.root / "state.json"
        self.github = FakeGitHub(make_pem())
        self.addCleanup(self.github.close)
        counter = self.root / "count"
        keygen = self.root / "age-keygen"
        keygen.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            if [ "$1" = "-y" ]; then echo "age1pub$(tail -c 3 "$2")"; exit 0; fi
            n=$(( $(cat {counter} 2>/dev/null || echo 0) + 1 )); echo $n > {counter}
            printf '# public key: age1pub%03d\\nAGE-SECRET-KEY-%03d\\n' $n $n
            """))
        sops = self.root / "sops"
        self.sops_calls = self.root / "sops-calls"
        sops.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            printf '%s\\n' "$*" >> {self.sops_calls}
            file="${{@: -1}}"
            [ "$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")" = 600 ] || {{ echo 'plaintext not private' >&2; exit 1; }}
            printf 'github-app-key: ENC[AES256_GCM,data:%s]\\nsops:\\n  age: ok\\n' "$(wc -c < "$file" | tr -d ' ')"
            """))
        for tool in (keygen, sops):
            tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
        self.env = {
            "FLEET_PACKAGE": str(self.package), "FLEET_SETUP_STATE": str(self.state), "FLEET_GITHUB_API": self.github.url,
            "FLEET_GITHUB_WEB": self.github.url, "FLEET_AGE_KEYGEN": str(keygen), "FLEET_KEYS_OUT": str(self.root / "keys.json"),
            "FLEET_SOPS_BIN": str(sops), "FLEET_SETUP_WAIT": "20", "FLEET_SETUP_POLL": "0.05",
        }
        patch = mock.patch.dict(os.environ, self.env)
        patch.start()
        self.addCleanup(patch.stop)
        self.visited = []
        self.browser = mock.patch.object(setup.webbrowser, "open", self.click)
        self.browser.start()
        self.addCleanup(self.browser.stop)

    def click(self, url):
        """The owner's two clicks, each followed the way a browser follows them."""
        self.visited.append(url)
        threading.Thread(target=self.follow, args=(url,), daemon=True).start()

    def follow(self, url):
        if "/apps/" in url:
            self.github.installed = True
            return
        page = urllib.request.urlopen(url, timeout=10).read().decode()
        action = re.search(r'action="([^"]+)"', page).group(1).replace("&amp;", "&")
        self.form_action = action
        self.manifest = json.loads(re.search(r'name=manifest value="([^"]+)"', page).group(1).replace("&quot;", '"'))
        state = parse_qs(urlparse(action).query)["state"][0]
        urllib.request.urlopen(f"{self.manifest['redirect_url']}?code=onetimecode&state={state}", timeout=10).read()

    def run_setup(self, *argv):
        with mock.patch("sys.stderr"):
            return setup.main(list(argv))

    def test_the_whole_setup_fills_every_file_without_leaking_the_key(self):
        self.assertEqual(self.run_setup("--repos", "crvouga/private-app,crvouga/other"), 0)
        nix = (self.package / "fleet.nix").read_text()
        registration = json.loads(self.github_config.read_text())
        self.assertEqual(registration["scope"], "repository")
        self.assertEqual(registration["repositories"], ["crvouga/private-app", "crvouga/other"])
        self.assertEqual(registration["appId"], KEY_ID)
        self.assertEqual(registration["installationId"], "777")
        self.assertNotIn("crvouga/private-app", nix)
        self.assertIn("secretsFile = ./secrets/fleet.yaml;", nix)
        encrypted = (self.package / "secrets" / "fleet.yaml").read_text()
        self.assertIn("github-app-key: ENC[", encrypted)
        self.assertNotIn("PRIVATE KEY", encrypted)
        call = self.sops_calls.read_text()
        self.assertIn("--encrypt --age age1pub", call.replace(call.split(" --encrypt")[0], ""))
        sops_yaml = (self.package / ".sops.yaml").read_text()
        self.assertIn("secrets/fleet", sops_yaml)
        self.assertNotIn("PRIVATE KEY", sops_yaml + nix)
        self.assertFalse(self.state.exists(), "the saved app is removed once nothing is left to resume")
        self.assertGreater(self.github.verified, 0, "the installation lookup must carry a valid app token")
        self.assertEqual(len(self.visited), 2)

    def test_the_app_is_a_private_runner_app_with_the_least_permissions(self):
        self.run_setup("--repos", "crvouga/private-app")
        self.assertTrue(self.form_action.startswith(self.github.url + "/settings/apps/new?state="))
        self.assertEqual(self.manifest["public"], False)
        self.assertEqual(self.manifest["default_permissions"], {"administration": "write", "metadata": "read"})
        self.assertNotIn("hook_attributes", self.manifest)
        self.assertTrue(self.manifest["redirect_url"].startswith("http://127.0.0.1:"))

    def test_an_organization_gets_org_runner_permission_and_an_org_scope(self):
        self.github.kind = "Organization"
        self.run_setup()
        self.assertTrue(self.form_action.startswith(self.github.url + "/organizations/crvouga/settings/apps/new?state="))
        self.assertEqual(self.manifest["default_permissions"]["organization_self_hosted_runners"], "write")
        registration = json.loads(self.github_config.read_text())
        self.assertEqual(registration["scope"], "organization")
        self.assertEqual(registration["organization"], "crvouga")

    def test_repositories_are_never_guessed_for_a_personal_account(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_setup()
        self.assertIn("--repos", str(caught.exception))
        self.assertEqual((self.package / "fleet.nix").read_text(), SETTINGS)
        self.assertEqual(self.visited, [])

    def test_the_allowlist_can_come_from_central_json_without_cli_arguments(self):
        registration = json.loads(self.github_config.read_text())
        registration["repositories"] = ["crvouga/private-app"]
        self.github_config.write_text(json.dumps(registration))
        self.assertEqual(self.run_setup(), 0)
        self.assertEqual(json.loads(self.github_config.read_text())["repositories"], ["crvouga/private-app"])
        self.assertNotIn("crvouga/private-app", (self.package / "fleet.nix").read_text())

    def test_a_malformed_repository_name_is_refused_before_anything_happens(self):
        with self.assertRaises(SystemExit):
            self.run_setup("--repos", "not a repo")
        self.assertEqual(self.visited, [])

    def test_running_twice_does_nothing_the_second_time(self):
        self.run_setup("--repos", "crvouga/private-app")
        before = (self.package / "fleet.nix").read_text(), (self.package / "secrets" / "fleet.yaml").read_text(), self.github_config.read_text()
        self.visited.clear()
        self.assertEqual(self.run_setup("--repos", "crvouga/private-app"), 0)
        self.assertEqual(self.visited, [])
        self.assertEqual(before, ((self.package / "fleet.nix").read_text(), (self.package / "secrets" / "fleet.yaml").read_text(), self.github_config.read_text()))

    def test_a_lost_secret_never_makes_a_second_app(self):
        self.run_setup("--repos", "crvouga/private-app")
        (self.package / "secrets" / "fleet.yaml").unlink()
        self.visited.clear()
        with self.assertRaises(SystemExit) as caught:
            self.run_setup("--repos", "crvouga/private-app")
        self.assertIn("secrets/fleet.yaml is missing", str(caught.exception))
        self.assertEqual(self.visited, [])

    def test_an_interrupted_setup_resumes_without_creating_a_second_app(self):
        self.github.installed = False
        self.state.write_text(json.dumps({"id": KEY_ID, "slug": "crvouga-fleet-runners", "pem": self.github.pem}))
        self.run_setup("--repos", "crvouga/private-app")
        converted = [r for r in self.github.requests if r[1].startswith("/app-manifests/")]
        self.assertEqual(converted, [], "the one-time manifest code must not be used again")
        self.assertEqual(json.loads(self.github_config.read_text())["appId"], KEY_ID)

    def test_the_saved_app_is_private_while_setup_is_unfinished(self):
        self.github.installed = False
        with mock.patch.object(setup, "wait_for_installation", side_effect=SystemExit("stop")):
            with self.assertRaises(SystemExit):
                self.run_setup("--repos", "crvouga/private-app")
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o600)

    def test_a_forged_redirect_does_not_complete_the_flow(self):
        flow = {"state": "right", "code": None, "done": threading.Event(), "page": b"x"}
        server = setup.LoopbackServer(("127.0.0.1", 0), setup.Flow)
        server.flow = flow
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/created?code=x&state=wrong", timeout=5)
            self.fail("a redirect with the wrong state must be refused")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)
        self.assertFalse(flow["done"].is_set())

    def test_loopback_setup_starts_without_reverse_dns(self):
        with mock.patch("socket.getfqdn", side_effect=OSError("no reverse DNS")):
            server = setup.LoopbackServer(("127.0.0.1", 0), setup.Flow)
        self.addCleanup(server.server_close)
        self.assertEqual(server.server_name, "127.0.0.1")
        self.assertGreater(server.server_port, 0)

    def test_setup_page_keeps_the_manifest_available_after_github_reauthentication(self):
        document = setup.manifest("http://127.0.0.1:1234/created", False)
        state = "retry-after-sign-in"
        flow = {"state": state, "code": None, "done": threading.Event(),
                "page": setup.form_page("User", "crvouga", state, document)}
        server = setup.LoopbackServer(("127.0.0.1", 0), setup.Flow)
        server.flow = flow
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/"
        for _ in range(2):
            with urllib.request.urlopen(url, timeout=5) as response:
                page = response.read().decode()
            action = html.unescape(re.search(r'action="([^"]+)"', page).group(1))
            payload = json.loads(html.unescape(re.search(r'name=manifest value="([^"]+)"', page).group(1)))
            self.assertEqual(payload, document)
            self.assertEqual(parse_qs(urlparse(action).query)["state"], [state])
            self.assertIn('target="_blank"', page, "GitHub must leave the retry page open")
            self.assertNotIn(".submit()", page, "returning after login must allow a deliberate retry")
            self.assertIn("confirm access", page)
            self.assertFalse(flow["done"].is_set())
            self.assertIsNone(flow["code"])


class FleetNixTest(unittest.TestCase):
    def test_the_real_settings_file_has_every_line_setup_edits(self):
        text = (ROOT / "fleet.nix").read_text()
        out = setup.settings_text(text)
        self.assertIn("./settings/github.json", out)
        self.assertIn("secretsFile = ./secrets/fleet.yaml;", out)

    def test_a_changed_settings_file_stops_with_a_clear_message(self):
        with self.assertRaises(SystemExit) as caught:
            setup.settings_text("{ }")
        self.assertIn("fleet.nix no longer has the line", str(caught.exception))


@unittest.skipUnless(shutil.which("sops") and shutil.which("age-keygen"), "sops and age are needed for the real round trip")
class RealSopsTest(unittest.TestCase):
    def test_the_encrypted_file_decrypts_with_the_ci_role_key_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            keys = {}
            for role in ("ci", "devbox"):
                out = subprocess.run(["age-keygen"], capture_output=True, text=True, check=True)
                keys[role] = (re.search(r"public key: (age1\w+)", out.stderr + out.stdout).group(1), out.stdout)
            pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----\n"
            destination = tmp / "fleet.yaml"
            setup.encrypt_app_key(pem, keys["ci"][0], destination)
            self.assertNotIn("AAAA", destination.read_text())
            good = subprocess.run(["sops", "--decrypt", "--extract", '["github-app-key"]', str(destination)], capture_output=True, text=True,
                                  env={**os.environ, "SOPS_AGE_KEY": keys["ci"][1]})
            self.assertEqual(good.stdout, pem.rstrip("\n") + "\n" if good.stdout.endswith("\n") else pem.rstrip("\n"))
            bad = subprocess.run(["sops", "--decrypt", str(destination)], capture_output=True, text=True,
                                 env={**os.environ, "SOPS_AGE_KEY": keys["devbox"][1]})
            self.assertNotEqual(bad.returncode, 0, "the devbox role's key must not open the ci secret")


if __name__ == "__main__":
    unittest.main()
