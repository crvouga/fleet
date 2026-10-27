#!/usr/bin/env python3
"""The whole fleet, end to end, with the real programs at every step.

  installer      scripts/fleet-node.sh (download, checks, the GitHub approval,
                 the one boot into the installer) and scripts/fleet-install.sh
                 (unwrap the key, install the node's credentials)
  approval       scripts/enroll.py, the code the `Fleet enroll` workflow runs
  fleet node     scripts/agent.py, reading a node's /proc, /run/fleet, /etc/fleet
  fleet server   the real fleet API (bun src/server.ts, or its Docker image when
                 FLEET_E2E_IMAGE is set) on a throwaway Postgres whose schema is
                 built by the real Atlas CLI
  dashboard      the pages and the JSON API, over HTTP

Only the outside world is faked: GitHub's issues API, Vault, the release host,
the disk listing and kexec. Needs bun, atlas, Postgres binaries and curl. Without
them the test skips, unless FLEET_E2E_REQUIRED=1 (CI sets it), when it fails.
"""

import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_support import AGE_KEY, ChainVault, NodeFiles, Stack, free_port, missing_tools, query, sha256_hex  # noqa: E402
from enroll_fakes import FakeGitHub  # noqa: E402
import iso_fixture  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
REQUIRED = os.environ.get("FLEET_E2E_REQUIRED") == "1"


def machine_id(label):
    return hashlib.sha256(("dmi:" + label).encode()).hexdigest()


def write_executable(path, body):
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def http(method, url, token=None, body=None, headers=None, follow=True):
    request = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=30) as reply:
            data = reply.read()
            return reply.status, data, reply.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def jsonbody(data):
    return json.loads(data.decode() or "{}")


@unittest.skipIf(missing_tools() and not REQUIRED, "full-chain test needs: " + ", ".join(missing_tools()))
class FullChainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        absent = missing_tools()
        if absent:
            raise AssertionError("FLEET_E2E_REQUIRED=1 but missing: " + ", ".join(absent))
        cls.tmp = tempfile.TemporaryDirectory(prefix="fleet-e2e-")
        cls.root = Path(cls.tmp.name)
        cls.role_token = secrets.token_hex(24)
        cls.vault = ChainVault(cls.role_token)
        cls.github = FakeGitHub()
        cls.stack = Stack(cls.role_token, cls.vault.url, os.environ.get("FLEET_E2E_IMAGE"))
        cls.api = cls.stack.info["apiUrl"]
        cls.admin = cls.stack.info["adminToken"]
        cls.release = cls._start_release_server()

    @classmethod
    def tearDownClass(cls):
        cls.release.terminate()
        cls.release.wait(timeout=10)
        cls.stack.stop()
        cls.vault.close()
        cls.github.close()
        cls.tmp.cleanup()

    @classmethod
    def _start_release_server(cls):
        directory = cls.root / "release"
        directory.mkdir()
        tree = iso_fixture.installer_tree()
        tree['fleet-readiness.json'] = json.dumps({'version': 1, 'roles': {role: {'blocked': []} for role in ('ci', 'devbox')}}).encode()
        iso = iso_fixture.build(tree)
        source = cls.root / "source.iso"
        source.write_bytes(iso)
        subprocess.run([sys.executable, str(SCRIPTS / "release-image.py"), str(source), str(directory)], check=True)
        cls.release_port = free_port()
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "e2e" / "release_server.py")],
            env={**os.environ, "FLEET_E2E_ROOT": str(directory), "FLEET_E2E_PORT": str(cls.release_port)},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.release_port}/fleet-installer.iso.sha256", timeout=1).read()
                return server
            except OSError:
                import time

                time.sleep(0.1)
        server.kill()
        raise AssertionError("the release server did not start")

    # ---- helpers --------------------------------------------------------------

    def admin_get(self, path):
        status, data, _ = http("GET", self.api + path, self.admin)
        return status, jsonbody(data) if data[:1] in (b"{", b"[") else data.decode()

    def node_view(self, node_id):
        status, document = self.admin_get("/v1/nodes")
        self.assertEqual(status, 200, document)
        return next((n for n in document["nodes"] if n["id"] == node_id), None)

    def enroll_as_owner(self, link):
        """What the owner's click and the `Fleet enroll` workflow do: scripts/enroll.py with the real script."""
        q = query(link)
        result = self.root / f"result-{secrets.token_hex(3)}.txt"
        done = subprocess.run(
            [sys.executable, str(SCRIPTS / "enroll.py")],
            env={
                **os.environ,
                "VAULT_ADDR": self.vault.url,
                "ACTIONS_ID_TOKEN_REQUEST_URL": self.vault.url + "/oidc?x=1",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "request-token",
                "ISSUE_TITLE": q["title"][0],
                "ISSUE_BODY": q["body"][0],
                "RESULT_FILE": str(result),
            },
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        line = result.read_text().strip()
        self.assertTrue(line.startswith("fleet-sealed: "), line)
        self.assertNotIn(AGE_KEY, done.stdout + done.stderr + line)
        number = self.github.open_issue(q["title"][0], q["body"][0])
        self.github.comment(number, line)

    def run_node_installer(self, label):
        """fleet-node.sh ci --yes, on a Linux machine whose only outside contacts are the fakes."""
        work = self.root / f"installer-{label}"
        (work / "efi").mkdir(parents=True)
        (work / "state").mkdir()
        (work / "lsblk.json").write_text(
            json.dumps({"blockdevices": [{
                "path": "/dev/nvme0n1", "type": "disk", "tran": "nvme", "rm": False, "hotplug": False,
                "size": 2000000000000, "model": "Samsung SSD 980", "serial": "S5", "mountpoints": [None],
            }]})
        )
        write_executable(work / "lsblk", f"#!/bin/sh\ncat {shlex.quote(str(work / 'lsblk.json'))}\n")
        write_executable(work / "kexec", f'#!/bin/sh\nprintf "%s\\n" "$*" >> {shlex.quote(str(work / "kexec.log"))}\n')
        env = {
            **os.environ,
            "FLEET_OS": "Linux", "FLEET_ARCH": "x86_64", "FLEET_EUID": "0", "FLEET_ISO_FS": "ext4",
            "FLEET_EFI_DIR": str(work / "efi"), "FLEET_STATE": str(work / "state"),
            "FLEET_LSBLK": str(work / "lsblk"), "FLEET_KEXEC": str(work / "kexec"),
            "FLEET_INSTALLER_URL": f"http://127.0.0.1:{self.release_port}/fleet-installer.iso",
            "FLEET_INSTALLER_SHA256_URL": f"http://127.0.0.1:{self.release_port}/fleet-installer.iso.sha256",
            "FLEET_VAULT_ADDR": self.vault.url, "FLEET_GITHUB_API": self.github.url,
            "FLEET_NO_BROWSER": "1", "FLEET_ENROLL_POLL": "1", "FLEET_ENROLL_WAIT": "90",
            "FLEET_CONFIRM_TIMEOUT": "10",
        }
        env.pop("FLEET_NO_ENROLL", None)
        process = subprocess.Popen(
            ["bash", str(SCRIPTS / "fleet-node.sh"), "ci", "--yes"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=work,
        )
        lines = []
        link = None
        for line in process.stdout:
            lines.append(line)
            if "issues/new?" in line:
                link = line[line.index("https://"):].strip()
                break
        self.assertIsNotNone(link, "the installer never showed the approval link:\n" + "".join(lines))
        self.assertFalse((work / "kexec.log").exists(), "nothing may boot before the owner approves")
        self.enroll_as_owner(link)
        rest, _ = process.communicate(timeout=120)
        output = "".join(lines) + rest
        self.assertEqual(process.returncode, 0, output)
        self.assertIn("FLEET-WIPE role=ci", output)
        self.assertNotIn(AGE_KEY, output)
        logged = (work / "kexec.log").read_text()
        command_line = next(l for l in logged.splitlines() if "--command-line=" in l).split("--command-line=", 1)[1]
        return command_line

    def run_fleet_install(self, label, command_line, mnt):
        """fleet-install.sh inside the installer image: unwrap the key and install the node's credentials."""
        work = self.root / f"image-{label}"
        work.mkdir()
        log = work / "actions"
        system = work / "ci-system"
        system.mkdir()
        disko = work / "disko"
        write_executable(disko, f"#!/bin/bash\nmkdir -p {mnt}/nix/fleet-state\n")
        write_executable(work / "select-disk", "#!/bin/sh\necho /dev/disk/by-path/pci-0000:01:00.0-nvme-1\n")
        write_executable(work / "age-keygen", '#!/bin/sh\n[ "$1" = "-y" ] && { echo age1publicstub; exit 0; }\nprintf "AGE-SECRET-KEY-STUB\\n" > "$2"\n')
        write_executable(work / "ssh-keygen", '#!/bin/sh\n[ "$1" = "-lf" ] && { echo "256 SHA256:stub $2"; exit 0; }\nprev=""; file=""\nfor a in "$@"; do [ "$prev" = "-f" ] && file=$a; prev=$a; done\nprintf "priv\\n" > "$file"; printf "pub\\n" > "$file.pub"\n')
        write_executable(work / "nixos-install", f'#!/bin/sh\nprintf "install %s\\n" "$*" >> {log}\n')
        (work / "manifest").write_text(f"ci {system}\ndisko {disko}\n")
        (work / "cmdline").write_text(command_line + "\n")
        env = {
            **os.environ,
            "FLEET_ALLOW_UNPRIVILEGED": "1", "FLEET_AUTO": "1", "FLEET_MANIFEST": str(work / "manifest"),
            "FLEET_MNT": str(mnt), "FLEET_RECORDED": str(work / "recorded"), "FLEET_INSTALL_LOG": str(work / "install.log"),
            "FLEET_SELECT_DISK": str(work / "select-disk"), "FLEET_AGE_KEYGEN": str(work / "age-keygen"),
            "FLEET_SSH_KEYGEN": str(work / "ssh-keygen"), "FLEET_NIXOS_INSTALL": str(work / "nixos-install"),
            "FLEET_CMDLINE": str(work / "cmdline"), "FLEET_ENROLLED_DIR": str(work / "enrolled"),
        }
        env.pop("FLEET_KEY_DIR", None)
        env.pop("FLEET_ENROLL_TOKEN", None)
        done = subprocess.run([str(SCRIPTS / "fleet-install.sh")], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(self.role_token, done.stdout + done.stderr)
        self.assertNotIn(AGE_KEY, done.stdout + done.stderr)
        return log.read_text()

    # ---- the chain --------------------------------------------------------------

    def test_01_download_to_dashboard(self):
        """Download the installer, get approved, install, boot, report, and show up on the dashboard."""
        command_line = self.run_node_installer("a")
        self.assertRegex(command_line, r"fleet\.enroll=hvs\.wrapped-ci-\d+")
        self.assertIn("fleet.role=ci", command_line)
        self.assertIn(f"fleet.vault={self.vault.url}", command_line)
        self.assertTrue(command_line.endswith("fleet.role=ci"))

        mnt = self.root / "node-a"
        actions = self.run_fleet_install("a", command_line, mnt)
        self.assertIn("install ", actions)
        token_file = mnt / "nix/fleet-state/agent/role-token"
        self.assertEqual(token_file.read_text().strip(), self.role_token)
        self.assertEqual(stat.S_IMODE(token_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(token_file.parent.stat().st_mode), 0o700)
        self.assertIn("/v1/sys/wrapping/unwrap", [path for _m, path in self.vault.calls])

        identity = machine_id("chain-a")
        node = NodeFiles(mnt, f"ci-{identity[:4]}", "ci", identity, slots=4)
        first = node.agent(self.api, "once")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertNotIn(self.role_token, first.stdout + first.stderr)
        self.assertIn("registration: approved", first.stdout)

        view = self.node_view(identity)
        self.assertIsNotNone(view, "the node never appeared on the server")
        self.assertEqual((view["status"], view["role"], view["enrolledVia"]), ("online", "ci", "role-token"))
        self.assertEqual(view["hostname"], f"ci-{identity[:4]}")
        self.assertEqual(view["facts"]["runners"], {"slots": 4, "busy": 0})
        self.assertNotIn("secretHash", json.dumps(view))
        self.assertNotIn(self.role_token, json.dumps(view))

        status, page, _ = http("GET", self.api + "/", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("Overview", page.decode())
        status, page, _ = http("GET", self.api + "/nodes", self.admin)
        self.assertEqual(status, 200)
        self.assertIn(f"ci-{identity[:4]}", page.decode())
        status, page, _ = http("GET", self.api + f"/nodes/{identity}", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("ci-" + identity[:4], page.decode())
        status, css, headers = http("GET", self.api + "/assets/app.css")
        self.assertEqual(status, 200)
        self.assertIn("text/css", headers.get("Content-Type", ""))
        self.assertGreater(len(css), 1000)

    def test_02_unknown_node_waits_for_a_person_then_receives_config(self):
        identity = machine_id("chain-b")
        node = NodeFiles(self.root / "node-b", f"devbox-{identity[:4]}", "devbox", identity)
        first = node.agent(self.api, "once")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("registration: pending", first.stdout)
        self.assertEqual(self.node_view(identity)["status"], "pending")

        status, page, _ = http("GET", self.api + "/pending", self.admin)
        self.assertEqual(status, 200)
        self.assertIn(f"devbox-{identity[:4]}", page.decode())
        cached = json.loads((node.state / "config.json").read_text())
        self.assertEqual(set(cached["values"]), {"heartbeat"}, "a pending node learns its report interval and nothing else")

        status, _data, _ = http("POST", self.api + f"/v1/nodes/{identity}/approve", self.admin, {})
        self.assertEqual(status, 200)
        second = node.agent(self.api, "once")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("registration: approved", second.stdout)
        view = self.node_view(identity)
        self.assertEqual((view["status"], view["enrolledVia"]), ("online", "hello"))

    def test_03_settings_from_the_dashboard_reach_the_node(self):
        identity = machine_id("chain-c")
        node = NodeFiles(self.root / "node-c", f"ci-{identity[:4]}", "ci", identity, slots=4)
        (node.state).mkdir(parents=True)
        (node.state / "role-token").write_text(self.role_token + "\n")
        self.assertEqual(node.agent(self.api, "once").returncode, 0)

        desired = {
            "heartbeat": {"intervalSeconds": 30},
            "sync": {"paused": True},
            "runners": {"extraLabels": ["lab-a"], "repositories": ["crvouga/private-app"]},
            "capacity": {"slotMax": 2},
        }
        status, data, _ = http("PUT", self.api + "/v1/settings/fleet", self.admin, desired)
        self.assertEqual(status, 200, data)
        status, data, _ = http("PUT", self.api + "/v1/settings/fleet", self.admin, {"heartbeat": {"intervalSeconds": 1}})
        self.assertEqual(status, 400, "an out-of-range value must be refused, not stored")
        status, data, _ = http("PUT", self.api + "/v1/settings/fleet", self.admin, {"runner": {}})
        self.assertEqual(status, 400, "a typo must not silently do nothing")
        http("PUT", self.api + "/v1/settings/fleet", self.admin, desired)

        run = node.agent(self.api, "once")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        # agent/config.json remembers the revision; fleet-state/config.json is what shell scripts read.
        cached = json.loads((node.state / "config.json").read_text())
        flat = json.loads((node.root / "nix/fleet-state/config.json").read_text())
        self.assertEqual(flat, cached["values"])
        self.assertEqual(flat["sync"], {"paused": True})
        self.assertEqual(flat["heartbeat"]["intervalSeconds"], 30)
        self.assertNotIn("alerts", flat)
        self.assertEqual(json.loads((node.root / "run/fleet/config.json").read_text()), flat)
        self.assertIn("lab-a", (node.root / "run/fleet/runner-labels").read_text().split())
        self.assertEqual((node.root / "run/fleet/assign/slot-1").read_text().strip(), "crvouga/private-app")
        self.assertEqual(stat.S_IMODE((node.root / "nix/fleet-state/config.json").stat().st_mode) & 0o022, 0)

        # The next report carries the revision the node applied; the server
        # remembers it and does not send the same settings again.
        again = node.agent(self.api, "once")
        self.assertEqual(again.returncode, 0)
        self.assertEqual(self.node_view(identity)["configRevision"], cached["revision"])
        self.assertEqual(json.loads((node.state / "config.json").read_text()), cached)

        # A node-scoped setting wins over the fleet's, and is visible as effective config.
        status, data, _ = http("PUT", self.api + f"/v1/settings/node:{identity}", self.admin, {"sync": {"paused": False}})
        self.assertEqual(status, 200, data)
        node.agent(self.api, "once")
        refreshed = json.loads((node.state / "config.json").read_text())
        self.assertEqual(refreshed["values"]["sync"], {"paused": False})
        self.assertNotEqual(refreshed["revision"], cached["revision"])
        _status, document = self.admin_get(f"/v1/settings/node:{identity}")
        self.assertEqual(document["effective"]["sync"], {"paused": False})
        http("PUT", self.api + f"/v1/settings/node:{identity}", self.admin, {})
        http("PUT", self.api + "/v1/settings/fleet", self.admin, {})

    def test_04_a_forgotten_node_registers_again_and_removal_is_recorded(self):
        identity = machine_id("chain-d")
        node = NodeFiles(self.root / "node-d", f"ci-{identity[:4]}", "ci", identity, slots=2)
        node.state.mkdir(parents=True)
        (node.state / "role-token").write_text(self.role_token + "\n")
        self.assertEqual(node.agent(self.api, "once").returncode, 0)

        status, _data, _ = http("DELETE", self.api + f"/v1/nodes/{identity}", self.admin)
        self.assertEqual(status, 200)
        self.assertIsNone(self.node_view(identity))
        healed = node.agent(self.api, "once")
        self.assertEqual(healed.returncode, 0, healed.stdout + healed.stderr)
        self.assertEqual(self.node_view(identity)["status"], "online", "the 401 must lead to a fresh registration")

        retire = node.agent(self.api, "retire")
        self.assertEqual(retire.returncode, 0, retire.stdout + retire.stderr)
        self.assertEqual(self.node_view(identity)["status"], "retired")
        _status, events = self.admin_get(f"/v1/events?node={identity}&limit=50")
        kinds = {e["kind"] for e in events["events"]}
        self.assertTrue(kinds, events)

    def test_05_a_wrong_role_token_never_approves(self):
        identity = machine_id("chain-e")
        node = NodeFiles(self.root / "node-e", f"ci-{identity[:4]}", "ci", identity, slots=2)
        node.state.mkdir(parents=True)
        (node.state / "role-token").write_text("not-the-role-token-at-all\n")
        node.agent(self.api, "once")
        self.assertEqual(self.node_view(identity)["status"], "pending")

    def test_06_rollbacks_and_failed_units_reach_the_events_feed(self):
        identity = machine_id("chain-f")
        node = NodeFiles(self.root / "node-f", f"ci-{identity[:4]}", "ci", identity, slots=2)
        node.state.mkdir(parents=True)
        (node.state / "role-token").write_text(self.role_token + "\n")
        node.agent(self.api, "once")
        (node.root / "run/fleet/health-failure").write_text("mode=switch\nfleet-sync.service failed its health check\n")
        node.agent(self.api, "once")
        view = self.node_view(identity)
        self.assertTrue(view["facts"]["sync"]["rolledBack"], view["facts"])
        _status, events = self.admin_get(f"/v1/events?node={identity}&limit=50")
        self.assertTrue(any("roll" in e["kind"] for e in events["events"]), events)

    def test_07_dashboard_has_no_vault_password_login_and_metrics_require_admin(self):
        status, _data, _ = http("GET", self.api + "/", follow=False)
        self.assertIn(status, (302, 303))
        self.assertEqual(http("GET", self.api + "/metrics")[0], 401)
        status, text, _ = http("GET", self.api + "/metrics", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("fleet_nodes", text.decode())
        status, page, _ = http("GET", self.api + "/login")
        self.assertEqual(status, 200)
        self.assertIn("OpenID Connect", page.decode())
        self.assertNotIn('type="password"', page.decode())
        self.assertNotIn("Vault", page.decode())
        # The node/install chain does not stand in for Google/OIDC acceptance.
        # Fleet's auth/browser-journey.test.ts owns the signed-token browser flow.
        for password in ("wrong", self.vault.password):
            form = urlencode({"username": "crvouga", "password": password})
            request = urllib.request.Request(self.api + "/login", data=form.encode(), method="POST", headers={"Origin": self.api})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.build_opener(_NoRedirect).open(request, timeout=20)
            self.assertEqual(caught.exception.code, 410)
            self.assertIsNone(caught.exception.headers.get("Set-Cookie"))
        status, page, _ = http("GET", self.api + "/", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("Fleet", page.decode())

    def test_08_everything_lives_in_the_fleet_schema(self):
        psql = shutil.which("psql")
        if psql is None:
            self.skipTest("psql is not installed")
        url = self.stack.info["databaseUrl"]
        listing = subprocess.run(
            [psql, url, "-At", "-c",
             "select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace "
             "where c.relkind in ('r','p','v','m','S','f') and n.nspname not in ('pg_catalog','information_schema','pg_toast') order by 1"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(listing.returncode, 0, listing.stderr)
        outside = [line for line in listing.stdout.split() if not line.startswith("fleet.")]
        self.assertEqual(outside, [], "the fleet API created something outside its schema")
        self.assertIn("fleet.nodes", listing.stdout)
        self.assertIn("fleet.heartbeats", listing.stdout)
        secret_leak = subprocess.run(
            [psql, url, "-At", "-c", f"select count(*) from fleet.nodes where secret_hash like '%{self.role_token}%'"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(secret_leak.stdout.strip(), "0")
        stored = subprocess.run([psql, url, "-At", "-c", "select secret_hash from fleet.nodes limit 1"], capture_output=True, text=True)
        self.assertRegex(stored.stdout.strip(), r"^[0-9a-f]{64}$", "only a hash of the node secret is stored")

    def test_09_the_server_refuses_to_start_misconfigured(self):
        done = subprocess.run(
            ["bun", "src/server.ts"], cwd=ROOT.parent / "fleet-api", capture_output=True, text=True, timeout=60,
            env={"PATH": os.environ["PATH"], "DATABASE_URL": "postgres://nobody@127.0.0.1:1/x"},
        )
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("FLEET_ADMIN_TOKEN", done.stdout + done.stderr)
        self.assertNotIn("postgres://nobody", done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main()
