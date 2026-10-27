#!/usr/bin/env python3
"""When the wizard fails: it never abandons a running helper, it explains what
to do next, and it hands over a report an agent or a GitHub issue can use.

Issue #140: on Windows the unelevated wizard could not read the progress file
the elevated helper created, reported a failure while the helper kept running,
and deleted the helper's folder from under it.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_wizard import WIZARD, Waitable, WizardCase  # noqa: E402

import decide  # noqa: E402
import diagnostics  # noqa: E402
import elevate  # noqa: E402
import helper  # noqa: E402
import imaging  # noqa: E402

ISSUE_140 = ("PermissionError: [Errno 13] Permission denied: "
             "'C:\\\\Users\\\\crvou\\\\AppData\\\\Local\\\\Temp\\\\fleet-job-8h9txxt5\\\\progress.jsonl'")


def file_sddl(path):
    """The DACL of a file or folder as SDDL, read back from Windows."""
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p,
                                             ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                                                            ctypes.POINTER(wintypes.LPWSTR), ctypes.c_void_p]
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    dacl_information, file_object = 4, 1
    descriptor = ctypes.c_void_p()
    code = advapi.GetNamedSecurityInfoW(str(path), file_object, dacl_information, None, None, None, None, ctypes.byref(descriptor))
    if code != 0:
        raise OSError(code, "GetNamedSecurityInfoW failed", str(path))
    try:
        text = wintypes.LPWSTR()
        if not advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, dacl_information, ctypes.byref(text), None):
            raise OSError(ctypes.get_last_error(), "ConvertSecurityDescriptorToStringSecurityDescriptorW failed")
        value = text.value
        kernel.LocalFree(text)
        return value
    finally:
        kernel.LocalFree(descriptor)


def trustee_in_sddl(sid):
    """How Windows writes this SID inside SDDL: a well-known one becomes an alias
    (the built-in Administrator, RID 500, prints as LA)."""
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                                                            ctypes.POINTER(wintypes.LPWSTR), ctypes.c_void_p]
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    descriptor = ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(f"D:(A;;FA;;;{sid})", 1, ctypes.byref(descriptor), None):
        raise OSError(ctypes.get_last_error(), "ConvertStringSecurityDescriptorToSecurityDescriptorW failed")
    try:
        text = wintypes.LPWSTR()
        if not advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, ctypes.byref(text), None):
            raise OSError(ctypes.get_last_error(), "ConvertSecurityDescriptorToStringSecurityDescriptorW failed")
        value = text.value
        kernel.LocalFree(text)
    finally:
        kernel.LocalFree(descriptor)
    return value.rsplit(";", 1)[1].rstrip(")")


@unittest.skipUnless(os.name == "nt", "needs the Windows security API")
class WindowsJobFolderTests(unittest.TestCase):
    def test_every_file_in_the_job_folder_grants_this_user_by_sid_whoever_owns_it(self):
        scratch = imaging.scratch_dir("fleet-acl-test-")
        try:
            (scratch / "progress.jsonl").write_text("{}\n", encoding="utf-8")
            user = trustee_in_sddl(imaging.windows_user_sid())
            folder, inside = file_sddl(scratch), file_sddl(scratch / "progress.jsonl")
            self.assertIn(f";;;{user})", folder)
            self.assertIn(f";;;{user})", inside, "inherited by files the elevated helper creates")
            self.assertNotIn(";;;OW)", folder, "OWNER RIGHTS would follow the Administrators owner instead of this user")
            self.assertNotIn(";;;WD)", folder, "the folder holds an enrollment token and must stay private")
            self.assertEqual((scratch / "progress.jsonl").read_text(encoding="utf-8"), "{}\n")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


class GuidanceTests(unittest.TestCase):
    def test_the_issue_140_failure_is_explained_and_can_be_retried(self):
        advice = diagnostics.guidance(ISSUE_140, "Read the log, then run the wizard again.", changed=True)
        self.assertIn("refused the installer access", advice["summary"])
        self.assertTrue(advice["retry"])
        self.assertIn("Close every other Fleet installer window, then press Try again.", advice["steps"])
        self.assertTrue(any("Copy diagnostic report" in step for step in advice["steps"]))
        self.assertIn("administrator step had started", advice["safety"])

    def test_common_failures_get_specific_recovery_steps(self):
        cases = {
            "The privileged step ended without a result (exit code 1). The permission prompt was probably declined.": "permission was not given",
            "this computer was not approved (nobody approved this node in time)": "did not approve",
            "the chosen disk is not present exactly once (path='/dev/sdb')": "disks changed",
            "the download does not match its checksum": "did not match its published checksum",
            "<urlopen error [Errno 8] nodename nor servname provided>": "network connection failed",
            "another installer may be writing this disk": "Another Fleet installer",
            "KeyError: 'path'": "unexpected error",
        }
        for message, summary in cases.items():
            with self.subTest(message=message):
                self.assertIn(summary, diagnostics.guidance(message)["summary"])

    def test_a_specific_fix_comes_first_and_no_safety_claim_is_made_without_knowledge(self):
        advice = diagnostics.guidance("that review has expired", "Review the disk and checks again.")
        self.assertEqual(advice["steps"][0], "Review the disk and checks again.")
        self.assertEqual(advice["safety"], "")
        self.assertEqual(diagnostics.guidance("x", changed=False)["safety"], "Nothing on this computer was erased or changed.")

    def test_an_environment_that_cannot_elevate_is_not_offered_a_retry(self):
        self.assertFalse(diagnostics.guidance("This computer cannot ask for administrator rights from here.")["retry"])


class HelperProgressTests(unittest.TestCase):
    def test_progress_that_cannot_be_written_never_stops_the_helper(self):
        with tempfile.TemporaryDirectory() as tmp:
            progress = helper.Progress(Path(tmp) / "gone")
            progress.emit("write", "Writing", 10)
            progress.emit("write", "Writing", 20)
            self.assertTrue(progress.failed)


class ReportTests(unittest.TestCase):
    def test_log_tails_are_redacted_and_a_missing_log_is_described(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "fleet.log"
            log.write_text("".join(f"line {n}\n" for n in range(500)) + "token hvs.CAESIsecret\n", encoding="utf-8")
            lines = diagnostics.tail(log, 3)
            self.assertEqual(lines, ["line 498", "line 499", "token [redacted]"])
            self.assertIn("could not read", diagnostics.tail(Path(tmp) / "missing.log")[0])

    def test_credentials_in_logged_environment_never_reach_a_report(self):
        line = ("env FLEET_ARCH=x86_64 FLEET_GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 "
                "GITHUB_TOKEN=github_pat_11ABCDEFG0123456789_abcdefghijklmnop FLEET_WIFI_PASSWORD=hunter2 note ghs_ABCDEFGHIJKLMNOPQRSTUVWX")
        redacted = decide.redact(line)
        for secret in ("ghp_abc", "github_pat_11", "hunter2", "ghs_ABC"):
            self.assertNotIn(secret, redacted)
        self.assertIn("FLEET_ARCH=x86_64", redacted)

    def test_a_long_report_is_shortened_to_fit_a_new_issue_address(self):
        build = lambda lines: "Fleet installer diagnostic\n" + "x" * 100 * lines  # noqa: E731
        url = diagnostics.issue_url("Fleet installer: failure", build)
        self.assertLessEqual(len(url), diagnostics.ISSUE_URL_MAX)
        body = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["diagnostic"][0]
        self.assertIn("shortened", body)
        self.assertIn("Fleet installer diagnostic", body)

    def test_the_issue_title_is_one_short_redacted_line(self):
        title = diagnostics.issue_title("bad token hvs.ABCDEF\nsecond line " + "y" * 200)
        self.assertEqual(title, "Fleet installer: bad token [redacted]")
        self.assertLessEqual(len(diagnostics.issue_title("z" * 500)), len("Fleet installer: ") + 90)


class FollowHelperTests(WizardCase):
    def start_job(self):
        _status, plan = self.usb_plan()
        status, reply = self.run_plan(plan)
        self.assertEqual(status, 200, reply)
        return self.wait_job()

    def test_unreadable_progress_keeps_waiting_for_the_helper_then_explains(self):
        release = threading.Event()
        running = threading.Thread(target=release.wait, args=(10,))
        reads = []

        def start(os_name, argv):
            running.start()
            return Waitable(running, 0)

        def denied(path, offset):
            reads.append(running.is_alive())
            if len(reads) >= 3:
                release.set()
            raise PermissionError(13, "Permission denied", str(path))

        with mock.patch.object(elevate, "start", start), mock.patch.object(elevate, "read_progress", denied):
            job = self.start_job()
        self.assertGreaterEqual(reads.count(True), 3, "the window kept following the running helper")
        self.assertFalse(running.is_alive())
        self.assertEqual(job["state"], "failed", job)
        self.assertIn("could not read the administrator step's result", job["result"]["message"])
        self.assertTrue(any("progress cannot be shown here" in line for line in job["log"]), job["log"])
        advice = job["result"]["guidance"]
        self.assertIn("administrator step had started", advice["safety"], "unknown progress assumes the disk may have changed")
        self.assertTrue(advice["retry"])

    def test_the_job_folder_outlives_a_running_helper_even_when_following_it_breaks(self):
        seen = {}

        def body():
            time.sleep(0.5)
            seen["folder"] = Path(seen["directory"]).is_dir()

        def start(os_name, argv):
            seen["directory"] = argv[-1]
            thread = threading.Thread(target=body)
            thread.start()
            seen["thread"] = thread
            return Waitable(thread, 0)

        def broken(path, offset):
            raise ValueError("progress parser broke")

        with mock.patch.object(elevate, "start", start), mock.patch.object(elevate, "read_progress", broken):
            job = self.start_job()
        self.assertFalse(seen["thread"].is_alive(), "the failure waited for the helper")
        self.assertTrue(seen["folder"], "the folder stayed while the helper ran")
        self.assertFalse(Path(seen["directory"]).exists(), "and was removed afterwards")
        self.assertEqual(job["state"], "failed")
        self.assertIn("progress parser broke", job["result"]["message"])

    def test_a_failure_before_the_helper_says_nothing_changed(self):
        self.sumfile.write_text("0" * 64 + "  fleet-installer.iso\n")
        job = self.start_job()
        self.assertEqual(job["state"], "failed")
        advice = job["result"]["guidance"]
        self.assertEqual(advice["safety"], "Nothing on this computer was erased or changed.")
        self.assertIn("checksum", advice["summary"])


class DiagnosticEndpointTests(WizardCase):
    def test_a_failed_job_report_has_the_failure_this_computer_and_the_redacted_log(self):
        self.sumfile.write_text("0" * 64 + "  fleet-installer.iso\n")
        _status, plan = self.usb_plan()
        self.assertEqual(self.run_plan(plan)[0], 200)
        self.wait_job()
        decide.log("vault said hvs.CAESIsecretvalue")
        status, reply = self.call("POST", "/api/diagnostic", {})
        self.assertEqual(status, 200, reply)
        report = reply["report"]
        for needed in ("Fleet installer diagnostic", "does not match its checksum", "## System", "Version: ", "Arch: ",
                       "Administrator: ", "Mode: usb", "State: failed", "## Job steps", f"## Log {decide.LOG['path']}",
                       "packages/fleet/wizard", "Explanation: The downloaded installer did not match"):
            self.assertIn(needed, report)
        self.assertNotIn("CAESIsecretvalue", report)
        self.assertIn("[redacted]", report)
        url = reply["issue_url"]
        self.assertTrue(url.startswith(f"https://github.com/{decide.REPO}/issues/new?"), url)
        self.assertLessEqual(len(url), diagnostics.ISSUE_URL_MAX)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertTrue(query["title"][0].startswith("Fleet installer: "), query["title"])
        self.assertFalse(query["title"][0].startswith("fleet-enroll"), "never mistaken for an enrollment request")
        self.assertEqual(query["template"], [decide.ISSUE_FORM])
        self.assertIn("does not match its checksum", query["diagnostic"][0])
        self.assertTrue(query["step"][0].startswith("Wizard on "), query["step"])

    def test_an_error_the_page_met_outside_a_job_is_reported(self):
        problem = {"message": "that review has expired", "fix": "Review the disk and checks again.", "where": "review", "ignored": "x"}
        status, reply = self.call("POST", "/api/diagnostic", {"problem": problem})
        self.assertEqual(status, 200, reply)
        self.assertIn("Where: review", reply["report"])
        self.assertIn("Result: that review has expired", reply["report"])
        self.assertIn("- Review the disk and checks again.", reply["report"])
        self.assertNotIn("ignored", reply["report"])
        self.assertEqual(self.call("POST", "/api/diagnostic", {"problem": "text"})[0], 409)

    def test_refusals_carry_recovery_guidance(self):
        status, reply = self.call("POST", "/api/run", {"plan_id": "nope", "ack": True, "disk_id": "x"})
        self.assertEqual(status, 409)
        self.assertIn("Go back and review the plan again.", reply["guidance"]["steps"])
        self.assertEqual(reply["guidance"]["safety"], "")


class PermissionPromptTests(WizardCase):
    """The window and the helper agree on one atomic step, the helper claiming its request.
    Before it, Cancel withdraws the request; after it, the helper runs to the end."""

    def start_job(self):
        _status, plan = self.usb_plan()
        status, reply = self.run_plan(plan)
        self.assertEqual(status, 200, reply)

    def wait_for(self, condition, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            _status, job = self.call("GET", "/api/job")
            if condition(job):
                return job
            time.sleep(0.05)
        self.fail(f"never reached the expected state: {job}")

    def test_cancel_while_the_prompt_is_open_withdraws_the_request_and_changes_nothing(self):
        accepted, seen = threading.Event(), {}

        def prompt_then_helper(directory):
            accepted.wait(10)  # the person answers the prompt only after pressing Cancel
            seen["code"] = helper.run(directory)
            seen["result"] = json.loads((Path(directory) / "result.json").read_text())

        def start(os_name, argv):
            seen["directory"] = argv[-1]
            thread = threading.Thread(target=prompt_then_helper, args=(argv[-1],))
            thread.start()
            seen["thread"] = thread
            return Waitable(thread, 1)

        with mock.patch.object(elevate, "start", start):
            self.start_job()
            job = self.wait_for(lambda job: job["state"] == "working" and job["cancellable"])
            self.assertEqual(self.call("POST", "/api/cancel", {})[0], 200)
            job = self.wait_for(lambda job: job["state"] == "cancelled")
            accepted.set()
            seen["thread"].join(10)
        self.assertIn("Nothing was changed", job["result"]["message"])
        self.assertTrue(seen["result"]["withdrawn"], "the helper found its request withdrawn and did nothing")
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)
        end = time.time() + 5
        while Path(seen["directory"]).exists() and time.time() < end:
            time.sleep(0.05)
        self.assertFalse(Path(seen["directory"]).exists(), "the folder is cleaned once the prompt closes")
        _status, plan = self.usb_plan()
        self.assertEqual(self.run_plan(plan)[0], 200, "a new attempt can start right away")
        self.wait_job()  # let it finish before the test folder is removed

    def test_cancel_after_the_helper_claimed_its_request_is_refused(self):
        release, seen = threading.Event(), {}

        def claimed(directory):
            os.replace(Path(directory) / helper.REQUEST, Path(directory) / helper.CLAIMED)
            release.wait(10)

        def start(os_name, argv):
            thread = threading.Thread(target=claimed, args=(argv[-1],))
            thread.start()
            seen["thread"] = thread
            return Waitable(thread, 1)

        with mock.patch.object(elevate, "start", start):
            self.start_job()
            self.wait_for(lambda job: job["state"] == "working")
            time.sleep(0.2)
            status, reply = self.call("POST", "/api/cancel", {})
            self.assertEqual(status, 409, reply)
            self.assertIn("already started", reply["error"])
            self.assertEqual(self.call("POST", "/api/quit", {})[0], 409, "quitting mid-step could leave a disk half written")
            release.set()
            job = self.wait_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("stopped without reporting a result", job["result"]["message"], "not 'the prompt was probably declined'")
        self.assertIn("administrator step had started", job["result"]["guidance"]["safety"])

    def test_a_helper_that_never_started_is_still_a_declined_prompt(self):
        with mock.patch.object(elevate, "start", lambda os_name, argv: Waitable(None, 1)):
            self.start_job()
            job = self.wait_job()
        self.assertIn("permission prompt was probably declined", job["result"]["message"])
        self.assertEqual(job["result"]["guidance"]["summary"], "Administrator permission was not given.")
        self.assertIn("Nothing on this computer", job["result"]["guidance"]["safety"])


class ApprovalReuseTests(unittest.TestCase):
    def test_a_retry_reuses_this_sessions_unused_approval(self):
        import server
        wizard = server.Wizard("Linux")
        wizard.approved["ci"] = "hvs.earlier"
        job = server.Job()
        lookup = mock.Mock(return_value={"status": "ok", "detail": "", "fix": ""})
        with mock.patch.dict(decide.NET, {"lookup": lookup}), mock.patch.object(decide, "self_enroll") as enroll:
            plan = wizard.enroll(job, {"role": "ci", "token": None})
        enroll.assert_not_called()
        self.assertEqual(plan["token"], "hvs.earlier")
        lookup.return_value = {"status": "fail", "detail": "used", "fix": ""}
        with mock.patch.dict(decide.NET, {"lookup": lambda token, role: {"status": "ok" if token == "hvs.new" else "fail", "detail": "", "fix": ""}}), \
                mock.patch.object(decide, "self_enroll", return_value=("hvs.new", None)) as enroll:
            plan = wizard.enroll(job, {"role": "ci", "token": None})
        enroll.assert_called_once()
        self.assertEqual(plan["token"], "hvs.new", "a used or expired approval is replaced by a fresh one")


class GuidanceMatchingTests(unittest.TestCase):
    def test_failed_restart_cancellation_explains_why_staged_files_remain(self):
        advice = diagnostics.guidance("the scheduled restart could not be confirmed cancelled", decide.WINDOWS_RESTART_RECOVERY_FIX, changed=True)
        self.assertIn("restart scheduled", advice['summary'])
        self.assertIn("staged boot files", advice['summary'])
        self.assertIn("shutdown /a", advice['steps'][0])
        self.assertTrue(advice['retry'])

    def test_a_boot_layout_failure_does_not_assume_the_installer_is_old(self):
        advice = diagnostics.guidance("the installer image does not have the boot layout this installer expects", decide.NEWER_RELEASE_FIX)
        self.assertIn("boot files", advice["summary"])
        self.assertNotIn("older", advice["summary"])
        self.assertTrue(any("already have the latest" in step for step in advice["steps"]))
        self.assertFalse(advice["retry"])

    def test_words_in_the_fix_do_not_change_what_the_failure_is(self):
        advice = diagnostics.guidance("The Wi-Fi password must be 8 to 63 characters", "Check the Wi-Fi network name and password.")
        self.assertNotIn("network connection", advice["summary"])
        self.assertEqual(advice["steps"][0], "Check the Wi-Fi network name and password.")

    def test_a_release_newer_than_the_installer_is_not_offered_a_pointless_retry(self):
        advice = diagnostics.guidance("the installer parts manifest has an unsupported format (version=2)", decide.NEWER_RELEASE_FIX)
        self.assertFalse(advice["retry"])
        self.assertIn("older than the published release", advice["summary"])

    def test_the_command_line_fix_is_not_shown_in_the_wizard(self):
        advice = diagnostics.guidance("something", "Run `fleet-node doctor` and read the log; do not retry blindly.")
        self.assertFalse(any("fleet-node doctor" in step for step in advice["steps"]))

    def test_a_publication_in_progress_is_named(self):
        advice = diagnostics.guidance("the installer release kept changing while it was downloaded (minutes=15)")
        self.assertIn("being published", advice["summary"])


class HelperLogTailTests(unittest.TestCase):
    def test_a_helper_log_the_window_cannot_open_is_replaced_by_its_reported_end(self):
        job = {"state": "failed", "result": {"message": "x", "log": "/root/.fleet/logs/helper.log", "log_tail": ["helper line one", "token hvs.SECRET"]}}
        report = diagnostics.report("v", [], job)
        self.assertIn("helper line one", report)
        self.assertIn("token [redacted]", report)


class DetachedHelperTests(unittest.TestCase):
    def test_the_helper_survives_the_terminal_closing(self):
        with mock.patch.dict(os.environ, {"FLEET_ELEVATE": "none"}), mock.patch.object(elevate.subprocess, "Popen") as popen:
            elevate.start("Linux", ["helper"])
        self.assertTrue(popen.call_args.kwargs.get("start_new_session"))


class DiagnosticPageTests(unittest.TestCase):
    def test_the_page_offers_retry_copy_and_issue_actions(self):
        html = (WIZARD / "index.html").read_text(encoding="utf-8")
        for needed in ("/api/diagnostic", "Copy diagnostic report", "Report on GitHub", "Try again", "onclick=\"retry()\"",
                       "navigator.clipboard.writeText", "opened.opener = null"):
            self.assertIn(needed, html)


if __name__ == "__main__":
    unittest.main()
