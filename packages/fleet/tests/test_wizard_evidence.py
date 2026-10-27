#!/usr/bin/env python3
"""Diagnostic evidence must survive elevation, inaccessible logs and URL limits."""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_wizard import Waitable, WizardCase  # noqa: E402

import decide  # noqa: E402
import diagnostics  # noqa: E402
import elevate  # noqa: E402
import helper  # noqa: E402
import server  # noqa: E402


class EvidenceTests(unittest.TestCase):
    def test_compact_issue_keeps_check_evidence_and_source_without_logs(self):
        checks = diagnostics.check_snapshot("helper preflight", [
            {"name": "firmware", "status": "fail", "detail": "probe could not read firmware", "fix": "Read the probe error."},
            {"name": "enrollment", "status": "ok", "detail": "token hvs.SECRET", "request": {"password": "never serialize me"}},
        ])
        job = {"attempt": "a" * 16, "elapsed": 1.2, "result": {
            "message": "a check failed", "checks": [checks],
            "error": {"type": "Invariant", "frames": ["helper.py:123 in install_here"]},
        }, "log": ["noise" * 200] * 120}
        build = lambda lines: diagnostics.report("version", [], job, lines=lines)
        url = diagnostics.issue_url("Fleet installer: check failed", build, "Wizard on Windows: set up this computer, failed")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        body = query["diagnostic"][0]
        self.assertEqual(query["template"], ["fleet-installer.yml"])
        self.assertEqual(query["step"], ["Wizard on Windows: set up this computer, failed"])
        self.assertLessEqual(len(url), diagnostics.ISSUE_URL_MAX)
        for needed in ("Attempt: " + "a" * 16, "FAIL firmware", "probe could not read firmware", "helper.py:123"):
            self.assertIn(needed, body)
        self.assertNotIn("never serialize me", build(120))
        self.assertNotIn("hvs.SECRET", build(120))

    def test_unicode_report_still_fits_and_says_it_was_shortened(self):
        url = diagnostics.issue_url("Fleet installer: failure", lambda lines: "Failure first\n" + "故障🔧" * 10000)
        self.assertLessEqual(len(url), diagnostics.ISSUE_URL_MAX)
        body = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["diagnostic"][0]
        self.assertIn("Failure first", body)
        self.assertTrue(body.endswith("attach fleet-diagnostic.txt.)"))

    def test_log_messages_do_not_replace_the_last_actual_step_or_inflate_timeline(self):
        job = server.Job()
        job.note("writing", step="write")
        for number in range(100):
            job.note(f"detail {number}", step="log")
        snapshot = job.snapshot()
        self.assertEqual(snapshot["step"], "write")
        self.assertEqual(len(snapshot["timeline"]), 1)

    def test_terminal_duration_is_frozen_and_retries_get_a_new_attempt(self):
        with mock.patch.object(server.time, "monotonic", return_value=10):
            job = server.Job()
            job.move("downloading")
        with mock.patch.object(server.time, "monotonic", return_value=15):
            job.move("failed", {"ok": False})
        with mock.patch.object(server.time, "monotonic", return_value=100):
            self.assertEqual(job.snapshot()["elapsed"], 5)
        self.assertNotEqual(job.attempt, server.Job().attempt)

    def test_helper_records_os_error_source_and_checks_without_request_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "job"
            directory.mkdir()
            request = {"action": "write-usb", "attempt": "a" * 16,
                       "wifi": {"password": "never serialize me"}, "token": "hvs.SECRET"}
            (directory / helper.REQUEST).write_text(json.dumps(request))

            def failed(request, progress):
                progress.record_checks("helper preflight", [{"name": "disk", "status": "ok", "detail": "present"}])
                progress.emit("write", "Writing")
                raise PermissionError(13, "test access denied")

            with mock.patch.dict(os.environ, {"FLEET_STATE": str(root / "state")}), \
                    mock.patch.dict(decide.LOG, {"path": None}, clear=True), \
                    mock.patch.object(helper, "write_usb", failed):
                self.assertEqual(helper.run(directory), 1)
            result = json.loads((directory / "result.json").read_text())
            self.assertEqual(result["error"]["errno"], 13)
            self.assertEqual(result["error"]["type"], "PermissionError")
            self.assertTrue(any("in failed" in frame for frame in result["error"]["frames"]))
            self.assertEqual(result["helper"]["step"], "write")
            self.assertEqual(result["checks"][0]["stage"], "helper preflight")
            self.assertNotIn("never serialize me", json.dumps(result))
            self.assertNotIn("hvs.SECRET", json.dumps(result))
            self.assertEqual(json.loads((directory / helper.CLAIMED).read_text()), {})


class DiagnosticHandoffTests(WizardCase):
    def test_failed_helper_evidence_survives_server_cleanup_and_unreadable_log(self):
        seen = {}
        finished = threading.Event()
        run_helper = self.wizard.run_helper

        def run_and_signal(*args):
            try:
                return run_helper(*args)
            finally:
                finished.set()

        def start(os_name, argv):
            directory = Path(argv[-1])
            request = json.loads((directory / helper.REQUEST).read_text())
            seen["attempt"] = request["attempt"]
            seen["directory"] = directory
            result = {
                "ok": False, "message": "test refusal", "fix": "read evidence",
                "log": str(self.root / "unreadable-helper.log"), "log_tail": ["helper evidence hvs.SECRET"],
                "checks": [diagnostics.check_snapshot("helper preflight", [
                    {"name": "disk", "status": "fail", "detail": "device changed", "fix": "Review again."},
                ])],
                "helper": {"pid": 42, "step": "verify"},
                "error": {"type": "Invariant", "frames": ["helper.py:123 in install_here"]},
            }
            (directory / "result.json").write_text(json.dumps(result))
            return Waitable(None, 1)

        with mock.patch.object(elevate, "start", start), \
                mock.patch.object(self.wizard, "run_helper", side_effect=run_and_signal):
            status, plan = self.usb_plan()
            self.assertEqual(status, 200, plan)
            self.assertEqual(self.run_plan(plan)[0], 200)
            job = self.wait_job()
            # Terminal state is published before run_helper's finally removes
            # the job folder. Wait for that boundary, including on Windows.
            self.assertTrue(finished.wait(10), "helper cleanup did not finish")
        self.assertFalse(seen["directory"].exists())
        self.assertEqual(job["attempt"], seen["attempt"])
        self.assertEqual(job["image"]["sha256"], self.sha)
        self.assertEqual(job["result"]["helper"]["pid"], 42)
        status, reply = self.call("POST", "/api/diagnostic", {})
        self.assertEqual(status, 200, reply)
        for needed in (seen["attempt"], "helper evidence [redacted]", "FAIL disk: device changed",
                       "helper.py:123", "## Timeline", self.sha):
            self.assertIn(needed, reply["report"])
        self.assertNotIn("hvs.SECRET", reply["report"])
        # Reviewing a retry must not misattribute the previous helper's evidence.
        self.assertEqual(self.usb_plan()[0], 200)
        status, retry = self.call("POST", "/api/diagnostic", {})
        self.assertEqual(status, 200, retry)
        self.assertIn("State: review", retry["report"])
        self.assertNotIn("helper.py:123", retry["report"])

    def test_review_diagnostic_includes_findings_before_starting_a_job(self):
        disks = json.loads(self.disks.read_text())
        for disk in disks:
            if disk.get("usb"):
                disk["size"] = 1
        self.disks.write_text(json.dumps(disks))
        status, plan = self.usb_plan()
        self.assertEqual(status, 200, plan)
        self.assertFalse(plan["ready"])
        status, reply = self.call("POST", "/api/diagnostic", {"problem": {"message": "review failed", "where": "review"}})
        self.assertEqual(status, 200, reply)
        self.assertIn("Stage: review", reply["report"])
        self.assertIn("FAIL usb-size", reply["report"])
        self.assertIn("State: review", reply["report"])


if __name__ == "__main__":
    unittest.main()
