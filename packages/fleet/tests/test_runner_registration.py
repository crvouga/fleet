"""runner_control.py register against a loopback fleet controller: no GitHub App key on the node."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner_control", Path(__file__).parents[1] / "scripts/runner_control.py")
control = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"jwt": types.SimpleNamespace(encode=lambda *a, **k: "signed-jwt")}):
    spec.loader.exec_module(control)

NODE_ID = "ab" * 32
SECRET = "cd" * 32
TOKEN = "AAAA-registration-token-1234"


class Controller:
    """A scripted loopback controller: each request pops the next (status, headers, body)."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                outer.requests.append((self.path, dict(self.headers), json.loads(self.rfile.read(length) or b"{}")))
                status, headers, body = outer.answers.pop(0) if len(outer.answers) > 1 else outer.answers[0]
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


def grant(target="acme/app", scope="repository", group=None):
    return (200, {}, {"token": TOKEN, "scope": scope, "url": "https://github.com/" + target, "target": target,
                      "runnerGroup": group, "expiresAt": "2026-10-14T13:00:00.000Z"})


class RegistrationViaController(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / "run").mkdir()
        (root / "state").mkdir()
        (root / "run/node").write_text("hostname=ci-abab\nmachine_id=%s\nrole=ci\n" % NODE_ID)
        (root / "state/node.secret").write_text(SECRET + "\n")
        self.root = root
        self.output = root / "tokens/slot-2"
        self.status = root / "register/slot-2.json"
        self.used = root / "assign-used/slot-2"
        self.group = root / "assign-group/slot-2"
        self.env = {"FLEET_RUN": str(root / "run"), "FLEET_AGENT_STATE": str(root / "state"), "FLEET_SLOT": "slot-2",
                    "FLEET_REGISTER_STATUS": str(self.status), "FLEET_ASSIGN_USED_FILE": str(self.used),
                    "FLEET_ASSIGN_GROUP_FILE": str(self.group)}

    def tearDown(self):
        self.temp.cleanup()

    def register(self, controller, scope="repository", target="acme/app", extra=None, key="/nonexistent/key"):
        argv = ["runner_control.py", "register", scope, target, "", "", key, str(self.output)]
        env = {**self.env, "FLEET_API_URL": controller.url, **(extra or {})}
        out, err = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", argv), patch.dict("os.environ", env), patch.object(control.time, "sleep") as sleep, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = control.run()
        return code, out.getvalue(), err.getvalue(), sleep

    def test_registers_with_the_nodes_own_credential_and_stores_the_token_privately(self):
        with Controller([grant()]) as controller:
            code, out, err, _ = self.register(controller)
        self.assertEqual(code, 0)
        self.assertEqual(self.output.read_text(), TOKEN)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.used.read_text().strip(), "acme/app")
        self.assertEqual(out + err, "")
        path, headers, body = controller.requests[0]
        self.assertEqual(path, "/v1/runner-registration")
        self.assertEqual(headers["Authorization"], "Bearer %s.%s" % (NODE_ID, SECRET))
        self.assertEqual((body["slot"], body["repository"]), ("slot-2", "acme/app"))
        recorded = json.loads(self.status.read_text())
        self.assertEqual((recorded["code"], recorded["exit"]), ("ok", 0))
        self.assertNotIn(TOKEN, self.status.read_text())

    def test_the_placeholder_target_lets_the_controller_choose_the_repository(self):
        with Controller([grant("acme/chosen")]) as controller:
            code, *_ = self.register(controller, target=control.PLACEHOLDER_TARGET)
        self.assertEqual(code, 0)
        self.assertNotIn("repository", controller.requests[0][2])
        self.assertEqual(self.used.read_text().strip(), "acme/chosen")

    def test_an_organization_target_and_runner_group_are_recorded_for_the_listener(self):
        with Controller([grant("acme", "organization", "ci-group")]) as controller:
            code, *_ = self.register(controller, scope="organization", target="acme")
        self.assertEqual(code, 0)
        self.assertNotIn("repository", controller.requests[0][2])
        self.assertEqual(self.used.read_text().strip(), "acme")
        self.assertEqual(self.group.read_text().strip(), "ci-group")

    def test_a_temporary_failure_is_retried_with_the_same_idempotency_key(self):
        with Controller([(503, {"Retry-After": "3"}, {"error": "github_unavailable", "message": "later"}), grant()]) as controller:
            code, _, _, sleep = self.register(controller)
        self.assertEqual(code, 0)
        keys = {request[2]["idempotencyKey"] for request in controller.requests}
        self.assertEqual(len(controller.requests), 2)
        self.assertEqual(len(keys), 1)
        sleep.assert_called_once_with(3)

    def test_a_persistent_outage_exits_75_and_never_leaves_a_token(self):
        with Controller([(503, {}, {"error": "github_unavailable"})]) as controller:
            code, _, err, _ = self.register(controller)
        self.assertEqual(code, 75)
        self.assertEqual(len(controller.requests), control.CONTROLLER_ATTEMPTS)
        self.assertIn("FLEET_GITHUB_UNAVAILABLE", err)
        self.assertFalse(self.output.exists())
        self.assertEqual(json.loads(self.status.read_text())["exit"], 75)

    def test_an_unreachable_controller_is_temporary(self):
        with Controller([grant()]) as controller:
            url = controller.url
        stub = types.SimpleNamespace(url=url)
        code, _, err, _ = self.register(stub)
        self.assertEqual(code, 75)
        self.assertIn("could not be reached", err)

    def test_github_refusals_keep_their_public_code_and_exit_78(self):
        body = {"error": "github_refused", "code": "FLEET_GITHUB_KEY", "message": "GitHub refused the App credential (HTTP 401)"}
        with Controller([(422, {}, body)]) as controller:
            code, _, err, _ = self.register(controller)
        self.assertEqual(code, 78)
        self.assertTrue(err.startswith("FLEET_GITHUB_KEY: GitHub refused the App credential"))
        self.assertEqual(len(controller.requests), 1)
        self.assertEqual(json.loads(self.status.read_text())["code"], "FLEET_GITHUB_KEY")

    def test_an_ineligible_node_is_refused_with_the_controllers_reason(self):
        body = {"error": "runner_not_allowed", "code": "runners_drained", "message": "Runner admission is closed for this node."}
        with Controller([(403, {}, body)]) as controller:
            code, _, err, _ = self.register(controller)
        self.assertEqual(code, 78)
        self.assertIn("runners_drained: Runner admission is closed", err)

    def test_a_rejected_credential_says_the_node_must_register_again(self):
        with Controller([(401, {}, {"error": "unauthorized"})]) as controller:
            code, _, err, _ = self.register(controller)
        self.assertEqual(code, 78)
        self.assertIn("FLEET_CONTROLLER_AUTH", err)

    def test_a_node_without_an_identity_is_refused_before_any_request(self):
        (self.root / "state/node.secret").unlink()
        with Controller([grant()]) as controller:
            code, _, err, _ = self.register(controller)
        self.assertEqual(code, 78)
        self.assertIn("FLEET_NODE_CREDENTIAL_MISSING", err)
        self.assertEqual(controller.requests, [])

    def test_an_unusable_answer_is_temporary(self):
        with Controller([(200, {}, {"token": "x"})]) as controller:
            code, *_ = self.register(controller)
        self.assertEqual(code, 75)
        self.assertFalse(self.output.exists())

    def test_a_non_loopback_http_controller_is_refused(self):
        stub = types.SimpleNamespace(url="http://controller.example.com")
        code, _, err, _ = self.register(stub)
        self.assertEqual(code, 78)
        self.assertIn("FLEET_CONTROLLER_UNCONFIGURED", err)

    def test_a_node_that_still_holds_the_app_key_registers_directly_with_github(self):
        key = self.root / "github-app-key"
        key.write_text("legacy-key")
        calls = []

        def api(method, path, auth, payload=None):
            calls.append(path)
            return {"token": "installation" if path.startswith("/app/") else "direct-registration"}

        with Controller([grant()]) as controller:
            argv = ["runner_control.py", "register", "repository", "acme/app", "1", "2", str(key), str(self.output)]
            with patch.object(sys, "argv", argv), patch.dict("os.environ", {**self.env, "FLEET_API_URL": controller.url}), \
                    patch.object(control, "request", side_effect=api):
                self.assertEqual(control.run(), 0)
        self.assertEqual(controller.requests, [])
        self.assertEqual(self.output.read_text(), "direct-registration")
        self.assertEqual(calls[1], "/repos/acme/app/actions/runners/registration-token")

    def test_without_a_controller_or_a_key_the_old_diagnostics_remain(self):
        argv = ["runner_control.py", "register", "repository", "acme/app", "1", "2", "/nonexistent/key", str(self.output)]
        with patch.object(sys, "argv", argv), patch.dict("os.environ", {**self.env, "FLEET_API_URL": ""}), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(control.run(), 78)
        self.assertEqual(json.loads(self.status.read_text())["code"], "FLEET_SECRET_MISSING")


if __name__ == "__main__":
    unittest.main()
