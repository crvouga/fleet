#!/usr/bin/env python3
"""fleet-keys creates each role's key once and never prints a private key."""

import json
import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fleet-keys.py"


class KeysTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        counter = self.root / "count"
        tool = self.root / "age-keygen"
        tool.write_text(textwrap.dedent(f"""\
            #!/bin/bash
            if [ "$1" = "-y" ]; then echo "age1pub$(tail -c 3 "$2")"; exit 0; fi
            n=$(( $(cat {counter} 2>/dev/null || echo 0) + 1 )); echo $n > {counter}
            printf '# public key: age1pub%03d\\nAGE-SECRET-KEY-%03d\\n' $n $n
            """))
        tool.chmod(tool.stat().st_mode | stat.S_IEXEC)
        self.out = self.root / "vault" / "keys.auto.tfvars.json"
        self.sops = self.root / ".sops.yaml"
        self.env = os.environ.copy()
        self.env.update({"FLEET_AGE_KEYGEN": str(tool), "FLEET_KEYS_OUT": str(self.out), "FLEET_SOPS": str(self.sops)})

    def tearDown(self):
        self.tmp.cleanup()

    def run_keys(self):
        return subprocess.run([str(SCRIPT)], capture_output=True, text=True, env=self.env, check=False)

    def test_creates_distinct_keys_for_every_active_role_without_printing_them(self):
        result = self.run_keys()
        self.assertEqual(result.returncode, 0, result.stderr)
        keys = json.loads(self.out.read_text())["fleet_age_keys"]
        self.assertEqual(sorted(keys), ["ci", "devbox"])
        self.assertEqual(len(set(keys.values())), 2)
        self.assertEqual(stat.S_IMODE(self.out.stat().st_mode), 0o600)
        self.assertNotIn("AGE-SECRET-KEY", result.stdout + result.stderr)
        sops = self.sops.read_text()
        self.assertNotIn("TODO", sops)
        self.assertNotIn("AGE-SECRET-KEY", sops)
        self.assertEqual(sops.count("age: age1"), 2)
        self.assertIn("secrets/fleet\\.(yaml|yml|json)$", sops)
        self.assertIn("secrets/devbox\\.(yaml|yml|json)$", sops)

    def test_a_second_run_keeps_every_key(self):
        self.run_keys()
        before = (self.out.read_bytes(), self.sops.read_bytes())
        again = self.run_keys()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("created: none", again.stderr)
        self.assertEqual((self.out.read_bytes(), self.sops.read_bytes()), before)

    def test_a_missing_role_is_added_and_the_rest_are_kept(self):
        self.run_keys()
        data = json.loads(self.out.read_text())
        kept = data["fleet_age_keys"]["ci"]
        del data["fleet_age_keys"]["devbox"]
        self.out.write_text(json.dumps(data))
        self.run_keys()
        keys = json.loads(self.out.read_text())["fleet_age_keys"]
        self.assertEqual(keys["ci"], kept)
        self.assertIn("devbox", keys)

    def test_a_retired_role_keeps_its_key_but_gets_no_recipient(self):
        # The vault root still holds secret/fleet/web until a reviewed change
        # deletes the role; dropping the key here would make that plan fail.
        self.out.parent.mkdir(parents=True)
        self.out.write_text(json.dumps({"fleet_age_keys": {"web": "AGE-SECRET-KEY-900"}}))
        result = self.run_keys()
        self.assertEqual(result.returncode, 0, result.stderr)
        keys = json.loads(self.out.read_text())["fleet_age_keys"]
        self.assertEqual(keys["web"], "AGE-SECRET-KEY-900")
        self.assertNotIn("secrets/web", self.sops.read_text())

    def test_a_key_for_a_role_outside_the_registry_is_refused(self):
        self.out.parent.mkdir(parents=True)
        self.out.write_text(json.dumps({"fleet_age_keys": {"kiosk": "AGE-SECRET-KEY-901"}}))
        result = self.run_keys()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Keys for roles not in roles.json: kiosk", result.stderr)


if __name__ == "__main__":
    unittest.main()
