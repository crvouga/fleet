"""Release identity overrides must reach every downloaded installer entry point."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


class DeploymentIdentityTests(unittest.TestCase):
    def test_app_origin_selects_image_independently_of_bug_report_repository(self):
        code = """
import decide, json
print(json.dumps({
    'image': decide.installer_urls()[0],
    'guide': decide.GUIDE_URL,
    'repository': decide.REPO,
}))
"""
        env = {key: value for key, value in os.environ.items()
               if key not in ("FLEET_INSTALLER_URL", "FLEET_INSTALLER_SHA256_URL")}
        env["FLEET_CONTROLLER_URL"] = "https://fleet.example.org"
        env["FLEET_BUG_REPORT_REPO"] = "operator/machines"
        result = subprocess.run([sys.executable, "-B", "-c", code], cwd=SCRIPTS,
                                env=env, text=True, capture_output=True, check=True)
        data = json.loads(result.stdout)
        self.assertEqual(data["image"], "https://fleet.example.org/installers/assets/fleet-installer.iso")
        self.assertEqual(data["guide"], "Run fleet-node.sh guide for the embedded runbook (docs/agent-install.md).")
        self.assertEqual(data["repository"], "operator/machines")

    def test_setup_without_repository_stops_before_any_setup_work(self):
        env = {**os.environ, "FLEET_GITHUB_REPO": ""}
        result = subprocess.run([sys.executable, "-B", str(SCRIPTS / "setup.py")],
                                env=env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Set FLEET_GITHUB_REPO=owner/repository", result.stderr)
