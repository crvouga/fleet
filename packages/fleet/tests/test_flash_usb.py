#!/usr/bin/env python3
"""flash-usb confirms the disk on Linux and macOS and writes only that disk."""

import os
import pty
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "flash-usb.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class FlashUsbTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.iso = self.root / "fleet-installer.iso"
        self.iso.write_bytes(b"iso")
        self.log = self.root / "actions"
        write_executable(self.bin / "sudo", f"""\
            #!/bin/bash
            printf 'sudo %s\\n' "$*" >> {self.log}
            """)
        write_executable(self.bin / "sync", f"""\
            #!/bin/bash
            printf 'sync\\n' >> {self.log}
            """)
        write_executable(self.bin / "readlink", f"""\
            #!/bin/bash
            printf '/dev/sdb\\n'
            """)
        write_executable(self.bin / "lsblk", f"""\
            #!/bin/bash
            if [ "$1" = "-dn" ]; then
              if [ "$3" = "TYPE" ]; then echo disk; else echo usb; fi
              exit 0
            fi
            if [ "$1" = "-nr" ]; then
              exit 0
            fi
            printf 'lsblk %s\\n' "$*" >> {self.log}
            """)
        write_executable(self.bin / "diskutil", f"""\
            #!/bin/bash
            printf 'diskutil %s\\n' "$*" >> {self.log}
            if [ "$1" = "info" ]; then
              printf 'Protocol:                  USB\\n'
              printf 'Internal:                  No\\n'
              printf 'Whole:                     Yes\\n'
            fi
            """)
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.bin}:/usr/bin:/bin"

    def tearDown(self):
        self.tmp.cleanup()

    def run_tty(self, args, typed):
        master, slave = pty.openpty()
        proc = subprocess.Popen(
            [str(SCRIPT), *args],
            stdin=slave,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        )
        os.close(slave)
        os.write(master, typed.encode())
        try:
            out, err = proc.communicate(timeout=15)
        finally:
            os.close(master)
        return proc.returncode, out.decode(), err.decode()

    def test_linux_writes_the_confirmed_usb_disk(self):
        self.env["FLEET_OS"] = "Linux"
        device = "/dev/disk/by-id/usb-example"
        code, _out, err = self.run_tty([str(self.iso), device], device + "\n")
        self.assertEqual(code, 0, err)
        log = self.log.read_text()
        self.assertIn("sudo dd ", log)
        self.assertIn("of=/dev/sdb", log)
        self.assertIn("bs=4M", log)

    def test_linux_rejects_a_mismatched_confirmation(self):
        self.env["FLEET_OS"] = "Linux"
        device = "/dev/disk/by-id/usb-example"
        code, _out, err = self.run_tty([str(self.iso), device], "/dev/sdb\n")
        self.assertEqual(code, 1)
        self.assertIn("did not match", err)
        self.assertFalse(self.log.exists() and "sudo dd" in self.log.read_text())

    def test_darwin_writes_the_raw_external_disk(self):
        self.env["FLEET_OS"] = "Darwin"
        device = "/dev/disk4"
        code, _out, err = self.run_tty([str(self.iso), device], device + "\n")
        self.assertEqual(code, 0, err)
        log = self.log.read_text()
        self.assertIn("diskutil unmountDisk /dev/disk4", log)
        self.assertIn("of=/dev/rdisk4", log)
        self.assertIn("bs=4m", log)

    def test_darwin_refuses_an_internal_disk(self):
        self.env["FLEET_OS"] = "Darwin"
        write_executable(self.bin / "diskutil", """\
            #!/bin/bash
            if [ "$1" = "info" ]; then
              printf 'Protocol:                  USB\\n'
              printf 'Internal:                  Yes\\n'
              printf 'Whole:                     Yes\\n'
            fi
            """)
        result = subprocess.run(
            [str(SCRIPT), str(self.iso), "/dev/disk4"],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("internal", result.stderr)
