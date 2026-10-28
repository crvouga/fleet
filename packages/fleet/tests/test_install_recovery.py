#!/usr/bin/env python3
"""Recovery and version skew outside Windows staging: running again after an interrupted
attempt heals instead of refusing, state written by older versions is still read, and a
release this installer cannot understand says to download the latest installer."""

import http.client
import json
import os
import ssl
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import imaging  # noqa: E402


class Folder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)


class MarkerCompatibilityTest(Folder):
    def test_markers_from_older_installers_still_read_without_their_role(self):
        for role in ("ci", "devbox", "unknown", "mainframe"):
            (self.root / "installed").write_text(f"role={role}\nstatus=installed\n")
            self.assertEqual(decide.checked_marker(self.root, "installed"), {"status": "installed"})
            self.assertTrue(decide.installed(self.root))
        (self.root / "withdrawn").write_text("status=withdrawn\nrole=unknown\n")
        self.assertEqual(decide.checked_marker(self.root, "withdrawn"), {"status": "withdrawn"})
        self.assertFalse(decide.installed(self.root), "a withdrawn node is reinstalled to rejoin")

    def test_a_malformed_marker_is_still_corruption(self):
        (self.root / "installed").write_text("status=staged\n")
        with self.assertRaises(decide.Invariant):
            decide.checked_marker(self.root, "installed")


class JobAdmissionTest(Folder):
    """A node that runs CI jobs is idle and closed to new jobs before its disk can
    be erased; a handoff that fails before the reboot opens admission again."""

    def setUp(self):
        super().setUp()
        self.iso = self.root / "fleet-installer.iso"
        self.iso.write_bytes(b"iso")
        self.busy = self.root / "busy"
        self.busy.mkdir()
        self.runner = self.root / "runner.conf"
        self.runner.write_text("scope=repository\n")
        self.resumed = self.root / "resumed"
        resume = self.root / "resume"
        resume.write_text(f"#!/bin/sh\ntouch {self.resumed}\nrm -f {self.busy}/draining\n")
        resume.chmod(0o755)
        env = {"FLEET_BUSY_DIR": str(self.busy), "FLEET_RESUME": str(resume), "FLEET_RUNNER_CONF": str(self.runner)}
        for patch in (mock.patch.dict(os.environ, env), mock.patch.object(decide, "wifi_profile", return_value=None),
                      mock.patch.object(decide, "check_installer_readiness")):
            patch.start()
            self.addCleanup(patch.stop)

    def install(self, staged):
        seen = {}

        def stage(*args, **kwargs):
            seen["draining"] = (self.busy / "draining").exists()
            seen["handoff"] = (self.root / "handoff").read_text()
            return staged
        with mock.patch.object(decide, "stage_reboot", stage):
            code = decide.perform_install("Linux", str(self.iso), None, self.root, {"ok": True, "disk_id": "x"})
        return code, seen

    def test_admission_is_closed_before_the_handoff_and_the_handoff_names_no_role(self):
        code, seen = self.install(0)
        self.assertEqual(code, 0)
        self.assertTrue(seen["draining"])
        self.assertEqual(seen["handoff"], "disk=x\nstatus=staged\n")
        self.assertFalse((self.root / "withdrawn").exists(), "a reinstall never withdraws the runner")

    def test_a_failed_handoff_reopens_admission(self):
        code, _ = self.install(1)
        self.assertEqual(code, 1)
        self.assertTrue(self.resumed.exists())
        self.assertFalse((self.busy / "draining").exists())
        self.assertFalse((self.busy / "agent-drained").exists())
        self.assertFalse((self.root / "handoff").exists())

    def test_a_running_job_stops_the_install_before_anything_is_staged(self):
        (self.busy / "slot-1").mkdir()
        (self.busy / "slot-1/busy").write_text("running\n")
        with self.assertRaisesRegex(decide.Invariant, "job started"):
            self.install(0)
        self.assertFalse((self.root / "handoff").exists())

    def test_a_machine_without_runner_slots_is_not_drained(self):
        self.runner.unlink()
        code, seen = self.install(1)
        self.assertEqual(code, 1)
        self.assertFalse(seen["draining"])
        self.assertFalse(self.resumed.exists())

    def test_an_intentional_removal_is_never_undone(self):
        (self.root / "withdrawn").write_text("status=withdrawn\n")
        self.assertEqual(self.install(1)[0], 1)
        self.assertTrue((self.root / "withdrawn").exists())


class KexecTest(Folder):
    def test_a_kexec_that_cannot_start_unloads_the_kernel_holding_the_token(self):
        kernel, initrd = self.root / "kernel", self.root / "initrd"
        kernel.write_bytes(b"k")
        initrd.write_bytes(b"i")
        iso = self.root / "fleet-installer.iso"
        iso.write_bytes(b"iso")
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(returncode=1 if command[1:] == ["-e"] else 0, stdout="", stderr="")

        with mock.patch.dict(os.environ, {"FLEET_ISO_FS": "ext4"}), \
                mock.patch.object(decide, "os_boot_tool", return_value="kexec"), \
                mock.patch.object(decide.shutil, "which", return_value="/sbin/kexec"), \
                mock.patch.object(decide, "extract_boot", return_value=(str(kernel), str(initrd), "fleet.role=ci")), \
                mock.patch.object(decide, "run_logged", run), mock.patch.object(decide, "say"):
            self.assertEqual(decide.stage_reboot("Linux", str(iso), token="enroll-token-123"), 1)
        self.assertEqual(calls[-1], ["kexec", "-u"])
        load = " ".join(calls[0])
        self.assertNotIn("enroll-token-123", load)
        self.assertNotIn("fleet.role=", load)
        self.assertIn("--initrd=" + str(self.root / "initrd-handoff"), load)
        self.assertFalse((self.root / "initrd-handoff").exists(), "the private handoff does not outlive the attempt")


class StagedCopySpaceTest(Folder):
    def test_a_staged_copy_from_an_earlier_attempt_counts_as_free_space(self):
        size = 4 * 1024 ** 3
        (self.root / "fleet-installer.iso").write_bytes(b"")
        os.truncate(self.root / "fleet-installer.iso", size)
        usage = SimpleNamespace(total=1, used=1, free=size // 2)
        with mock.patch.dict(decide.NET, {"probe": lambda: (None, size)}), \
                mock.patch.object(decide.shutil, "disk_usage", return_value=usage), \
                mock.patch.dict(os.environ, {"FLEET_EUID": "0", "FLEET_ARCH": "x86_64"}):
            found = {item["name"]: item for item in decide.preflight("Linux", "media", None, self.root, need_root=False)}
        self.assertEqual(found["space"]["status"], "ok", found["space"])


class NewerReleaseTest(Folder):
    def test_a_parts_manifest_from_a_newer_release_says_to_download_the_latest_installer(self):
        (self.root / "fleet-installer.iso.parts.json").write_text(json.dumps({"version": 2, "parts": []}))
        url = (self.root / "fleet-installer.iso").as_uri()
        with self.assertRaises(decide.Invariant) as caught:
            decide.installer_parts(url)
        self.assertIn("latest Fleet installer", caught.exception.fix)
        error, size = imaging.probe(url)
        self.assertIsNone(size)
        self.assertIn("latest Fleet installer", error, "the scan explains it instead of failing")

    def test_a_readiness_manifest_from_a_newer_release_says_so(self):
        release = self.root / "release"
        release.mkdir()
        for document in ({"version": 3}, {"version": 1, "roles": {}}):
            (release / "fleet-installer.readiness.json").write_text(json.dumps(document))
            with mock.patch.object(decide.wifi_module(), "simulated", return_value=False), self.assertRaises(decide.Invariant) as caught:
                decide.check_release_readiness("0" * 64, (release / "fleet-installer.iso").as_uri())
            self.assertIn("latest Fleet installer", caught.exception.fix)
        (release / "fleet-installer.readiness.json").write_text(json.dumps({"version": 2}))
        with mock.patch.object(decide.wifi_module(), "simulated", return_value=False), self.assertRaises(decide.Invariant) as caught:
            decide.check_release_readiness("0" * 64, (release / "fleet-installer.iso").as_uri())
        self.assertIn("newer than this installer", caught.exception.what)


class PublicationTest(unittest.TestCase):
    def test_a_release_being_published_is_waited_for_then_used(self):
        answers = [decide.ReleaseChanging("publishing"), decide.ReleaseChanging("publishing"), "sha"]
        notes = []

        def action():
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        self.assertEqual(imaging.retry(action, notes.append, publish_wait=5, attempts=1), "sha")
        self.assertTrue(all("being published" in note for note in notes), notes)

    def test_a_release_that_never_settles_ends_with_what_to_do(self):
        def action():
            raise decide.ReleaseChanging("publishing")

        started = time.monotonic()
        with self.assertRaises(decide.Invariant) as caught:
            imaging.retry(action, publish_wait=0.3)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("Fleet workflow finishes", caught.exception.fix)

    def test_a_download_does_not_retry_a_changed_release_against_its_stale_checksum(self):
        calls = []

        def once(*args):
            calls.append(1)
            raise decide.ReleaseChanging("a part changed")

        with mock.patch.object(imaging, "_download_once", once), self.assertRaises(decide.ReleaseChanging):
            imaging.download("file:///nowhere", "/tmp/x", "0" * 64)
        self.assertEqual(len(calls), 1)

    def test_tls_cut_mid_transfer_is_retried_but_a_certificate_failure_is_not(self):
        self.assertTrue(imaging.transient(ssl.SSLEOFError(8, "EOF occurred in violation of protocol")))
        self.assertFalse(imaging.transient(ssl.SSLCertVerificationError(1, "certificate verify failed")))
        self.assertTrue(imaging.transient(http.client.IncompleteRead(b"")))


class PartialSweepTest(Folder):
    def test_abandoned_partials_are_removed_and_live_ones_kept(self):
        dest = self.root / "fleet-installer.iso"
        old, live = self.root / "fleet-installer.iso.abc.partial", self.root / "fleet-installer.iso.def.partial"
        old.write_bytes(b"old")
        live.write_bytes(b"live")
        hours_ago = time.time() - 2 * imaging.PARTIAL_STALE
        os.utime(old, (hours_ago, hours_ago))
        imaging.sweep_partials(dest)
        self.assertFalse(old.exists())
        self.assertTrue(live.exists())


class BootOptionDescriptionTest(unittest.TestCase):
    def test_the_description_is_read_back_from_a_load_option(self):
        option = decide.efi_load_option(decide.BOOT_DESCRIPTION, [decide.EFI_END_NODE])
        self.assertEqual(decide.boot_option_description(option), decide.BOOT_DESCRIPTION)
        self.assertIsNone(decide.boot_option_description(struct.pack("<IH", 1, 4) + b"x"))


if __name__ == "__main__":
    unittest.main()
