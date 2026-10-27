#!/usr/bin/env python3
"""Self-service enrollment: the sealing primitive, the issue protocol, the node's
polling, and the workflow's half against a fake Vault. No network."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from enroll_fakes import FakeGitHub, FakeVault  # noqa: E402


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


decide = load("decide", ROOT / "scripts" / "decide.py")


class X25519Test(unittest.TestCase):
    """Vectors from RFC 7748, so the pure-Python curve is the real curve."""

    def test_rfc7748_section_5_2_vectors(self):
        out = decide.x25519(
            bytes.fromhex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
            bytes.fromhex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
        )
        self.assertEqual(out.hex(), "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552")
        out = decide.x25519(
            bytes.fromhex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d"),
            bytes.fromhex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493"),
        )
        self.assertEqual(out.hex(), "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957")

    def test_rfc7748_section_6_1_key_agreement(self):
        alice = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        bob = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        alice_public = decide.x25519(alice, decide.BASE_POINT)
        bob_public = decide.x25519(bob, decide.BASE_POINT)
        self.assertEqual(alice_public.hex(), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        self.assertEqual(bob_public.hex(), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
        self.assertEqual(decide.x25519(alice, bob_public).hex(), shared)
        self.assertEqual(decide.x25519(bob, alice_public).hex(), shared)


class SealTest(unittest.TestCase):
    def test_only_the_recipient_can_open_it(self):
        private, public = decide.new_keypair()
        blob = decide.seal(b"hvs.wrapped-token", public)
        # Random base64 can coincidentally contain a three-letter prefix.
        # Check the actual sealed bytes for the complete plaintext instead.
        self.assertNotIn(b"hvs.wrapped-token", decide._unb64(blob))
        self.assertEqual(decide.open_sealed(blob, private), b"hvs.wrapped-token")
        other, _ = decide.new_keypair()
        self.assertIsNone(decide.open_sealed(blob, other))

    def test_a_changed_byte_is_rejected(self):
        private, public = decide.new_keypair()
        blob = decide.seal(b"hvs.wrapped-token", public)
        raw = bytearray(decide._unb64(blob))
        for index in (0, 33, len(raw) - 1):
            tampered = bytearray(raw)
            tampered[index] ^= 1
            self.assertIsNone(decide.open_sealed(decide._b64(bytes(tampered)), private), index)

    def test_garbage_is_not_a_blob(self):
        private, _ = decide.new_keypair()
        for junk in ("", "!!!", "AAAA", decide._b64(b"x" * 63)):
            self.assertIsNone(decide.open_sealed(junk, private), junk)

    def test_the_same_message_seals_differently_each_time(self):
        _, public = decide.new_keypair()
        self.assertNotEqual(decide.seal(b"same", public), decide.seal(b"same", public))

    def test_a_low_order_recipient_is_refused(self):
        with self.assertRaises(decide.Invariant):
            decide.seal(b"x", bytes(32))


class RequestTest(unittest.TestCase):
    def test_the_link_carries_the_role_and_a_public_key_only(self):
        private, public = decide.new_keypair()
        url = decide.enroll_issue_url("ci", public)
        self.assertTrue(url.startswith("https://github.com/crvouga/fleet/issues/new?"))
        self.assertIn("title=fleet-enroll%20ci", url)
        self.assertNotIn(decide._b64(private), url)
        self.assertNotIn("%0A%0A%0A", url)

    def test_round_trip_through_the_parser(self):
        _, public = decide.new_keypair()
        body = f"x\n\n{decide.FIELD_ROLE}devbox\n{decide.FIELD_KEY}{decide._b64(public)}\n"
        self.assertEqual(decide.parse_enroll_request("fleet-enroll devbox", body), ("devbox", public))

    def test_bad_requests_are_refused(self):
        _, public = decide.new_keypair()
        good = f"{decide.FIELD_ROLE}ci\n{decide.FIELD_KEY}{decide._b64(public)}\n"
        cases = [
            ("fleet-enroll devbox", good),  # title and role disagree
            ("fleet-enroll ci", good.replace("ci\n", "root\n", 1)),
            ("fleet-enroll ci", f"{decide.FIELD_ROLE}ci\n"),  # no key
            ("fleet-enroll ci", f"{decide.FIELD_ROLE}ci\n{decide.FIELD_KEY}AAAA\n"),  # short key
            ("fleet-enroll ci", ""),
        ]
        for title, body in cases:
            with self.assertRaises(decide.Invariant, msg=(title, body)):
                decide.parse_enroll_request(title, body)


class PollTest(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub()
        self.addCleanup(self.github.close)
        patch = mock.patch.dict(os.environ, {"FLEET_GITHUB_API": self.github.url}, clear=False)
        patch.start()
        self.addCleanup(patch.stop)
        self.private, self.public = decide.new_keypair()
        self.body = f"{decide.FIELD_ROLE}ci\n{decide.FIELD_KEY}{decide._b64(self.public)}\n"

    def answer(self, role="ci", token="hvs.wrapped-ci-0001"):
        return "fleet-sealed: " + decide.seal(json.dumps({"role": role, "token": token}).encode(), self.public)

    def wait(self, wait=5):
        return decide.await_approval("ci", self.private, self.public, wait=wait, interval=0)

    def test_the_sealed_token_is_found_and_opened(self):
        number = self.github.open_issue("fleet-enroll ci", self.body)
        self.github.comment(number, self.answer())
        self.assertEqual(self.wait(), ("hvs.wrapped-ci-0001", None))

    def test_it_waits_until_the_workflow_answers(self):
        number = self.github.open_issue("fleet-enroll ci", self.body)
        calls = []

        def sleeper(_seconds):
            calls.append(1)
            if len(calls) == 2:
                self.github.comment(number, self.answer())

        got = decide.await_approval("ci", self.private, self.public, wait=30, interval=0, sleep=sleeper)
        self.assertEqual(got, ("hvs.wrapped-ci-0001", None))
        self.assertGreaterEqual(len(calls), 2)
        self.assertGreater(self.github.not_modified, 0, "unchanged polls must be conditional requests")

    def test_a_workflow_error_is_reported_at_once(self):
        number = self.github.open_issue("fleet-enroll ci", self.body)
        self.github.comment(number, "fleet-error: Vault has no age key for the ci role. Run `just setup`.")
        token, error = self.wait()
        self.assertIsNone(token)
        self.assertIn("just setup", error)

    def test_a_comment_from_anyone_else_is_ignored(self):
        number = self.github.open_issue("fleet-enroll ci", self.body)
        self.github.comment(number, self.answer(), login="mallory")
        self.github.comment(number, "fleet-error: forged", login="mallory")
        token, error = decide.await_approval("ci", self.private, self.public, wait=0, interval=0)
        self.assertEqual((token, error), (None, "nobody approved this node in time"))

    def test_a_token_for_another_role_or_key_is_ignored(self):
        number = self.github.open_issue("fleet-enroll ci", self.body)
        self.github.comment(number, self.answer(role="devbox"))
        _, other_public = decide.new_keypair()
        self.github.comment(number, "fleet-sealed: " + decide.seal(json.dumps({"role": "ci", "token": "hvs.stolen-0001"}).encode(), other_public))
        token, _ = decide.await_approval("ci", self.private, self.public, wait=0, interval=0)
        self.assertIsNone(token)

    def test_another_nodes_issue_is_not_mine(self):
        _, other = decide.new_keypair()
        number = self.github.open_issue("fleet-enroll ci", f"{decide.FIELD_KEY}{decide._b64(other)}\n")
        self.github.comment(number, self.answer())
        self.assertIsNone(decide.await_approval("ci", self.private, self.public, wait=0, interval=0)[0])

    def test_a_pull_request_is_not_an_enrollment(self):
        number = self.github.open_issue("fleet-enroll ci", self.body, pull_request=True)
        self.github.comment(number, self.answer())
        self.assertIsNone(decide.await_approval("ci", self.private, self.public, wait=0, interval=0)[0])

    def test_an_unreachable_github_times_out_instead_of_crashing(self):
        with mock.patch.dict(os.environ, {"FLEET_GITHUB_API": "http://127.0.0.1:9"}):
            token, error = decide.await_approval("ci", self.private, self.public, wait=0, interval=0)
        self.assertEqual((token, error), (None, "nobody approved this node in time"))

    def test_self_enroll_prints_the_link_and_never_the_key(self):
        said = []
        env = {"FLEET_NO_BROWSER": "1", "FLEET_ENROLL_POLL": "0"}
        with mock.patch.dict(os.environ, env):
            token, error = decide.self_enroll("ci", notify=said.append, wait=0)
        self.assertIsNone(token)
        self.assertTrue(any("https://github.com/crvouga/fleet/issues/new?" in line for line in said))
        self.assertTrue(any("Submit new issue" in line for line in said))


class WorkflowTest(unittest.TestCase):
    """scripts/enroll.py exactly as the Fleet enroll workflow runs it."""

    def setUp(self):
        self.vault = FakeVault()
        self.addCleanup(self.vault.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.result = Path(self.tmp.name) / "result.txt"
        self.private, self.public = decide.new_keypair()

    def run_script(self, title="fleet-enroll ci", role="ci", body=None):
        body = body if body is not None else f"{decide.FIELD_ROLE}{role}\n{decide.FIELD_KEY}{decide._b64(self.public)}\n"
        env = {
            **os.environ,
            "VAULT_ADDR": self.vault.url,
            "ACTIONS_ID_TOKEN_REQUEST_URL": self.vault.url + "/oidc?x=1",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "request-token",
            "ISSUE_TITLE": title,
            "ISSUE_BODY": body,
            "RESULT_FILE": str(self.result),
        }
        done = subprocess.run([sys.executable, str(ROOT / "scripts" / "enroll.py")], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done, self.result.read_text().strip()

    def test_the_node_can_open_what_the_workflow_posts(self):
        done, line = self.run_script()
        self.assertTrue(line.startswith("fleet-sealed: "), line)
        answer = json.loads(decide.open_sealed(line[len("fleet-sealed: "):], self.private))
        self.assertEqual(answer, {"role": "ci", "token": "hvs.wrapped-ci-0001"})

    def test_vault_is_asked_to_wrap_and_the_key_never_appears(self):
        done, line = self.run_script()
        self.assertEqual(self.vault.reads, [{"role": "ci", "wrap": "1h"}])
        for text in (done.stdout, done.stderr, line):
            self.assertNotIn("AGE-SECRET-KEY", text)
        self.assertIn("::add-mask::hvs.wrapped-ci-0001", done.stdout)

    def test_it_logs_in_as_the_fleet_enroll_role_with_the_vault_audience(self):
        self.run_script()
        self.assertEqual(self.vault.logins, [{"role": "fleet-enroll", "jwt": "github-oidc-jwt"}])
        self.assertEqual(self.vault.audiences, [self.vault.url])

    def test_a_role_with_no_key_says_what_to_run(self):
        self.vault.keys.pop("ci")
        _, line = self.run_script()
        self.assertTrue(line.startswith("fleet-error: "), line)
        self.assertIn("just setup", line)

    def test_a_malformed_request_is_an_error_comment_not_a_crash(self):
        for title, body in (("fleet-enroll root", "x"), ("fleet-enroll ci", ""), ("hello", "hello")):
            _, line = self.run_script(title=title, body=body)
            self.assertTrue(line.startswith("fleet-error: "), line)
        self.assertEqual(self.vault.reads, [])

    def test_an_unreachable_vault_is_an_error_comment(self):
        self.vault.close()
        _, line = self.run_script()
        self.assertTrue(line.startswith("fleet-error: "), line)

    def test_every_role_has_its_own_read_path(self):
        self.vault.keys.update({"ci": "AGE-SECRET-KEY-1CI", "devbox": "AGE-SECRET-KEY-1DEV"})
        for role in ("ci", "devbox"):
            _, line = self.run_script(title=f"fleet-enroll {role}", role=role)
            answer = json.loads(decide.open_sealed(line[len("fleet-sealed: "):], self.private))
            self.assertEqual(answer["role"], role)
            self.assertEqual(answer["token"], f"hvs.wrapped-{role}-0001")


class PolicyTest(unittest.TestCase):
    """The Vault policy is what stops the workflow from reading a raw key."""

    def test_policy_demands_a_wrapped_read_of_the_fleet_keys_only(self):
        policy = (ROOT / "examples" / "vault" / "fleet-enroll.hcl").read_text()
        self.assertIn('path "secret/data/fleet/+"', policy)
        self.assertIn('capabilities     = ["read"]', policy)
        self.assertIn("min_wrapping_ttl", policy)
        self.assertNotIn("personal", policy)
        self.assertNotIn('"list"', policy)



if __name__ == "__main__":
    unittest.main()
