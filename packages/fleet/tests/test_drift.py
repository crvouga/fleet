#!/usr/bin/env python3
"""fleet-drift classifies lag against origin/main and does not build."""

import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import importlib.util

spec = importlib.util.spec_from_file_location("drift", Path(__file__).parents[1] / "scripts" / "drift.py")
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
        self.main = "a" * 40

    def test_equal_revisions_are_ok(self):
        committed = self.now - timedelta(hours=5)
        self.assertEqual(drift.classify(self.main, self.main, committed, self.now, 30), "ok")

    def test_a_fresh_main_is_inside_the_grace_window(self):
        committed = self.now - timedelta(minutes=10)
        self.assertEqual(drift.classify("b" * 40, self.main, committed, self.now, 30), "within-grace")

    def test_an_old_main_is_behind(self):
        committed = self.now - timedelta(minutes=30)
        self.assertEqual(drift.classify("b" * 40, self.main, committed, self.now, 30), "behind")

    def test_unknown_revision_is_not_reporting(self):
        self.assertEqual(drift.classify("unknown", self.main, self.now, self.now, 30), "not-reporting")
        self.assertEqual(drift.classify("", self.main, self.now, self.now, 30), "not-reporting")


class DriftCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.origin = self.root / "origin"
        self.origin.mkdir()
        self.revision = self.root / "revision"
        self.env = os.environ.copy()
        self._git(["init", "-b", "main", str(self.origin)])
        self._git(["-C", str(self.origin), "config", "user.email", "test@example.invalid"])
        self._git(["-C", str(self.origin), "config", "user.name", "test"])
        self.env.update({
            "REPO_URL": f"file://{self.origin}",
            "BRANCH": "main",
            "REVISION_FILE": str(self.revision),
            "MAX_MINUTES": "30",
            "STATE_DIR": str(self.root / "state"),
        })

    def tearDown(self):
        self.tmp.cleanup()

    def test_unconfigured_repository_does_not_fail(self):
        self.env["REPO_URL"] = "https://github.com/TODO/workspace.git"
        result = self.run_drift()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not configured", result.stdout)

    def test_matching_revision_is_ok(self):
        sha = self.commit(minutes_ago=90)
        self.revision.write_text(sha + "\n")
        result = self.run_drift()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ok")

    def test_recent_main_waits(self):
        self.commit(minutes_ago=5)
        self.revision.write_text("0" * 40 + "\n")
        result = self.run_drift()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "within-grace")

    def test_stale_node_fails(self):
        self.commit(minutes_ago=90)
        self.revision.write_text("unknown\n")
        missing = self.run_drift()
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing.stdout.strip(), "not-reporting")
        self.revision.write_text("0" * 40 + "\n")
        behind = self.run_drift()
        self.assertNotEqual(behind.returncode, 0)
        self.assertEqual(behind.stdout.strip(), "behind")

    def commit(self, minutes_ago):
        when = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%S%z")
        (self.origin / "marker").write_text(when + "\n")
        env = self.env.copy()
        env["GIT_AUTHOR_DATE"] = when
        env["GIT_COMMITTER_DATE"] = when
        self._git(["-C", str(self.origin), "add", "marker"], env=env)
        self._git(["-C", str(self.origin), "commit", "-m", "marker"], env=env)
        return self._git(["-C", str(self.origin), "rev-parse", "HEAD"]).stdout.strip()

    def run_drift(self):
        return subprocess.run(
            ["python3", str(Path(__file__).parents[1] / "scripts" / "drift.py")],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def _git(self, args, env=None):
        return subprocess.run(["git", *args], check=True, text=True, capture_output=True, env=env or self.env)


if __name__ == "__main__":
    unittest.main()
