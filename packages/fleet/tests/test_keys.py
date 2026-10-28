#!/usr/bin/env python3
"""fleet-keys renders .sops.yaml rules from GET /v1/recipients. It makes no
network request, reads no private key and keeps every role's recipients apart."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fleet-keys.py"
OPERATOR = "age1" + "q" * 58
CI_NODE = "age1" + "p" * 58
DEVBOX_NODE = "age1" + "z" * 58


def recipients(**roles):
    return {"roles": {role: [{"nodeId": "a" * 64, "hostname": f"{role}-aaaa", "recipient": value} for value in values]
                      for role, values in roles.items()}}


class KeysTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.input = Path(self.tmp.name) / "recipients.json"

    def run_keys(self, document, *args, stdin=False):
        text = document if isinstance(document, str) else json.dumps(document)
        if stdin:
            return subprocess.run([sys.executable, str(SCRIPT), *args, "-"], input=text, capture_output=True, text=True, check=False)
        self.input.write_text(text)
        return subprocess.run([sys.executable, str(SCRIPT), *args, str(self.input)], capture_output=True, text=True, check=False)

    def rules(self, output):
        lines = output.splitlines()
        found = {}
        for index, line in enumerate(lines):
            if line.startswith("  - path_regex: "):
                found[line.split(": ", 1)[1]] = lines[index + 1].split("age: ", 1)[1].split(",")
        return found

    def test_one_rule_per_role_secrets_file_with_operator_then_node_recipients(self):
        result = self.run_keys(recipients(ci=[CI_NODE], devbox=[DEVBOX_NODE], web=[CI_NODE]), "--operator", OPERATOR)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rules(result.stdout), {
            "secrets/fleet\\.(yaml|yml|json)$": [OPERATOR, CI_NODE],
            "secrets/devbox\\.(yaml|yml|json)$": [OPERATOR, DEVBOX_NODE],
        })
        self.assertTrue(result.stdout.splitlines()[2] == "creation_rules:")

    def test_a_devbox_identity_never_decrypts_the_ci_file(self):
        result = self.run_keys(recipients(ci=[], devbox=[DEVBOX_NODE]), "--operator", OPERATOR, stdin=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rules(result.stdout)["secrets/fleet\\.(yaml|yml|json)$"], [OPERATOR])

    def test_duplicates_are_listed_once(self):
        result = self.run_keys(recipients(ci=[OPERATOR, CI_NODE, CI_NODE]), "--operator", OPERATOR)
        self.assertEqual(self.rules(result.stdout)["secrets/fleet\\.(yaml|yml|json)$"], [OPERATOR, CI_NODE])

    def test_a_rotating_node_lists_its_current_and_next_recipient(self):
        rotating = "age1" + "r" * 58
        document = {"roles": {"ci": [
            {"nodeId": "a" * 64, "hostname": "ci-aaaa", "recipient": CI_NODE, "next": rotating},
            {"nodeId": "b" * 64, "hostname": "ci-bbbb", "recipient": "age1" + "s" * 58, "next": None},
            {"nodeId": "c" * 64, "hostname": "ci-cccc", "recipient": "age1" + "t" * 58},
        ]}}
        result = self.run_keys(document, "--operator", OPERATOR)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.rules(result.stdout)["secrets/fleet\\.(yaml|yml|json)$"],
                         [OPERATOR, CI_NODE, rotating, "age1" + "s" * 58, "age1" + "t" * 58])

    def test_a_malformed_next_recipient_is_refused(self):
        for bad in ("age1short", 7, "AGE-SECRET-KEY-1NOTAPUBLICKEY"):
            with self.subTest(bad=bad):
                document = {"roles": {"ci": [{"nodeId": "a" * 64, "hostname": "ci-aaaa", "recipient": CI_NODE, "next": bad}]}}
                result = self.run_keys(document, "--operator", OPERATOR)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("AGE-SECRET-KEY", result.stderr)

    def test_refuses_without_an_operator_or_with_bad_input_and_writes_nothing(self):
        cases = [
            (recipients(ci=[CI_NODE]), ()),
            (recipients(ci=[CI_NODE]), ("--operator", "AGE-SECRET-KEY-1NOTAPUBLICKEY")),
            (recipients(ci=["age1short"]), ("--operator", OPERATOR)),
            ({"nodes": []}, ("--operator", OPERATOR)),
            ("not json", ("--operator", OPERATOR)),
        ]
        for document, args in cases:
            with self.subTest(args=args, document=str(document)[:40]):
                result = self.run_keys(document, *args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertTrue(result.stderr.startswith("fleet-keys: "))
                self.assertNotIn("AGE-SECRET-KEY", result.stderr)


if __name__ == "__main__":
    unittest.main()
