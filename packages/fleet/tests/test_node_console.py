#!/usr/bin/env python3
"""An installed node's console says whether it is ready, why not, and how to report it."""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path

FLEET = Path(__file__).resolve().parents[1]
SCRIPT = FLEET / "scripts" / "node_console.py"
# Assembled at runtime: shaped like a GitHub token for redaction, never a real one.
SECRET = "gh" + "s_" + "A" * 36


def executable(path, body):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class NodeConsoleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        tools = self.root / "bin"
        tools.mkdir()
        executable(tools / "ip", '#!/bin/sh\ncase "$*" in\n'
                   '  "route show default") [ -e "$FLEET_TEST/offline" ] || echo "default via 192.0.2.1 dev wlp1s0";;\n'
                   '  *brief*) echo "wlp1s0  UP  192.0.2.20/24";;\nesac\n')
        executable(tools / "systemctl", '#!/bin/sh\ncase "$1" in\n'
                   '  show) for u in "$@"; do case "$u" in github-runner-*) s=active; r=0;'
                   ' [ "$u" = github-runner-slot-2.service ] && [ -e "$FLEET_TEST/slot2-down" ] && s=activating && r=6;'
                   ' printf "Id=%s\\nActiveState=%s\\nNRestarts=%s\\n\\n" "$u" "$s" "$r";; esac; done;;\n'
                   '  is-active) echo active;;\nesac\n')
        executable(tools / "journalctl", f'#!/bin/sh\necho "Registering runner with token {SECRET}"\n'
                   'echo "Http response code: NotFound from POST https://api.github.com/actions/runner-registration"\n')
        executable(tools / "ssh-keygen", '#!/bin/sh\necho "256 SHA256:fixturefingerprint root@ci-a3f9 (ED25519)"\n')
        executable(tools / "qrencode", f'#!/bin/sh\nfor last; do :; done\nprintf "%s\\n" "$last" >> {self.root / "urls"}\n'
                   'printf "\\033[47mQR\\033[0m\\n"\n')
        for folder in ("state/agent", "state/sync", "state/secrets", "state/logs", "run/register", "etc", "proc", "sys/class/net/wlp1s0/wireless"):
            (self.root / folder).mkdir(parents=True)
        (self.root / "run/node").write_text("role=ci\nhostname=ci-a3f9\n")
        (self.root / "run/slot-count").write_text("2\n")
        (self.root / "etc/revision").write_text("c839ee07aabbccddeeff00112233445566778899\n")
        (self.root / "etc/bootstrap.json").write_text(json.dumps({"version": 1, "github": {"scope": "repository"}}))
        (self.root / "state/sync/last-success").write_text("c839ee07aabbccddeeff00112233445566778899\n")
        (self.root / "state/secrets/age.pub").write_text("age1fixturepublickey\n")
        (self.root / "state/logs/install.log").write_text(
            "2026-10-26T16:00:00Z handoff from=windows wizard=1a2b3c4 attempt=0123456789abcdef wifi=sent\n")
        self.uptime(1500)
        self.agent([])
        self.env = {**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}", "FLEET_TEST": str(self.root),
                    "FLEET_STATE": str(self.root / "state"), "FLEET_RUN": str(self.root / "run"), "FLEET_ETC": str(self.root / "etc"),
                    "FLEET_PROC": str(self.root / "proc"), "FLEET_SYS": str(self.root / "sys"),
                    "FLEET_CONSOLE": str(self.root / "console"), "FLEET_CONSOLE_SIZE": "240x67"}

    def tearDown(self):
        self.tmp.cleanup()

    def uptime(self, seconds):
        (self.root / "proc/uptime").write_text(f"{seconds} 1\n")

    def agent(self, readiness, reported=0, **changes):
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - reported))
        (self.root / "state/agent/status.json").write_text(json.dumps(
            {"outcome": "ok", "approval": "approved", "lastSuccessAt": stamp, "failures": 0, "lastError": None,
             "readiness": readiness, **changes}))

    def node(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *args], capture_output=True, text=True, env=self.env, timeout=30)

    def drawn(self):
        self.node("once")
        return " ".join(re.sub(r"\033\[[0-9;]*m", "", (self.root / "console").read_text()).split())

    def test_ready_says_so_and_offers_no_report(self):
        result = self.node("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        screen = " ".join(result.stdout.split())
        self.assertIn("STATUS READY. 2 runners online in GitHub. Nothing to do.", screen)
        self.assertIn("[x] GitHub runners 2 of 2 online in GitHub", screen)
        self.assertIn("[x] Network 192.0.2.20 on wlp1s0 (Wi-Fi)", screen)
        self.assertIn("SHA256:fixturefingerprint", screen)
        self.assertNotIn("Report:", result.stdout)
        self.assertNotIn("QR", self.drawn())

    def test_a_new_node_is_starting_until_patience_runs_out_then_says_it_is_not_certain(self):
        (self.root / "slot2-down").touch()
        self.agent(["FLEET_RUNNERS_STARTING: 1 of 2 runner services are active."])
        self.uptime(120)
        screen = self.drawn()
        self.assertIn("STATUS STARTING. 1 of 2 runner services are active.", screen)
        self.assertIn("Nothing to do yet", screen)
        self.assertNotIn("QR", screen)
        self.uptime(3600)
        screen = self.drawn()
        self.assertIn("STATUS PROBLEM. Still not ready after 60 min 0 s.", screen)
        self.assertIn("this screen cannot tell whether it will", screen)
        self.assertIn("QR", screen)

    def test_a_refused_registration_is_a_problem_at_once_with_a_redacted_report(self):
        (self.root / "slot2-down").touch()
        (self.root / "run/register/slot-2.json").write_text(json.dumps(
            {"code": "FLEET_GITHUB_SCOPE", "message": "GitHub answered HTTP 404 for the runner target", "exit": 78}))
        self.agent(["FLEET_RUNNERS_STARTING: 1 of 2 runner services are active."])
        self.uptime(60)
        screen = self.drawn()
        self.assertIn("STATUS PROBLEM. Runner slot-2 cannot register with GitHub: GitHub answered HTTP 404", screen)
        self.assertIn("[!] GitHub runners slot-2: FLEET_GITHUB_SCOPE", screen)
        self.assertIn("The repository owner checks the GitHub App installation", screen)
        url = (self.root / "urls").read_text().splitlines()[-1]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(query["title"], ["Fleet node console: FLEET_GITHUB_SCOPE (ci)"])
        report = query["diagnostic"][0]
        self.assertIn("slot-2 activating restarts=6 register=FLEET_GITHUB_SCOPE exit=78", report)
        self.assertIn("installed ", report)
        self.assertIn("attempt=0123456789abcdef", report)
        self.assertIn("journal github-runner-slot-2.service", report)
        self.assertNotIn(SECRET, url)
        self.assertNotIn("192.0.2.20", url)
        status = self.node("status")
        self.assertEqual(status.returncode, 1)
        self.assertIn("Report: https://github.com/", status.stdout)

    def test_no_network_and_a_silent_agent_are_named(self):
        (self.root / "offline").touch()
        self.agent([], reported=3600, lastError="API unreachable (timed out)")
        screen = self.drawn()
        self.assertIn("STATUS PROBLEM. Still not ready after 25 min 0 s. This node has no network connection", screen)
        self.assertIn("[!] Network no connection", screen)
        self.assertIn("[!] Fleet last report failed: API unreachable", screen)

    def test_failed_service_prerequisite_names_the_git_managed_repair(self):
        self.agent(['FLEET_RUNNER_PREREQUISITE_FAILED: runner slot-1 failed gh discovery/execution inside its service environment.'])
        screen = self.drawn()
        self.assertIn('STATUS PROBLEM', screen)
        self.assertIn('repairs the CI closure through Git', screen)

    def test_without_an_agent_report_readiness_stays_unknown(self):
        (self.root / "state/agent/status.json").unlink()
        executable(self.root / "bin/systemctl", '#!/bin/sh\n[ "$1" = is-active ] && echo inactive\nexit 0\n')
        screen = self.drawn()
        self.assertIn("STATUS UNKNOWN. The Fleet agent is not running here, so readiness cannot be confirmed", screen)
        self.assertNotIn("READY", screen)

    def test_a_quarantined_kernel_is_a_problem_at_once_and_says_what_to_do(self):
        (self.root / "state/sync/quarantine.json").write_text(json.dumps(
            {"toplevel": "/nix/store/x", "revision": "c839ee07", "boot": "k i m", "reason": "The cause is not certain.",
             "at": "2026-10-26T10:00:00Z", "atEpoch": 1}))
        self.uptime(60)
        screen = self.drawn()
        self.assertIn("STATUS PROBLEM. A kernel update did not boot healthily", screen)
        self.assertIn("[!] Recovery a kernel update is quarantined", screen)
        self.assertIn("press Retry the update on the node's page in Fleet", screen)

    def test_the_console_unit_owns_tty1_and_replaces_the_one_shot_info(self):
        nix = (FLEET / "modules/console.nix").read_text()
        self.assertIn('systemd.services."getty@tty1".enable = false;', nix)
        self.assertIn("fleet-node-console watch", nix)
        self.assertIn("./console.nix", (FLEET / "modules/base.nix").read_text())
        self.assertNotIn("fleet-console-info", (FLEET / "modules/base.nix").read_text())
        tools = (FLEET / "modules/fleet-tools.nix").read_text()
        for name in ("node_console.py", "live_console.py", "decide.py"):
            self.assertIn(name, tools)


if __name__ == "__main__":
    unittest.main()
