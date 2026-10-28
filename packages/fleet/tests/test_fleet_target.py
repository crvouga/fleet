#!/usr/bin/env python3
"""fleet-target: the desired state of a node without a controller, refused when one is configured."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fleet_target.py"


class FleetTargetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = self.root / "systemctl-calls"
        systemctl = self.root / "systemctl"
        systemctl.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> {self.calls}\n')
        systemctl.chmod(systemctl.stat().st_mode | stat.S_IEXEC)
        (self.root / "node.conf").write_text("role=ci\nflake_attr=ci\nslot_max=8\n")
        self.target = self.root / "state/target"
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("FLEET_")}
        self.env.update({"FLEET_STATE": str(self.root / "state"), "FLEET_NODE_CONF": str(self.root / "node.conf"),
                         "FLEET_RECONCILE": str(self.root / "reconcile.json"), "FLEET_SYSTEMCTL": str(systemctl),
                         "FLEET_API_URL": ""})

    def tearDown(self):
        self.tmp.cleanup()

    def run_target(self, *args, url=""):
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True,
                              env={**self.env, "FLEET_API_URL": url}, timeout=30, check=False)

    def started(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_managed_mode_refuses_set_and_clear_and_changes_nothing(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_text("role=ci\nclosure=ci\n")
        for args in (("set", "devbox"), ("set", "base"), ("clear",)):
            with self.subTest(args=args):
                done = self.run_target(*args, url="https://fleet.example.test")
                self.assertEqual(done.returncode, 1)
                self.assertIn("managed by the fleet controller", done.stderr)
                self.assertEqual(self.target.read_text(), "role=ci\nclosure=ci\n")
        self.assertEqual(self.started(), [])
        shown = self.run_target("show", url="https://fleet.example.test")
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertIn("mode: managed", shown.stdout)

    def test_a_todo_address_is_local_mode(self):
        done = self.run_target("set", "devbox", url="https://TODO.example")
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_local_mode_writes_the_target_atomically_and_starts_sync_without_waiting(self):
        done = self.run_target("set", "devbox")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.target.read_text(), "role=devbox\nclosure=devbox\n")
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.started(), ["start --no-block fleet-sync.service"])
        self.assertEqual(self.run_target("set", "ci", "ci-gpu").returncode, 0)
        self.assertEqual(self.target.read_text(), "role=ci\nclosure=ci-gpu\n")
        self.assertEqual(self.run_target("set", "base").returncode, 0)
        self.assertEqual(self.target.read_text(), "role=base\nclosure=base\n")
        self.assertEqual([entry.name for entry in self.target.parent.iterdir()], ["target"])

    def test_only_active_roles_and_their_own_closures_are_accepted(self):
        for args in (("set", "web"), ("set", "ci", "devbox"), ("set", "ci", "base"), ("set", "base", "ci"),
                     ("set", "../etc"), ("set", "ci", "ci-../x"), ("set",), ("bogus",)):
            with self.subTest(args=args):
                done = self.run_target(*args)
                self.assertEqual(done.returncode, 2, done.stderr)
                self.assertFalse(self.target.exists())
        self.assertEqual(self.started(), [])

    def test_clear_returns_to_the_image_role_and_show_reports_progress(self):
        self.run_target("set", "devbox")
        (self.root / "reconcile.json").write_text(json.dumps(
            {"phase": "blocked", "issues": ["FLEET_SECRETS_RECIPIENT_MISSING: age1x is not a recipient"],
             "at": "2026-10-27T00:00:00Z"}))
        shown = self.run_target("show")
        self.assertIn("mode: local", shown.stdout)
        self.assertIn("running: ci (ci)", shown.stdout)
        self.assertIn("target: devbox (devbox)", shown.stdout)
        self.assertIn("convergence: blocked at 2026-10-27T00:00:00Z", shown.stdout)
        self.assertIn("FLEET_SECRETS_RECIPIENT_MISSING", shown.stdout)
        done = self.run_target("clear")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(self.target.exists())
        self.assertIn("target: none", self.run_target("show").stdout)
        self.assertEqual(self.run_target("clear").returncode, 0, "clearing twice is fine")


if __name__ == "__main__":
    unittest.main()
