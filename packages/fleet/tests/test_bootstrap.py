#!/usr/bin/env python3
"""Remote bootstrap only forwards a keyboard. It does not build or read keys."""

import os
import pty
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "bootstrap.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "ssh"
        write_executable(self.bin / "ssh", f"""\
            #!/bin/bash
            printf '%s\\n' "$*" > {self.log}
            """)
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.bin}:{os.environ.get('PATH', '')}"

    def tearDown(self):
        self.tmp.cleanup()

    def test_non_tty_points_at_the_machine(self):
        result = subprocess.run(
            [str(SCRIPT), "ci", "192.0.2.10"],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("fleet-install ci", result.stderr)
        self.assertFalse(self.log.exists())

    def test_tty_sshs_fleet_install(self):
        master, slave = pty.openpty()
        proc = subprocess.Popen(
            [str(SCRIPT), "devbox", "192.0.2.10"],
            stdin=slave,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        )
        os.close(slave)
        try:
            _out, err = proc.communicate(timeout=15)
        finally:
            os.close(master)
        self.assertEqual(proc.returncode, 0, err.decode())
        command = self.log.read_text()
        self.assertIn("root@192.0.2.10", command)
        self.assertIn("fleet-install devbox", command)
        self.assertNotIn("nix", command)
        self.assertNotIn("age", command)

    def test_gpu_is_rejected_locally(self):
        result = subprocess.run(
            [str(SCRIPT), "ci-gpu", "192.0.2.10"],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())
