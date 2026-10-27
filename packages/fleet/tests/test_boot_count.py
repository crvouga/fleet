#!/usr/bin/env python3
"""The newest systemd-boot entry gets a tries-left count. Older ones stay."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "boot-count.sh"


class BootCountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.esp = Path(self.tmp.name)
        self.entries = self.esp / "loader" / "entries"
        self.entries.mkdir(parents=True)
        (self.entries / "nixos-generation-1.conf").write_text("title old\n")
        (self.entries / "nixos-generation-1+0-3.conf").write_text("title old-bad\n")
        (self.entries / "nixos-generation-2.conf").write_text("title new\n")
        (self.esp / "loader" / "loader.conf").write_text(
            "timeout 5\ndefault nixos-generation-2.conf\neditor 0\n"
        )
        self.env = os.environ.copy()
        self.env["FLEET_ESP"] = str(self.esp)
        self.env["FLEET_BOOT_TRIES"] = "3"

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self):
        return subprocess.run(
            ["bash", str(SCRIPT)],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_only_the_default_generation_is_counted(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.entries / "nixos-generation-2.conf").exists())
        marked = (self.entries / "nixos-generation-2+3.conf").read_text()
        self.assertEqual(marked, "title new\n")
        self.assertEqual((self.entries / "nixos-generation-1.conf").read_text(), "title old\n")
        self.assertTrue((self.entries / "nixos-generation-1+0-3.conf").exists())
        loader = (self.esp / "loader" / "loader.conf").read_text()
        self.assertIn("default nixos-generation-2+3.conf\n", loader)
        self.assertIn("timeout 5\n", loader)

    def test_running_again_keeps_one_counter(self):
        self.assertEqual(self.run_script().returncode, 0)
        again = self.run_script()
        self.assertEqual(again.returncode, 0, again.stderr)
        counted = list(self.entries.glob("nixos-generation-2*"))
        self.assertEqual([path.name for path in counted], ["nixos-generation-2+3.conf"])

    def test_missing_loader_fails(self):
        (self.esp / "loader" / "loader.conf").unlink()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing", result.stderr)


if __name__ == "__main__":
    unittest.main()
