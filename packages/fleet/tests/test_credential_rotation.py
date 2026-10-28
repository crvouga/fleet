#!/usr/bin/env python3
"""Node credential rotation: the module in isolation, then through the real agent loop
against a local HTTP controller that implements PROTOCOL.md "Credential rotation"."""

import hashlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).parent))

import credential_rotation  # noqa: E402
from test_agent import MACHINE_ID, ROLE_TOKEN, Api, AgentCase  # noqa: E402

HEX64 = re.compile(r"[0-9a-f]{64}")


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Paths:
    def __init__(self, state):
        self.state = Path(state)
        self.secret = self.state / "node.secret"


class StubAgent:
    """Just what credential_rotation touches: paths, secret, api, log."""

    def __init__(self, state, secret, answers):
        self.paths = Paths(state)
        self.paths.state.mkdir(parents=True, exist_ok=True)
        self.paths.secret.write_text(secret + "\n")
        self.secret = secret
        self.answers = list(answers)
        self.calls = []
        self.logs = []

    def api(self, method, path, body, bearer=None, timeout=None):
        self.calls.append((method, path, body, bearer))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def log(self, message):
        self.logs.append(message)


FLAG = {"ok": True, "credential": {"rotate": True}}
IDENTITY = {"id": MACHINE_ID}
OLD = sha("old-secret")


class ModuleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def stub(self, answers=()):
        return StubAgent(self.tmp.name, OLD, answers)

    def test_nothing_happens_without_the_flag(self):
        agent = self.stub()
        for document in ({"ok": True}, {"ok": True, "credential": {"rotate": False}}, {"credential": "yes"}, None, []):
            self.assertEqual(credential_rotation.step(agent, document, IDENTITY), "idle")
        self.assertEqual(agent.calls, [])
        self.assertFalse(credential_rotation.next_path(agent.paths).exists())

    def test_the_next_secret_is_persisted_before_it_is_offered(self):
        agent = self.stub([OSError("boom")])
        self.assertEqual(credential_rotation.step(agent, FLAG, IDENTITY), "retry")
        written = credential_rotation.next_path(agent.paths)
        self.assertTrue(HEX64.fullmatch(written.read_text().strip()))
        self.assertEqual(written.stat().st_mode & 0o777, 0o600)
        self.assertEqual(agent.paths.secret.read_text().strip(), OLD)
        self.assertEqual(agent.secret, OLD)

    def test_a_success_swaps_the_secret_atomically_and_forgets_the_next_file(self):
        agent = self.stub([(200, {"ok": True, "rotationPending": True})])
        self.assertEqual(credential_rotation.step(agent, FLAG, IDENTITY), "rotated")
        method, path, body, bearer = agent.calls[0]
        self.assertEqual((method, path), ("POST", "/v1/credential/rotate"))
        self.assertEqual(bearer, f"{MACHINE_ID}.{OLD}")
        new = agent.paths.secret.read_text().strip()
        self.assertNotEqual(new, OLD)
        self.assertEqual(agent.secret, new)
        self.assertEqual(body, {"nextSecretHash": sha(new)})
        self.assertFalse(credential_rotation.next_path(agent.paths).exists())
        self.assertEqual(agent.paths.secret.stat().st_mode & 0o777, 0o600)

    def test_a_retry_reuses_the_same_next_secret(self):
        agent = self.stub([(500, None), (200, {"ok": True})])
        self.assertEqual(credential_rotation.step(agent, FLAG, IDENTITY), "retry")
        first = credential_rotation.next_path(agent.paths).read_text().strip()
        self.assertEqual(credential_rotation.step(agent, FLAG, IDENTITY), "rotated")
        self.assertEqual(agent.calls[0][2], agent.calls[1][2])
        self.assertEqual(agent.paths.secret.read_text().strip(), first)

    def test_a_refusal_keeps_the_current_secret(self):
        agent = self.stub([(409, {"error": "rotation_not_requested"})])
        self.assertEqual(credential_rotation.step(agent, FLAG, IDENTITY), "refused")
        self.assertEqual(agent.paths.secret.read_text().strip(), OLD)

    def test_leftovers_are_cleaned_never_offered(self):
        agent = self.stub()
        path = credential_rotation.next_path(agent.paths)
        for leftover in (OLD, "not hex", ""):  # equal to current (crash after swap), garbage, empty
            path.write_text(leftover + "\n")
            self.assertIsNone(credential_rotation.pending_next(agent.paths, OLD))
            self.assertFalse(path.exists())
        fresh = sha("fresh")
        path.write_text(fresh + "\n")
        self.assertEqual(credential_rotation.pending_next(agent.paths, OLD), fresh)

    def test_logs_never_hold_a_secret(self):
        agent = self.stub([(200, {"ok": True}), (500, None)])
        credential_rotation.step(agent, FLAG, IDENTITY)
        new = agent.secret
        self.assertTrue(agent.logs)
        for line in agent.logs:
            self.assertNotIn(OLD, line)
            self.assertNotIn(new, line)

    def test_the_agent_is_wired_to_it_and_both_bundles_ship_it(self):
        root = Path(__file__).parents[1]
        self.assertIn("credential_rotation.step(self, document, identity)", (root / "scripts/agent.py").read_text())
        for name in ("fleet-tools.nix", "installer.nix"):
            self.assertIn("credential_rotation.py", (root / "modules" / name).read_text())


class RotatingApi(Api):
    """The controller side of the protocol: current and next secret, promotion on first use."""

    def __init__(self):
        super().__init__()
        self.rotate_requested = False
        self.next_hash = None
        self.offers = []
        self.drop_answer = 0
        self.refuse = False
        self.promotions = 0

    def _credential(self, authorization):
        token = (authorization or "").removeprefix("Bearer ").partition(".")
        return token[0], sha(token[2])

    def respond(self, path, authorization, body):
        node_id, presented = self._credential(authorization)
        node = self.nodes.get(node_id)
        if node is not None and path in ("/v1/heartbeat", "/v1/credential/rotate"):
            if presented != node["secretHash"] and self.next_hash is not None and presented == self.next_hash:
                node["secretHash"], self.next_hash, self.rotate_requested = self.next_hash, None, False
                self.promotions += 1
        if path == "/v1/credential/rotate":
            if node is None or presented != node["secretHash"]:
                return 401, {"error": "unauthorized"}
            self.offers.append(body["nextSecretHash"])
            if self.refuse or not self.rotate_requested:
                return 409, {"error": "rotation_not_requested"}
            self.next_hash = body["nextSecretHash"]
            if self.drop_answer > 0:
                self.drop_answer -= 1
                return 500, {"error": "internal"}
            return 200, {"ok": True, "rotationPending": True}
        status, answer = super().respond(path, authorization, body)
        if path == "/v1/heartbeat" and status == 200 and self.rotate_requested:
            answer["credential"] = {"rotate": True}
        return status, answer


class RotationThroughTheAgent(AgentCase):
    def setUp(self):
        super().setUp()
        self.api.close()
        self.api = RotatingApi()

    def registered(self):
        worker = self.make(role_token=ROLE_TOKEN)
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        return worker

    def assert_secrets_not_logged(self, *secrets):
        for line in self.logs:
            for secret in secrets:
                self.assertNotIn(secret, line)

    def test_a_full_rotation_without_registering_again(self):
        worker = self.registered()
        old = self.secret()
        self.api.rotate_requested = True
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        new = self.secret()
        self.assertNotEqual(new, old)
        self.assertEqual(self.api.next_hash, sha(new))
        self.assertFalse((self.node.state / "node.secret.next").exists())
        # Next cycle authenticates with the new secret: the controller promotes it.
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        self.assertEqual(self.api.promotions, 1)
        self.assertFalse(self.api.rotate_requested)
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 1)
        self.assertEqual(self.api.nodes[MACHINE_ID]["secretHash"], sha(new))
        self.assertEqual(len(self.api.offers), 1)
        self.assert_secrets_not_logged(old, new)

    def test_a_lost_answer_is_retried_with_the_same_next_secret(self):
        worker = self.registered()
        old = self.secret()
        self.api.rotate_requested = True
        self.api.drop_answer = 1  # the controller stores the offer but its answer is lost
        worker.cycle()
        self.assertEqual(self.secret(), old)  # not swapped without an answer
        pending = (self.node.state / "node.secret.next").read_text().strip()
        self.assertEqual(self.api.next_hash, sha(pending))
        worker.cycle()  # the retry is idempotent and completes
        self.assertEqual(self.secret(), pending)
        self.assertEqual(self.api.offers, [sha(pending), sha(pending)])
        worker.cycle()
        self.assertEqual(self.api.promotions, 1)
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 1)

    def test_a_restart_between_the_swap_and_the_first_use_still_authenticates(self):
        worker = self.registered()
        self.api.rotate_requested = True
        worker.cycle()  # swapped on disk, the controller still accepts both
        new = self.secret()
        restarted = self.make()
        ok, _ = restarted.cycle()
        self.assertTrue(ok, self.logs)
        self.assertEqual(self.api.promotions, 1)
        self.assertEqual(self.api.nodes[MACHINE_ID]["secretHash"], sha(new))
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 1)

    def test_a_restart_before_the_swap_keeps_the_old_secret_and_reuses_the_next_file(self):
        worker = self.registered()
        old = self.secret()
        self.api.rotate_requested = True
        self.api.drop_answer = 1
        worker.cycle()
        pending = (self.node.state / "node.secret.next").read_text().strip()
        restarted = self.make()
        restarted.cycle()
        self.assertEqual(self.secret(), pending)
        self.assertNotEqual(pending, old)
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 1)

    def test_without_a_request_the_node_never_offers_anything(self):
        worker = self.registered()
        old = self.secret()
        worker.cycle()
        worker.cycle()
        self.assertEqual(self.api.offers, [])
        self.assertEqual(self.secret(), old)
        self.assertFalse((self.node.state / "node.secret.next").exists())

    def test_a_refusal_does_not_break_reporting(self):
        worker = self.registered()
        old = self.secret()
        self.api.rotate_requested = True
        self.api.refuse = True
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        self.assertEqual(self.secret(), old)


if __name__ == "__main__":
    unittest.main()
