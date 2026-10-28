#!/usr/bin/env python3
"""Real installer, live agent, controller and dashboard with disposable storage.

GitHub is a negative-control fake: normal enrollment never contacts it. The
installer takes no role: an optional enrollment token travels in the private
handoff initrd, Fleet approves the node with it and assigns the role.
Physical disks and boot commands are replaced by disposable fixtures.
"""

import gzip
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from concurrent.futures import ThreadPoolExecutor  # noqa: E402
from e2e_support import NodeFiles, Stack, free_port, missing_tools, query, run_runner_control, runner_tools, sha256_hex  # noqa: E402
from enroll_fakes import FakeGitHub  # noqa: E402
from fake_github import FakeGitHubApp, generate_app_key  # noqa: E402
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


def handoff_members(archive):
    """The names and bodies of the private handoff initramfs (gzip newc)."""
    data, members, at = gzip.decompress(archive), {}, 0
    while True:
        size, name_size = int(data[at + 54:at + 62], 16), int(data[at + 94:at + 102], 16)
        name = data[at + 110:at + 110 + name_size - 1].decode()
        body = at + 110 + name_size + (-(110 + name_size) % 4)
        if name == "TRAILER!!!":
            return members
        members[name] = data[body:body + size]
        at = body + size + (-size % 4)


@unittest.skipIf(missing_tools() and not REQUIRED, "full-chain test needs: " + ", ".join(missing_tools()))
class FullChainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        absent = missing_tools()
        if absent:
            raise AssertionError("FLEET_E2E_REQUIRED=1 but missing: " + ", ".join(absent))
        cls.tmp = tempfile.TemporaryDirectory(prefix="fleet-e2e-")
        cls.root = Path(cls.tmp.name)
        cls.role_token = "fleet-enroll." + secrets.token_hex(24)
        cls.github = FakeGitHub()
        cls.stack = Stack(cls.role_token)
        cls.controller = cls.stack.info["controllerUrl"]
        cls.admin = cls.stack.info["adminToken"]
        cls.release = cls._start_release_server()

    @classmethod
    def tearDownClass(cls):
        cls.release.terminate()
        cls.release.wait(timeout=10)
        cls.stack.stop()
        cls.github.close()
        cls.tmp.cleanup()

    @classmethod
    def _start_release_server(cls):
        directory = cls.root / "release"
        directory.mkdir()
        tree = iso_fixture.installer_tree()
        tree['fleet-readiness.json'] = json.dumps({'version': 2, 'blocked': []}).encode()
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
        status, data, _ = http("GET", self.controller + path, self.admin)
        return status, jsonbody(data) if data[:1] in (b"{", b"[") else data.decode()

    def node_view(self, node_id):
        status, document = self.admin_get("/v1/nodes")
        self.assertEqual(status, 200, document)
        return next((n for n in document["nodes"] if n["id"] == node_id), None)


    def run_node_installer(self, label):
        """fleet-node.sh install --yes, on a Linux machine whose only outside contacts are the fakes.
        Returns the kernel command line and the private handoff initrd members."""
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
        write_executable(work / "kexec", textwrap.dedent(f"""\
            #!/bin/bash
            printf "%s\\n" "$*" >> {shlex.quote(str(work / "kexec.log"))}
            for arg in "$@"; do
              case "$arg" in --initrd=*) cp "${{arg#--initrd=}}" {shlex.quote(str(work / "initrd"))} ;; esac
            done
            """))
        env = {
            **os.environ,
            "FLEET_OS": "Linux", "FLEET_ARCH": "x86_64", "FLEET_EUID": "0", "FLEET_ISO_FS": "ext4",
            "FLEET_EFI_DIR": str(work / "efi"), "FLEET_STATE": str(work / "state"),
            "FLEET_LSBLK": str(work / "lsblk"), "FLEET_KEXEC": str(work / "kexec"),
            "FLEET_INSTALLER_URL": f"http://127.0.0.1:{self.release_port}/fleet-installer.iso",
            "FLEET_INSTALLER_SHA256_URL": f"http://127.0.0.1:{self.release_port}/fleet-installer.iso.sha256",
            "FLEET_GITHUB_API": self.github.url, "FLEET_NO_BROWSER": "1", "FLEET_CONFIRM_TIMEOUT": "10",
            "FLEET_ENROLL_TOKEN": self.role_token,
        }
        process = subprocess.Popen(
            ["bash", str(SCRIPTS / "fleet-node.sh"), "install", "--yes"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=work,
        )
        output, _ = process.communicate(timeout=120)
        self.assertEqual(self.github.requests, [])
        self.assertNotIn('issues/new?', output)
        self.assertEqual(process.returncode, 0, output)
        self.assertIn("FLEET-WIPE install", output)
        self.assertNotIn(self.role_token, output)
        logged = (work / "kexec.log").read_text()
        command_line = next(l for l in logged.splitlines() if "--command-line=" in l).split("--command-line=", 1)[1]
        initrd = (work / "initrd").read_bytes()[len(b"initrd-bytes\n"):]
        return command_line, handoff_members(initrd)

    def run_fleet_install(self, label, command_line, handoff, mnt):
        """fleet-install.sh inside the installer image: install base and the node's credentials."""
        work = self.root / f"image-{label}"
        work.mkdir()
        log = work / "actions"
        system = work / "base-system"
        system.mkdir()
        disko = work / "disko"
        write_executable(disko, f"#!/bin/bash\nmkdir -p {mnt}/nix/fleet-state\n")
        write_executable(work / "select-disk", "#!/bin/sh\necho /dev/disk/by-path/pci-0000:01:00.0-nvme-1\n")
        write_executable(work / "ssh-keygen", '#!/bin/sh\n[ "$1" = "-lf" ] && { echo "256 SHA256:stub $2"; exit 0; }\nprev=""; file=""\nfor a in "$@"; do [ "$prev" = "-f" ] && file=$a; prev=$a; done\nprintf "priv\\n" > "$file"; printf "pub\\n" > "$file.pub"\n')
        write_executable(work / "nixos-install", f'#!/bin/sh\nprintf "install %s\\n" "$*" >> {log}\n')
        (work / "manifest").write_text(f"base {system}\ndisko {disko}\n")
        (work / "cmdline").write_text(command_line + "\n")
        # modules/installer.nix moves the handoff member to /run/fleet-enrollment/token.
        (work / "handoff-token").write_bytes(handoff["fleet-enrollment.token"])
        env = {
            **os.environ,
            "FLEET_ALLOW_UNPRIVILEGED": "1", "FLEET_AUTO": "1", "FLEET_MANIFEST": str(work / "manifest"),
            "FLEET_MNT": str(mnt), "FLEET_RECORDED": str(work / "recorded"), "FLEET_INSTALL_LOG": str(work / "install.log"),
            "FLEET_SELECT_DISK": str(work / "select-disk"),
            "FLEET_SSH_KEYGEN": str(work / "ssh-keygen"), "FLEET_NIXOS_INSTALL": str(work / "nixos-install"),
            "FLEET_CMDLINE": str(work / "cmdline"), "FLEET_ENROLLED_DIR": str(work / "enrolled"),
            "FLEET_ENROLLMENT_HANDOFF": str(work / "handoff-token"),
        }
        env.pop("FLEET_KEY_DIR", None)
        env.pop("FLEET_ENROLL_TOKEN", None)
        done = subprocess.run([str(SCRIPTS / "fleet-install.sh")], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(self.role_token, done.stdout + done.stderr)
        self.assertNotIn(self.role_token, (work / "install.log").read_text())
        return log.read_text()

    # ---- the chain --------------------------------------------------------------

    def test_01_download_to_dashboard(self):
        """Download the installer, install base with an enrollment token, boot, report, and show up on the dashboard."""
        command_line, handoff = self.run_node_installer("a")
        self.assertNotIn("fleet.role=", command_line)
        self.assertNotIn("fleet.enroll=", command_line)
        self.assertNotIn(self.role_token, command_line)
        self.assertEqual(handoff, {"fleet-enrollment.token": self.role_token.encode() + b"\n"})

        mnt = self.root / "node-a"
        actions = self.run_fleet_install("a", command_line, handoff, mnt)
        self.assertIn("install ", actions)
        token_file = mnt / "nix/fleet-state/agent/enrollment-token"
        self.assertEqual(token_file.read_text().strip(), self.role_token)
        self.assertEqual(stat.S_IMODE(token_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(token_file.parent.stat().st_mode), 0o700)
        self.assertFalse((mnt / "nix/fleet-state/secrets").exists(), "the node creates its own age identity")

        identity = machine_id("chain-a")
        node = NodeFiles(mnt, f"ci-{identity[:4]}", "ci", identity, slots=4)
        first = node.agent(self.controller, "once")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertNotIn(self.role_token, first.stdout + first.stderr)
        self.assertIn("registration: approved", first.stdout)

        view = self.node_view(identity)
        self.assertIsNotNone(view, "the node never appeared on the server")
        # The enrollment token names ci, so Fleet assigns it (contract C1).
        self.assertEqual((view["status"], view["role"]), ("online", "ci"))
        self.assertEqual(view["hostname"], f"ci-{identity[:4]}")
        self.assertEqual(view["facts"]["runners"], {"slots": 4, "busy": 0})
        self.assertNotIn("secretHash", json.dumps(view))
        self.assertNotIn(self.role_token, json.dumps(view))

        status, page, _ = http("GET", self.controller + "/", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("Overview", page.decode())
        status, page, _ = http("GET", self.controller + "/nodes", self.admin)
        self.assertEqual(status, 200)
        self.assertIn(f"ci-{identity[:4]}", page.decode())
        status, page, _ = http("GET", self.controller + f"/nodes/{identity}", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("ci-" + identity[:4], page.decode())
        status, css, headers = http("GET", self.controller + "/assets/app.css")
        self.assertEqual(status, 200)
        self.assertIn("text/css", headers.get("Content-Type", ""))
        self.assertGreater(len(css), 1000)

    def test_02_unknown_node_waits_for_a_person_then_receives_config(self):
        identity = machine_id("chain-b")
        node = NodeFiles(self.root / "node-b", f"devbox-{identity[:4]}", "devbox", identity)
        first = node.agent(self.controller, "once")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("registration: pending", first.stdout)
        self.assertEqual(self.node_view(identity)["status"], "pending")

        status, page, _ = http("GET", self.controller + "/pending", self.admin)
        self.assertEqual(status, 200)
        self.assertIn(f"devbox-{identity[:4]}", page.decode())
        cached = json.loads((node.state / "config.json").read_text())
        self.assertEqual(set(cached["values"]), {"heartbeat"}, "a pending node learns its report interval and nothing else")

        status, _data, _ = http("POST", self.controller + f"/v1/nodes/{identity}/approve", self.admin, {})
        self.assertEqual(status, 200)
        second = node.agent(self.controller, "once")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("registration: approved", second.stdout)
        view = self.node_view(identity)
        self.assertEqual((view["status"], view["enrolledVia"]), ("online", "hello"))

    def test_03_settings_from_the_dashboard_reach_the_node(self):
        identity = machine_id("chain-c")
        node = NodeFiles(self.root / "node-c", f"ci-{identity[:4]}", "ci", identity, slots=4)
        (node.state).mkdir(parents=True)
        (node.state / "enrollment-token").write_text(self.role_token + "\n")
        self.assertEqual(node.agent(self.controller, "once").returncode, 0)

        desired = {
            "heartbeat": {"intervalSeconds": 30},
            "sync": {"paused": True},
            "runners": {"extraLabels": ["lab-a"], "repositories": ["crvouga/private-app"]},
            "capacity": {"slotMax": 2},
        }
        def put_fleet(body):
            # Writes to an existing scope carry the revision they read (optimistic
            # concurrency), and pausing every node's updates is acknowledged on purpose.
            _status, current, _ = http("GET", self.controller + "/v1/settings/fleet", self.admin)
            revision = (json.loads(current).get("revision") if _status == 200 else None) or 0
            headers = {"X-Fleet-Acknowledge": "fleet_sync_paused"}
            if revision:
                headers["If-Match"] = str(revision)
            return http("PUT", self.controller + "/v1/settings/fleet", self.admin, body, headers=headers)

        status, data, _ = put_fleet(desired)
        self.assertEqual(status, 200, data)
        status, data, _ = http("PUT", self.controller + "/v1/settings/fleet", self.admin, desired)
        self.assertEqual(status, 428, "an existing scope needs the revision the caller read")
        status, data, _ = put_fleet({"heartbeat": {"intervalSeconds": 1}})
        self.assertEqual(status, 400, "an out-of-range value must be refused, not stored")
        status, data, _ = put_fleet({"runner": {}})
        self.assertEqual(status, 400, "a typo must not silently do nothing")
        put_fleet(desired)

        run = node.agent(self.controller, "once")
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
        again = node.agent(self.controller, "once")
        self.assertEqual(again.returncode, 0)
        self.assertEqual(self.node_view(identity)["appliedRevision"], cached["revision"])
        self.assertEqual(json.loads((node.state / "config.json").read_text()), cached)

        # A node-scoped setting wins over the fleet's, and is visible as effective config.
        status, data, _ = http("PUT", self.controller + f"/v1/settings/node:{identity}", self.admin, {"sync": {"paused": False}})
        self.assertEqual(status, 200, data)
        node.agent(self.controller, "once")
        refreshed = json.loads((node.state / "config.json").read_text())
        self.assertEqual(refreshed["values"]["sync"], {"paused": False})
        self.assertNotEqual(refreshed["revision"], cached["revision"])
        _status, document = self.admin_get(f"/v1/settings/node:{identity}")
        self.assertEqual(document["effective"]["sync"], {"paused": False})
        http("PUT", self.controller + f"/v1/settings/node:{identity}", self.admin, {})
        http("PUT", self.controller + "/v1/settings/fleet", self.admin, {})

    def test_04_a_forgotten_node_registers_again_and_removal_is_recorded(self):
        identity = machine_id("chain-d")
        node = NodeFiles(self.root / "node-d", f"ci-{identity[:4]}", "ci", identity, slots=2)
        node.state.mkdir(parents=True)
        (node.state / "enrollment-token").write_text(self.role_token + "\n")
        self.assertEqual(node.agent(self.controller, "once").returncode, 0)

        status, data, _ = http("DELETE", self.controller + f"/v1/nodes/{identity}", self.admin, {})
        self.assertEqual(status, 400, "deleting needs the typed confirmation")
        self.assertEqual(json.loads(data)["error"], "confirmation_required")
        status, _data, _ = http("DELETE", self.controller + f"/v1/nodes/{identity}", self.admin, {"confirm": f"ci-{identity[:4]}"})
        self.assertEqual(status, 200)
        self.assertIsNone(self.node_view(identity))
        healed = node.agent(self.controller, "once")
        self.assertEqual(healed.returncode, 0, healed.stdout + healed.stderr)
        self.assertEqual(self.node_view(identity)["status"], "online", "the 401 must lead to a fresh registration")

        retire = node.agent(self.controller, "retire")
        self.assertEqual(retire.returncode, 0, retire.stdout + retire.stderr)
        self.assertEqual(self.node_view(identity)["status"], "retired")
        _status, events = self.admin_get(f"/v1/events?node={identity}&limit=50")
        kinds = {e["kind"] for e in events["events"]}
        self.assertTrue(kinds, events)

    def test_05_a_wrong_enrollment_token_never_approves(self):
        identity = machine_id("chain-e")
        node = NodeFiles(self.root / "node-e", f"ci-{identity[:4]}", "ci", identity, slots=2)
        node.state.mkdir(parents=True)
        (node.state / "enrollment-token").write_text("not-the-enrollment-token-at-all\n")
        node.agent(self.controller, "once")
        self.assertEqual(self.node_view(identity)["status"], "pending")

    def test_06_rollbacks_and_failed_units_reach_the_events_feed(self):
        identity = machine_id("chain-f")
        node = NodeFiles(self.root / "node-f", f"ci-{identity[:4]}", "ci", identity, slots=2)
        node.state.mkdir(parents=True)
        (node.state / "enrollment-token").write_text(self.role_token + "\n")
        node.agent(self.controller, "once")
        (node.root / "run/fleet/health-failure").write_text("mode=switch\nfleet-sync.service failed its health check\n")
        node.agent(self.controller, "once")
        view = self.node_view(identity)
        self.assertTrue(view["facts"]["sync"]["rolledBack"], view["facts"])
        _status, events = self.admin_get(f"/v1/events?node={identity}&limit=50")
        self.assertTrue(any("roll" in e["kind"] for e in events["events"]), events)

    def test_07_dashboard_has_no_vault_password_login_and_metrics_require_admin(self):
        status, _data, _ = http("GET", self.controller + "/", follow=False)
        self.assertIn(status, (302, 303))
        self.assertEqual(http("GET", self.controller + "/metrics")[0], 401)
        status, text, _ = http("GET", self.controller + "/metrics", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("fleet_nodes", text.decode())
        status, page, _ = http("GET", self.controller + "/login")
        self.assertEqual(status, 200)
        self.assertIn("OpenID Connect", page.decode())
        self.assertNotIn('type="password"', page.decode())
        self.assertNotIn("Vault", page.decode())
        # The node/install chain does not stand in for Google/OIDC acceptance.
        # Fleet's auth/browser-journey.test.ts owns the signed-token browser flow.
        for password in ("wrong", secrets.token_urlsafe(24)):
            form = urlencode({"username": "crvouga", "password": password})
            request = urllib.request.Request(self.controller + "/login", data=form.encode(), method="POST", headers={"Origin": self.controller})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.build_opener(_NoRedirect).open(request, timeout=20)
            self.assertEqual(caught.exception.code, 410)
            self.assertIsNone(caught.exception.headers.get("Set-Cookie"))
        status, page, _ = http("GET", self.controller + "/", self.admin)
        self.assertEqual(status, 200)
        self.assertIn("Fleet", page.decode())

    def test_08_sqlite_persists_nodes_and_only_stores_secret_hashes(self):
        path = Path(self.stack.info["databaseUrl"])
        self.assertTrue(path.is_file())
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
            tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
            self.assertTrue({"nodes", "heartbeats", "events", "allowed_emails"}.issubset(tables))
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
            hashes = [row[0] for row in db.execute("select secret_hash from nodes")]
            self.assertTrue(hashes)
            for stored in hashes:
                self.assertRegex(stored, r"^[0-9a-f]{64}$", "only a hash of the node secret is stored")
                self.assertNotIn(self.role_token, stored)

    def test_10_the_controller_assigns_the_role_and_the_node_converges_to_it(self):
        """Installed as base, approved without a role, then assigned one: the node follows, the report never decides."""
        identity = machine_id("chain-g")
        node = NodeFiles(self.root / "node-g", f"base-{identity[:4]}", "base", identity)
        recipient = "age1" + "q" * 58
        (node.root / "nix/fleet-state/secrets").mkdir(parents=True)
        (node.root / "nix/fleet-state/secrets/age.pub").write_text(recipient + "\n")
        target = node.root / "nix/fleet-state/target"

        self.assertEqual(node.agent(self.controller, "once").returncode, 0)
        self.assertEqual(self.node_view(identity)["status"], "pending")
        self.assertFalse(target.exists(), "a pending node keeps what it runs")

        status, _data, _ = http("POST", self.controller + f"/v1/nodes/{identity}/approve", self.admin, {})
        self.assertEqual(status, 200)
        self.assertEqual(node.agent(self.controller, "once").returncode, 0)
        self.assertEqual(target.read_text(), "role=base\nclosure=base\n")
        view = self.node_view(identity)
        self.assertEqual((view["role"], view["observedRole"], view["desiredClosure"]), (None, "base", "base"))

        status, data, _ = http("PATCH", self.controller + f"/v1/nodes/{identity}", self.admin, {"role": "devbox"})
        self.assertEqual(status, 200, data)
        run = node.agent(self.controller, "once")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(target.read_text(), "role=devbox\nclosure=devbox\n")
        self.assertIn("start --no-block fleet-sync.service", node.systemctl_log.read_text())
        view = self.node_view(identity)
        # The report says base runs; the assignment stays devbox until the node gets there.
        self.assertEqual((view["role"], view["observedRole"], view["desiredClosure"]), ("devbox", "base", "devbox"))
        self.assertNotEqual(view["convergence"], "converged")
        _status, recipients = self.admin_get("/v1/recipients")
        self.assertIn({"nodeId": identity, "hostname": f"base-{identity[:4]}", "recipient": recipient, "next": None},
                      recipients["roles"]["devbox"])

        # fleet-sync switched and rebooted into devbox and recorded its verdict.
        (node.root / "etc/fleet/node.conf").write_text(
            "role=devbox\nflake_attr=devbox\nreserve_gib=4\nper_runner_gib=6\nper_runner_cores=2\nslot_max=8\nhigh_mem_gib=60\n")
        (node.root / "run/fleet/reconcile.json").write_text(json.dumps({
            "phase": "converged", "issues": [], "role": "devbox", "closure": "devbox",
            "revision": "9f3c2a1e00000000000000000000000000000000", "at": "2026-10-27T12:00:00Z"}))
        self.assertEqual(node.agent(self.controller, "once").returncode, 0)
        view = self.node_view(identity)
        self.assertEqual((view["role"], view["observedRole"], view["observedClosure"]), ("devbox", "devbox", "devbox"))
        self.assertEqual(view["convergence"], "converged")
        _status, events = self.admin_get(f"/v1/events?node={identity}&limit=50")
        self.assertIn("role_assigned", {event["kind"] for event in events["events"]})

    def test_09_the_server_refuses_to_start_misconfigured(self):
        done = subprocess.run(
            ["bun", "src/controller.ts"], cwd=ROOT.parent / "fleet-controller", capture_output=True, text=True, timeout=60,
            env={"PATH": os.environ["PATH"]},
        )
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("FLEET_ADMIN_TOKEN", done.stdout + done.stderr)


@unittest.skipIf(missing_tools() and not REQUIRED, "full-chain test needs: " + ", ".join(missing_tools()))
@unittest.skipIf(shutil.which("openssl") is None, "runner registration chain needs openssl for the throwaway App key")
class RunnerRegistrationChainTest(unittest.TestCase):
    """The real controller and the real runner_control.py, with GitHub replaced by a loopback fake.

    The controller holds a throwaway GitHub App key (given to the controller process only) and
    talks to the fake through FLEET_GITHUB_API_URL. Nodes hold nothing but their own credential.
    Proves the wiring: node credential -> controller -> App JWT -> installation token ->
    registration token -> node, and what each failure looks like to the node (exit 0, 75, 78).
    It does not prove anything about the real api.github.com or a real runner starting."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="fleet-e2e-runner-")
        cls.root = Path(cls.tmp.name)
        cls.enroll_token = "fleet-enroll." + secrets.token_hex(24)
        cls.pem, public = generate_app_key(cls.root)
        cls.github = FakeGitHubApp(public)
        cls.stack = Stack(cls.enroll_token, extra_env={
            "FLEET_GITHUB_API_URL": cls.github.url, "FLEET_GITHUB_APP_PRIVATE_KEY": cls.pem,
        })
        cls.controller = cls.stack.info["controllerUrl"]
        cls.admin = cls.stack.info["adminToken"]
        cls.tools = runner_tools(cls.root / "tools")
        cls.repositories = ["acme/app", "acme/api"]
        cls.nodes = 0
        status, data, _ = http("PUT", cls.controller + "/v1/github/integration", cls.admin, {
            "scope": "repository", "repositories": cls.repositories,
            "appId": cls.github.app_id, "installationId": cls.github.installation_id,
        })
        if status != 200:
            cls.tearDownClass()
            raise AssertionError("the GitHub integration was not accepted: %s %s" % (status, data))

    @classmethod
    def tearDownClass(cls):
        cls.stack.stop()
        cls.github.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.github.clear()

    # ---- helpers --------------------------------------------------------------

    def enroll(self, with_token=True, role_slots=4):
        """A node installed as base that reports to the controller once. Returns (id, node)."""
        type(self).nodes += 1
        identity = machine_id("runner-chain-%d" % self.nodes)
        node = NodeFiles(self.root / ("node-%d" % self.nodes), "ci-" + identity[:4], "ci", identity, slots=role_slots)
        if with_token:
            node.state.mkdir(parents=True)
            (node.state / "enrollment-token").write_text(self.enroll_token + "\n")
        first = node.agent(self.controller, "once")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        return identity, node

    def assigned_repository(self, node, slot="slot-1"):
        return (node.root / "run/fleet/assign" / slot).read_text().strip()

    def admin_call(self, method, path, body=None, headers=None):
        status, data, _ = http(method, self.controller + path, self.admin, body, headers=headers)
        return status, jsonbody(data) if data[:1] in (b"{", b"[") else data.decode()

    def put_node_settings(self, identity, body):
        status, current = self.admin_call("GET", "/v1/settings/node:" + identity)
        headers = {"If-Match": str(current["revision"])} if status == 200 and current.get("revision") else None
        status, document = self.admin_call("PUT", "/v1/settings/node:" + identity, body, headers)
        self.assertEqual(status, 200, document)

    def register(self, node, slot="slot-1", target="fleet-controller/unassigned", **options):
        label = options.pop("label", "r%d" % int(time.monotonic() * 1000))
        return run_runner_control(node, self.controller, self.tools, slot, target, label=label, **options)

    def register_until_ok(self, node, seconds=40, **options):
        """Retry as the node's unit does (exit 75 means retry) until the controller serves again."""
        deadline = time.monotonic() + seconds
        while True:
            done = self.register(node, **options)
            if done.returncode == 0 or time.monotonic() > deadline:
                return done
            self.assertEqual(done.returncode, 75, done.text)
            time.sleep(2)

    def fresh_github_client(self):
        """Saving the integration with a never used installation id makes the controller build a
        new GitHub client on its next call: no token, no open circuit, no remembered refusal."""
        self.github.installation_id = str(int(self.github.installation_id) + 1)
        status, data = self.admin_call("PUT", "/v1/github/integration", {
            "scope": "repository", "repositories": self.repositories,
            "appId": self.github.app_id, "installationId": self.github.installation_id,
        })
        self.assertEqual(status, 200, data)

    def audit(self, node_id, action):
        _status, document = self.admin_call("GET", "/v1/audit?target=" + node_id + "&limit=200")
        return [entry for entry in document["entries"] if entry["action"] == action]

    def assert_nothing_leaked(self, text):
        leaked = [self.pem.splitlines()[1][:30], "eyJ", self.enroll_token, *self.github.installation_tokens,
                  *self.github.registration_tokens]
        for secret in leaked:
            self.assertNotIn(secret, text)

    def files_of(self, node):
        found = []
        for path in node.root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                try:
                    found.append((path, path.read_text(errors="ignore")))
                except OSError:
                    continue
        return found

    # ---- scenarios --------------------------------------------------------------

    def test_01_node_gets_a_registration_token_through_the_controller_alone(self):
        identity, node = self.enroll()
        view = next(n for n in self.admin_call("GET", "/v1/nodes")[1]["nodes"] if n["id"] == identity)
        self.assertEqual((view["status"], view["role"]), ("online", "ci"))
        # The next heartbeat delivers desired state: the integration's repositories reach slot assignments.
        again = node.agent(self.controller, "once")
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        # (Placement may narrow the integration's list to some of its repositories.)
        assigned = self.assigned_repository(node)
        self.assertIn(assigned, self.repositories)

        before = self.github.mark()
        done = self.register(node, "slot-1", label="happy")
        self.assertEqual(done.returncode, 0, done.text)
        self.assertEqual(done.stdout, "")
        self.assertEqual(done.sleeps, [])
        token = done.output.read_text()
        self.assertEqual(token, self.github.registration_tokens[-1])
        self.assertEqual(stat.S_IMODE(done.output.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(done.output.parent.stat().st_mode), 0o700)
        slot_one = (node.root / "run/fleet/assign/slot-1").read_text().strip()
        self.assertEqual(done.used_file.read_text().strip(), slot_one, "the controller chose what the node was told")
        self.assertIn(slot_one, self.repositories)
        self.assertEqual(done.recorded_status()["exit"], 0)
        self.assertNotIn(token, done.text)

        # GitHub saw: at most one App-JWT token mint in total (the controller caches it),
        # exactly one registration token, and the registration call used the installation token.
        self.assertEqual(self.github.count("access-token"), 1)
        self.assertEqual(self.github.bad_jwts, 0, "the controller signed with the App key")
        registrations = self.github.since(before, "registration-token")
        self.assertEqual(len(registrations), 1)
        self.assertTrue(registrations[0]["bearer_is_installation"])
        self.assertFalse(registrations[0]["bearer_is_jwt"])
        self.assertEqual(registrations[0]["path"], "/repos/%s/actions/runners/registration-token" % slot_one)

        # The node never held the App key (or any token): not in its environment, not in a file.
        self.assertNotIn("FLEET_GITHUB_APP_PRIVATE_KEY", os.environ)
        for path, text in self.files_of(node):
            if path != done.output:
                self.assertNotIn("PRIVATE KEY", text, path)
                self.assertNotIn(token, text, path)
        # The audit trail names the node and never the token; the controller log neither.
        [entry] = self.audit(identity, "runner.registration")
        self.assertEqual((entry["outcome"], entry["actor"]), ("success", "node:" + identity[:8]))
        self.assertNotIn(token, json.dumps(entry))
        output = "".join(self.stack.output)
        for secret in (token, self.pem.splitlines()[1][:30], *self.github.installation_tokens):
            self.assertNotIn(secret, output)

    def test_02_concurrent_registrations_for_one_slot_share_one_github_call(self):
        _identity, node = self.enroll()
        node.agent(self.controller, "once")
        self.fresh_github_client()
        self.github.registration_delay = 1.0
        before = self.github.mark()
        with ThreadPoolExecutor(3) as pool:
            runs = list(pool.map(lambda n: self.register(node, "slot-1", label="same-%d" % n), range(3)))
        self.assertEqual([done.returncode for done in runs], [0, 0, 0], [done.text for done in runs])
        self.assertEqual(len(self.github.since(before, "registration-token")), 1, "duplicate registrations were not coalesced")
        self.assertEqual(len({done.output.read_text() for done in runs}), 1)
        # Another slot is its own registration.
        other = self.register(node, "slot-2", label="other")
        self.assertEqual(other.returncode, 0, other.text)
        self.assertEqual(len(self.github.since(before, "registration-token")), 2)
        self.assertNotEqual(other.output.read_text(), runs[0].output.read_text())

    def test_03_refusals_never_reach_github(self):
        before = self.github.mark()
        identity, node = self.enroll()
        node.agent(self.controller, "once")

        # A repository the node was not assigned.
        done = self.register(node, "slot-1", "evil/other", label="unassigned")
        self.assertEqual(done.returncode, 78, done.text)
        self.assertIn("repository_not_assigned", done.stderr)
        self.assertFalse(done.output.exists())
        self.assertEqual(done.recorded_status()["code"], "repository_not_assigned")
        self.assertEqual(done.sleeps, [], "a refusal is not retried")

        # Cordoned: admission is closed until a person reopens it.
        self.put_node_settings(identity, {"runners": {"cordoned": True}})
        done = self.register(node, "slot-1", label="cordoned")
        self.assertEqual(done.returncode, 78, done.text)
        self.assertIn("runners_drained", done.stderr)
        self.assertFalse(done.output.exists())
        self.put_node_settings(identity, {})
        reopened = self.register(node, "slot-1", label="reopened")
        self.assertEqual(reopened.returncode, 0, reopened.text)

        # A role that runs no runners.
        status, data = self.admin_call("PATCH", "/v1/nodes/" + identity, {"role": "devbox"})
        self.assertEqual(status, 200, data)
        done = self.register(node, "slot-1", label="devbox")
        self.assertEqual((done.returncode, done.recorded_status()["code"]), (78, "role_runs_no_runners"), done.text)
        self.admin_call("PATCH", "/v1/nodes/" + identity, {"role": "ci"})

        # A node that was never approved, then one whose credential is revoked, then a made-up one.
        _waiting_id, waiting = self.enroll(with_token=False)
        done = self.register(waiting, "slot-1", label="pending")
        self.assertEqual(done.returncode, 78, done.text)
        self.assertFalse(done.output.exists())
        status, data = self.admin_call("POST", "/v1/nodes/%s/revoke-credential" % identity, {"confirm": node.hostname})
        self.assertEqual(status, 200, data)
        done = self.register(node, "slot-1", label="revoked")
        self.assertEqual((done.returncode, done.recorded_status()["code"]), (78, "FLEET_CONTROLLER_AUTH"), done.text)
        (node.state / "node.secret").write_text("ee" * 32 + "\n")
        done = self.register(node, "slot-1", label="forged")
        self.assertEqual((done.returncode, done.recorded_status()["code"]), (78, "FLEET_CONTROLLER_AUTH"), done.text)
        self.assertNotIn("ee" * 32, done.text)

        # Exactly one registration token was ever minted: the reopened node's.
        self.assertEqual(len(self.github.since(before, "registration-token")), 1)
        denied = [e for e in self.audit(identity, "runner.registration") if e["outcome"] == "denied"]
        self.assertGreaterEqual(len(denied), 3, denied)

    def test_04_throttling_is_absorbed_or_reported_as_retry_later(self):
        _identity, node = self.enroll()
        node.agent(self.controller, "once")
        self.fresh_github_client()
        # Two 429s with Retry-After: 1, then success: the controller waits as told and the node never notices.
        self.github.fail("registration-token", 429, {"Retry-After": "1"}, times=2)
        before, started = self.github.mark(), time.monotonic()
        done = self.register(node, "slot-1", label="throttled-once")
        self.assertEqual(done.returncode, 0, done.text)
        self.assertGreaterEqual(time.monotonic() - started, 1.8, "Retry-After was not honoured")
        self.assertEqual(len(self.github.since(before, "registration-token")), 3)
        # A long Retry-After is not slept by the controller: the node is told to come back (exit 75).
        self.github.clear()
        self.fresh_github_client()
        self.github.fail("registration-token", 429, {"Retry-After": "120"})
        before = self.github.mark()
        done = self.register(node, "slot-1", label="throttled-long")
        self.assertEqual(done.returncode, 75, done.text)
        self.assertIn("FLEET_GITHUB_UNAVAILABLE", done.stderr)
        self.assertFalse(done.output.exists())
        self.assertEqual(done.sleeps, [10, 10], "the node waits at most its cap between attempts and tries 3 times")
        self.assertEqual(len(self.github.since(before, "registration-token")), 1, "the open circuit shields GitHub")
        self.assert_nothing_leaked(done.text)
        self.fresh_github_client()

    def test_05_github_outage_is_retried_by_the_node_and_recovers(self):
        _identity, node = self.enroll()
        node.agent(self.controller, "once")
        self.fresh_github_client()
        self.github.fail("registration-token", 503)
        before = self.github.mark()
        done = self.register(node, "slot-1", label="outage")
        self.assertEqual(done.returncode, 75, done.text)
        self.assertIn("FLEET_GITHUB_UNAVAILABLE", done.stderr)
        self.assertFalse(done.output.exists(), "no token file after a failed attempt")
        self.assertEqual(done.recorded_status()["exit"], 75)
        self.assertEqual(len(done.sleeps), 2, "three attempts, two waits")
        # 3 node attempts x 4 transport tries is the hard ceiling; the circuit normally stops sooner.
        self.assertLessEqual(len(self.github.since(before, "registration-token")), 12)
        self.assert_nothing_leaked(done.text)

        self.github.clear()
        recovered = self.register_until_ok(node, slot="slot-1", label="recovered")
        self.assertEqual(recovered.returncode, 0, recovered.text)
        self.assertEqual(recovered.output.read_text(), self.github.registration_tokens[-1])
        self.assertEqual(stat.S_IMODE(recovered.output.stat().st_mode), 0o600)
        self.assertEqual(recovered.recorded_status()["exit"], 0)

    def test_06_a_permanent_github_refusal_is_not_retried_and_names_what_to_fix(self):
        identity, node = self.enroll()
        node.agent(self.controller, "once")
        self.fresh_github_client()
        for status, code in ((404, "FLEET_GITHUB_SCOPE"), (403, "FLEET_GITHUB_SCOPE"), (401, "FLEET_GITHUB_KEY")):
            self.github.clear()
            self.github.fail("registration-token", status)
            before = self.github.mark()
            done = self.register(node, "slot-1", label="refused-%d" % status)
            self.assertEqual(done.returncode, 78, done.text)
            self.assertIn(code, done.stderr)
            self.assertEqual(done.recorded_status()["code"], code)
            self.assertEqual(done.sleeps, [], "a refusal needs a person, not a retry")
            self.assertFalse(done.output.exists())
            self.assert_nothing_leaked(done.text + json.dumps(done.recorded_status()))
            self.assertNotIn("injected failure", done.text, "GitHub's own message is never relayed")
            calls = self.github.since(before, "registration-token")
            self.assertEqual(len(calls), 2 if status == 401 else 1, "a 401 re-mints the installation token once")
        # The App key or installation itself refused at the token mint.
        for status, code in ((401, "FLEET_GITHUB_KEY"), (404, "FLEET_GITHUB_SCOPE")):
            self.github.clear()
            self.fresh_github_client()
            self.github.fail("access-token", status)
            done = self.register(node, "slot-1", label="mint-%d" % status)
            self.assertEqual((done.returncode, done.recorded_status()["code"]), (78, code), done.text)
            self.assertEqual(done.sleeps, [])
            self.assert_nothing_leaked(done.text)
        self.github.clear()
        self.fresh_github_client()
        healed = self.register(node, "slot-1", label="healed")
        self.assertEqual(healed.returncode, 0, healed.text)
        failed = [e for e in self.audit(identity, "runner.registration") if e["outcome"] == "failed"]
        self.assertGreaterEqual(len(failed), 5)
        self.assertNotIn("ghs_", json.dumps(failed))

    # ---- version skew -------------------------------------------------------------

    def test_07_an_old_agent_that_knows_nothing_of_the_new_fields_still_works(self):
        identity = machine_id("runner-chain-old-agent")
        secret = secrets.token_hex(32)
        status, data, _ = http("POST", self.controller + "/v1/nodes/register", None, {
            # What a v2-era agent sent: it named a role and a role token, both ignored now.
            "nodeId": identity, "hostname": "old-" + identity[:4], "secret": secret,
            "role": "ci", "roleToken": "legacy-role-token", "enrollmentToken": self.enroll_token,
        })
        self.assertIn(status, (200, 201, 202), data)
        credential = identity + "." + secret
        bare = {"v": 2, "nodeId": identity, "role": "ci", "closure": "ci", "hostname": "old-" + identity[:4],
                "agent": {"version": "2"}}
        status, data, _ = http("POST", self.controller + "/v1/heartbeat", credential, bare)
        self.assertEqual(status, 200, data)
        document = jsonbody(data)
        self.assertEqual(document["status"], "approved")
        self.assertEqual(document["desired"]["role"], "ci")
        self.assertNotIn("credential", document, "no rotation hint unless one was requested")
        # Unknown newer keys and a missing telemetry block are both fine; a future version is a clear 400.
        status, _data, _ = http("POST", self.controller + "/v1/heartbeat", credential, {**bare, "futureField": {"x": 1}})
        self.assertEqual(status, 200)
        status, data, _ = http("POST", self.controller + "/v1/heartbeat", credential, {**bare, "v": 3})
        self.assertEqual((status, jsonbody(data)["error"]), (400, "unsupported_version"))
        view = next(n for n in self.admin_call("GET", "/v1/nodes")[1]["nodes"] if n["id"] == identity)
        self.assertEqual((view["status"], view["role"]), ("online", "ci"))
        self.assertNotIn("legacy-role-token", json.dumps(view))
        self.assertNotIn(secret, json.dumps(view))

    def test_08_a_node_that_still_has_the_app_key_registers_directly_as_before(self):
        identity, node = self.enroll()
        node.agent(self.controller, "once")
        repository = self.assigned_repository(node)
        key_path = node.root / "run/secrets/github-app-key"
        key_path.parent.mkdir(parents=True)
        key_path.write_text(self.pem)
        key_path.chmod(0o600)
        self.fresh_github_client()
        before, audits = self.github.mark(), len(self.audit(identity, "runner.registration"))
        done = self.register(node, "slot-1", repository, label="legacy", key_path=key_path, app=self.github.app_id,
                             installation=self.github.installation_id, github_redirect=self.github.url)
        self.assertEqual(done.returncode, 0, done.text)
        self.assertEqual(done.output.read_text(), self.github.registration_tokens[-1])
        self.assertEqual(stat.S_IMODE(done.output.stat().st_mode), 0o600)
        mints = self.github.since(before, "access-token")
        self.assertEqual(len(mints), 1)
        self.assertTrue(mints[0]["bearer_is_jwt"], "the node signed its own App JWT")
        self.assertEqual(self.github.bad_jwts, 0)
        self.assertEqual(len(self.audit(identity, "runner.registration")), audits, "the controller was not asked")
        # Without the key file the same node goes through the controller.
        key_path.unlink()
        through = self.register(node, "slot-1", repository, label="no-key", key_path=key_path, app=self.github.app_id,
                                installation=self.github.installation_id, github_redirect=self.github.url)
        self.assertEqual(through.returncode, 0, through.text)
        self.assertEqual(len(self.audit(identity, "runner.registration")), audits + 1)


if __name__ == "__main__":
    unittest.main()
