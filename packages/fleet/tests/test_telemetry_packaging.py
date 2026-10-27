#!/usr/bin/env python3
"""The scripts named by both Nix derivations import from their isolated bundle."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PackagingTests(unittest.TestCase):
    def test_installed_and_bootstrap_agent_bundles_have_every_sibling_import(self):
        for definition in ("fleet-tools.nix", "installer.nix"):
            with self.subTest(definition=definition), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts = root / "scripts"
                scripts.mkdir()
                text = (ROOT / "modules" / definition).read_text()
                names = re.findall(r'cp \$\{\.\./scripts/([A-Za-z0-9_.-]+)\}', text)
                self.assertIn("telemetry.py", names)
                self.assertIn("runner_job.py", names)
                for name in names:
                    shutil.copyfile(ROOT / "scripts" / name, scripts / name)
                env = dict(os.environ, FLEET_API_URL="https://fleet.example", FLEET_AGENT_STATE=str(root / "state"),
                    FLEET_RUN=str(root / "run"), FLEET_ETC=str(root / "etc"), FLEET_SYS=str(root / "sys"),
                    FLEET_PROC=str(root / "proc"), FLEET_SLOT="slot-1", GITHUB_REPOSITORY="owner/repo", GITHUB_RUN_ID="123", GITHUB_JOB="build")
                done = subprocess.run([sys.executable, "-I", str(scripts / "agent.py"), "status"],
                    env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertIn("node: unknown", done.stdout)
                (root / "run/slot-1").mkdir(parents=True)
                hook = subprocess.run([sys.executable, "-I", str(scripts / "runner_job.py"), "started"],
                    env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(hook.returncode, 0, hook.stderr)
                self.assertEqual(json.loads((root / "run/slot-1/job.json").read_text())["runId"], "123")


if __name__ == "__main__":
    unittest.main()
