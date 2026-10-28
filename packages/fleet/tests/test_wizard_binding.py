#!/usr/bin/env python3
"""The installer's binding to the controller that issued it (fleet-bind.json).

A loopback HTTP server stands in for the controller; nothing here reaches a
real network, disk or controller."""

import datetime
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wizard"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import fleet_binding  # noqa: E402
import imaging  # noqa: E402
import server  # noqa: E402
from test_wizard import INTERNAL, WizardCase  # noqa: E402

GRANT = "fgr_" + "A" * 43
UTC = datetime.timezone.utc


def stamp(delta_hours):
    moment = datetime.datetime.now(UTC) + datetime.timedelta(hours=delta_hours)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def document(origin="https://fleet.example.org", expires=24, **changes):
    value = {"v": 1, "origin": origin, "grant": GRANT, "grantId": "g-1", "issuedAt": stamp(-1),
             "expiresAt": stamp(expires), "keyId": "abcdef012345", "sig": "c" * 64}
    value.update(changes)
    return value


class FakeController:
    """Answers POST /v1/enrollment/check from a script and records what it was sent."""

    def __init__(self):
        self.requests = []
        self.reply = (200, {"ok": True, "kind": "grant", "role": None, "state": "pending", "approval": "manual",
                            "expiresAt": stamp(1)})
        self.redirect_hits = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                outer.requests.append((self.path, body))
                status, payload = outer.reply
                if status == 302:
                    self.send_response(302)
                    self.send_header("Location", f"http://127.0.0.1:{outer.other.server_address[1]}/stolen")
                    self.end_headers()
                    return
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        class Other(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                outer.redirect_hits.append(self.path)
                self.send_response(200)
                self.end_headers()

            do_GET = do_POST

        self.http = HTTPServer(("127.0.0.1", 0), Handler)
        self.other = HTTPServer(("127.0.0.1", 0), Other)
        for httpd in (self.http, self.other):
            threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.http.server_address[1]}"

    def close(self):
        for httpd in (self.http, self.other):
            httpd.shutdown()
            httpd.server_close()


class ParseTests(unittest.TestCase):
    def test_a_well_formed_binding_parses(self):
        binding = fleet_binding.parse(json.dumps(document()).encode())
        self.assertEqual(binding["origin"], "https://fleet.example.org")
        self.assertEqual(binding["grant"], GRANT)

    def test_malformed_bindings_are_refused_with_a_next_step(self):
        bad = [b"not json", b"[]", b"x" * 5000,
               json.dumps(document(v=2)).encode(),
               json.dumps(document(origin="http://fleet.example.org")).encode(),   # plain http, not loopback
               json.dumps(document(origin="https://fleet.example.org/path")).encode(),
               json.dumps(document(origin="https://user:pw@fleet.example.org")).encode(),
               json.dumps(document(sig="zz")).encode(),
               json.dumps(document(grant="has space")).encode(),
               json.dumps(document(expires=-5, issuedAt=stamp(-1))).encode(),
               json.dumps({k: v for k, v in document().items() if k != "grantId"}).encode()]
        for raw in bad:
            with self.assertRaises(fleet_binding.BindingError, msg=raw[:60]) as caught:
                fleet_binding.parse(raw)
            self.assertEqual(caught.exception.code, "invalid")
            self.assertIn("fleet-bind.json", caught.exception.fix)

    def test_loopback_http_is_allowed_for_local_testing_only(self):
        self.assertEqual(fleet_binding.normal_origin("http://127.0.0.1:8080/"), "http://127.0.0.1:8080")
        self.assertIsNone(fleet_binding.normal_origin("http://192.0.2.1"))
        self.assertIsNone(fleet_binding.normal_origin("ftp://fleet.example.org"))

    def test_an_expired_binding_is_refused(self):
        binding = fleet_binding.parse(json.dumps(document()).encode())
        fleet_binding.check_fresh(binding)
        with self.assertRaises(fleet_binding.BindingError) as caught:
            fleet_binding.check_fresh(binding, datetime.datetime.now(UTC) + datetime.timedelta(days=2))
        self.assertEqual(caught.exception.code, "expired")


class FindTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / "Downloads").mkdir()
        self.environ = {"HOME": str(self.home)}

    def write(self, directory, name, value):
        path = self.home / directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value if isinstance(value, str) else json.dumps(value))
        return path

    def find(self):
        with mock.patch.object(fleet_binding, "candidate_dirs", return_value=[self.home / "Downloads"]):
            return fleet_binding.find(environ=self.environ)

    def test_nothing_found(self):
        self.assertEqual(self.find()["state"], "none")

    def test_the_downloads_folder_is_searched_and_a_repeat_download_name_is_understood(self):
        self.write("Downloads", "fleet-bind.json", document(grantId="old"))
        newest = self.write("Downloads", "fleet-bind (1).json", document(grantId="new"))
        os.utime(newest, (4_000_000_000, 4_000_000_000))
        found = self.find()
        self.assertEqual((found["state"], found["binding"]["grantId"]), ("ok", "new"))

    def test_an_expired_file_is_reported_not_silently_used(self):
        self.write("Downloads", "fleet-bind.json", document(expires=-0.5, issuedAt=stamp(-2)))
        found = self.find()
        self.assertEqual(found["state"], "expired")
        self.assertIsNone(found["binding"])

    def test_an_invalid_file_is_reported(self):
        self.write("Downloads", "fleet-bind.json", "{broken")
        self.assertEqual(self.find()["state"], "invalid")

    def test_a_valid_file_beats_an_expired_one(self):
        self.write("Downloads", "fleet-bind.json", document(expires=-0.5, issuedAt=stamp(-2)))
        self.write("Downloads", "fleet-bind (2).json", document(grantId="fresh"))
        self.assertEqual(self.find()["binding"]["grantId"], "fresh")

    def test_an_explicit_file_overrides_the_search(self):
        path = self.write("elsewhere", "chosen.json", document(grantId="explicit"))
        found = fleet_binding.find(environ={"FLEET_BINDING_FILE": str(path)})
        self.assertEqual(found["binding"]["grantId"], "explicit")

    def test_the_public_view_never_carries_the_grant_or_signature(self):
        self.write("Downloads", "fleet-bind.json", document())
        view = fleet_binding.public(self.find(), None)
        self.assertEqual(view["state"], "ok")
        text = json.dumps(view)
        self.assertNotIn(GRANT, text)
        self.assertNotIn("c" * 64, text)
        self.assertEqual(view["origin"], "https://fleet.example.org")

    def test_a_different_configured_controller_is_a_mismatch(self):
        self.write("Downloads", "fleet-bind.json", document())
        view = fleet_binding.public(self.find(), "https://other.example.org")
        self.assertEqual(view["state"], "mismatch")
        self.assertIn("https://fleet.example.org", view["detail"])


class ControllerCheckTests(unittest.TestCase):
    def setUp(self):
        self.controller = FakeController()
        self.addCleanup(self.controller.close)
        self.binding = fleet_binding.parse(json.dumps(document(origin=self.controller.origin)).encode())

    def test_validates_read_only_and_sends_the_grant_only_to_the_bound_origin(self):
        self.controller.reply = (200, {"ok": True, "kind": "grant", "role": "ci", "state": "pending", "approval": "automatic"})
        result = fleet_binding.check_controller(self.binding)
        self.assertEqual(result, {"state": "ok", "role": "ci", "approval": "automatic"})
        path, body = self.controller.requests[0]
        self.assertEqual(path, "/v1/enrollment/check")
        self.assertEqual(body["enrollmentToken"], GRANT)
        self.assertEqual(body["binding"]["sig"], "c" * 64)

    def test_a_used_grant_is_reported_not_refused(self):
        self.controller.reply = (200, {"ok": True, "kind": "grant", "role": None, "state": "used", "approval": "manual"})
        self.assertEqual(fleet_binding.check_controller(self.binding)["state"], "used")

    def test_refusals_map_to_actionable_errors(self):
        for code, state in (("enrollment_grant_expired", "expired"), ("enrollment_grant_revoked", "revoked"),
                            ("enrollment_binding_invalid", "rejected"), ("enrollment_not_ready", "rejected")):
            self.controller.reply = (401, {"error": code, "message": "x"})
            with self.assertRaises(fleet_binding.BindingError, msg=code) as caught:
                fleet_binding.check_controller(self.binding)
            self.assertEqual(caught.exception.code, state)
            self.assertIn("Add node", caught.exception.fix)

    def test_an_outage_or_old_controller_does_not_block_but_is_flagged(self):
        for status in (404, 500, 503):
            self.controller.reply = (status, {"error": "x"})
            self.assertEqual(fleet_binding.check_controller(self.binding)["state"], "unreachable")
        self.controller.close()
        self.assertEqual(fleet_binding.check_controller(self.binding, timeout=2)["state"], "unreachable")

    def test_a_redirect_is_never_followed_so_the_grant_cannot_leave_the_bound_origin(self):
        self.controller.reply = (302, {})
        result = fleet_binding.check_controller(self.binding)
        self.assertEqual(result["state"], "unreachable")
        self.assertEqual(self.controller.redirect_hits, [])


class WizardBindingTests(WizardCase):
    def setUp(self):
        super().setUp()
        self.controller = FakeController()
        self.addCleanup(self.controller.close)
        self.file = self.root / "fleet-bind.json"
        extra = mock.patch.dict(os.environ, {"FLEET_BINDING_FILE": str(self.file), "FLEET_INSTALLER_URL": "",
                                             "FLEET_CONTROLLER_URL": ""})
        extra.start()
        self.addCleanup(extra.stop)
        probe = mock.patch.object(imaging, "probe", return_value=(None, 96 * 1024))
        probe.start()
        self.addCleanup(probe.stop)

    def bind(self, **changes):
        self.file.write_text(json.dumps(document(origin=self.controller.origin, **changes)))

    def test_no_file_means_the_wizard_asks_for_an_address_as_before(self):
        _status, scan = self.call("GET", "/api/scan")
        self.assertEqual(scan["binding"]["state"], "none")
        self.assertTrue(scan["source_required"])

    def test_the_binding_supplies_the_controller_so_nobody_types_an_address(self):
        self.bind()
        _status, scan = self.call("GET", "/api/scan")
        self.assertEqual(scan["binding"]["state"], "ok")
        self.assertEqual(scan["binding"]["origin"], self.controller.origin)
        self.assertFalse(scan["source_required"])
        self.assertEqual(self.wizard.installer_urls()[0], self.controller.origin + "/installers/assets/fleet-installer.iso")
        self.assertNotIn(GRANT, json.dumps(scan))

    def test_a_different_origin_is_refused_by_the_source_form_and_by_plans_of_every_mode(self):
        self.bind()
        self.call("GET", "/api/scan")
        status, body = self.call("POST", "/api/source", {"origin": "https://other.example.org"})
        self.assertEqual(status, 409)
        self.assertIn(self.controller.origin, body["error"])
        with mock.patch.dict(os.environ, {"FLEET_CONTROLLER_URL": "https://other.example.org"}):
            self.wizard.source = None
            _status, scan = self.call("GET", "/api/scan")
            self.assertEqual(scan["binding"]["state"], "mismatch")
            for mode in ({"mode": "usb", "disk_id": scan["usb"][0]["id"]}, {"mode": "here"}):
                status, body = self.call("POST", "/api/plan", mode)
                self.assertEqual(status, 409, mode)
                self.assertIn("bound to", body["error"])

    def test_an_expired_binding_is_flagged_but_does_not_block_making_a_usb(self):
        self.bind(expires=-0.5, issuedAt=stamp(-2))
        with mock.patch.dict(os.environ, {"FLEET_INSTALLER_URL": self.iso.as_uri()}):
            _status, scan = self.call("GET", "/api/scan")
            self.assertEqual(scan["binding"]["state"], "expired")
            self.assertIn("Add node", scan["binding"]["fix"])
            self.assertEqual(self.call("POST", "/api/plan", {"mode": "usb", "disk_id": scan["usb"][0]["id"]})[0], 200)


class WizardBindingHereTests(WizardCase):
    """In-place install with a binding. perform_install is replaced; nothing restarts."""

    def setUp(self):
        super().setUp()
        self.controller = FakeController()
        self.addCleanup(self.controller.close)
        self.file = self.root / "fleet-bind.json"
        for patch in (
            mock.patch.dict(os.environ, {"FLEET_BINDING_FILE": str(self.file), "FLEET_INSTALLER_URL": "", "FLEET_CONTROLLER_URL": "",
                                         "FLEET_OS": "Linux", "FLEET_EUID": "0", "FLEET_KEXEC": sys.executable,
                                         "FLEET_ISO_FS": "ext4", "FLEET_ALLOW_ANY_OS_INSTALL": "1"}),
            mock.patch.object(imaging, "probe", return_value=(None, 96 * 1024)),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.httpd.shutdown()
        self.start_server("Linux")
        self.file.write_text(json.dumps(document(origin=self.controller.origin)))
        _status, self.scan = self.call("GET", "/api/scan")

    def plan(self, **body):
        return self.call("POST", "/api/plan", {"mode": "here", "disk_id": self.scan["internal"]["id"], **body})

    def test_the_grant_becomes_the_enrollment_token_without_being_shown(self):
        self.controller.reply = (200, {"ok": True, "kind": "grant", "role": "ci", "state": "pending", "approval": "automatic"})
        status, plan = self.plan()
        self.assertEqual(status, 200, plan)
        self.assertEqual(self.wizard.plan["token"], GRANT)
        self.assertNotIn(GRANT, json.dumps(plan))
        finding = next(f for f in plan["findings"] if f["name"] == "enrollment-binding")
        self.assertEqual(finding["status"], "info")
        self.assertIn("ci role", finding["detail"])
        self.assertIn(self.controller.origin, finding["detail"])
        self.assertTrue(plan["ready"], plan["findings"])

    def test_a_role_less_grant_says_a_person_still_approves(self):
        _status, plan = self.plan()
        finding = next(f for f in plan["findings"] if f["name"] == "enrollment-binding")
        self.assertIn("approve it under Pending", finding["detail"])

    def test_an_expired_revoked_or_unknown_grant_refuses_before_anything_is_planned(self):
        for code in ("enrollment_grant_expired", "enrollment_grant_revoked", "enrollment_binding_invalid"):
            self.controller.reply = (401, {"error": code, "message": "x"})
            status, body = self.plan()
            self.assertEqual(status, 409, code)
            self.assertIn("nothing was erased", body["error"])
            self.assertIn("Add node", body["fix"])
            self.assertIsNone(self.wizard.plan)

    def test_a_used_grant_or_an_outage_warns_and_registration_decides(self):
        self.controller.reply = (200, {"ok": True, "kind": "grant", "role": "ci", "state": "used", "approval": "manual"})
        _status, plan = self.plan()
        finding = next(f for f in plan["findings"] if f["name"] == "enrollment-binding")
        self.assertEqual(finding["status"], "warn")
        self.assertIn("already used", finding["detail"])
        self.controller.reply = (503, {})
        _status, plan = self.plan()
        self.assertEqual(next(f for f in plan["findings"] if f["name"] == "enrollment-binding")["status"], "warn")

    def test_an_expired_binding_file_stops_an_in_place_install(self):
        self.file.write_text(json.dumps(document(origin=self.controller.origin, expires=-0.5, issuedAt=stamp(-2))))
        with mock.patch.dict(os.environ, {"FLEET_INSTALLER_URL": self.iso.as_uri()}):
            status, body = self.plan()
        self.assertEqual(status, 409)
        self.assertIn("expired", body["error"])
        self.assertEqual(self.controller.requests, [])

    def test_a_pasted_token_wins_and_the_grant_is_not_presented(self):
        _status, plan = self.plan(token="fleet-enroll.PastedToken_1")
        self.assertEqual(self.wizard.plan["token"], "fleet-enroll.PastedToken_1")
        self.assertEqual(self.controller.requests, [])
        self.assertFalse(any(f["name"] == "enrollment-binding" for f in plan["findings"]))


if __name__ == "__main__":
    unittest.main()
