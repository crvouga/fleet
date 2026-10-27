#!/usr/bin/env python3
"""fetch-iso downloads the CI artifact. It does not build the ISO."""

import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fetch-iso.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class FetchIsoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.store = self.root / "artifact"
        self.store.mkdir()
        (self.store / "fleet-installer.iso").write_bytes(b"iso-bytes")
        self.log = self.root / "gh"
        write_executable(self.bin / "gh", f"""\
            #!/bin/bash
            printf '%s\\n' "$*" >> {self.log}
            if [ "$1" = "api" ]; then
              echo 4242
              exit 0
            fi
            dir=""
            prev=""
            for arg in "$@"; do
              if [ "$prev" = "--dir" ]; then dir=$arg; fi
              prev=$arg
            done
            cp {self.store}/fleet-installer.iso "$dir/fleet-installer.iso"
            """)
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.bin}:{os.environ.get('PATH', '')}"
        self.env["FLEET_GH"] = str(self.bin / "gh")

    def tearDown(self):
        self.tmp.cleanup()

    def test_downloads_the_artifact(self):
        dest = self.root / "out.iso"
        result = subprocess.run(
            [str(SCRIPT), str(dest)],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(dest.read_bytes(), b"iso-bytes")
        log = self.log.read_text()
        lines = [line for line in log.splitlines() if line]
        self.assertEqual(lines[0].split()[0], "api", log)
        self.assertIn('head_branch == "main"', lines[0])
        self.assertIn('head_repository_id == .workflow_run.repository_id', lines[0])
        self.assertEqual(lines[1].split()[0:2], ["run", "download"], log)
        self.assertIn("fleet-installer", log)
        # The temp dir under nix develop contains "nix-shell". That is not a build.
        self.assertNotIn("nix build", log)
        self.assertNotIn("nix flake", log)

    def test_missing_run_exits(self):
        write_executable(self.bin / "gh", """\
            #!/bin/bash
            echo null
            """)
        dest = self.root / "out.iso"
        result = subprocess.run(
            [str(SCRIPT), str(dest)],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(dest.exists())
