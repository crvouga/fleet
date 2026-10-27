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
    def test_a_withdrawn_marker_from_an_older_fleet_remove_is_still_read(self):
        (self.root / "withdrawn").write_text("status=withdrawn\nrole=unknown\n")
        marker = decide.checked_marker(self.root, "withdrawn")
        self.assertEqual(marker, {"status": "withdrawn"})
        self.assertFalse(decide.installed_for("ci", self.root))

    def test_other_unknown_roles_are_still_corruption(self):
        (self.root / "installed").write_text("status=installed\nrole=unknown\n")
        with self.assertRaises(decide.Invariant):
            decide.checked_marker(self.root, "installed")
        (self.root / "withdrawn").write_text("status=withdrawn\nrole=mainframe\n")
        with self.assertRaises(decide.Invariant):
            decide.checked_marker(self.root, "withdrawn")


class InterruptedReinstallTest(Folder):
    """An earlier attempt was killed after withdrawing the CI runner and before its cleanup."""

    def setUp(self):
        super().setUp()
        self.iso = self.root / "fleet-installer.iso"
        self.iso.write_bytes(b"iso")
        (self.root / "withdrawn").write_text("status=withdrawn\nrole=ci\n")
        (self.root / "handoff").write_text("role=ci\ndisk=x\nstatus=staged\nrestore_ci=1\n")
        busy = self.root / "busy"
        busy.mkdir()
        resume = self.root / "resume"
        resume.write_text("#!/bin/sh\nexit 0\n")
        resume.chmod(0o755)
        env = {"FLEET_BUSY_DIR": str(busy), "FLEET_RESUME": str(resume)}
        for patch in (mock.patch.dict(os.environ, env), mock.patch.object(decide, "wifi_profile", return_value=None),
                      mock.patch.object(decide, "check_installer_readiness"), mock.patch.object(decide, "retire_runner_for_install")):
            patch.start()
            self.addCleanup(patch.stop)

    def install(self, staged):
        with mock.patch.object(decide, "stage_reboot", return_value=staged):
            return decide.perform_install("Linux", "ci", str(self.iso), None, None, self.root, {"ok": True, "disk_id": "x"})

    def test_a_successful_retry_keeps_the_duty_to_restore_the_runner(self):
        self.assertEqual(self.install(0), 0)
        self.assertIn("restore_ci=1", (self.root / "handoff").read_text())

    def test_a_failed_retry_restores_the_runner_it_inherited(self):
        self.assertEqual(self.install(1), 1)
        self.assertFalse((self.root / "withdrawn").exists(), "the inherited withdrawal is undone, not left forever")
        self.assertFalse((self.root / "handoff").exists())

    def test_an_intentional_removal_is_never_undone(self):
        (self.root / "handoff").unlink()
        self.assertEqual(self.install(1), 1)
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
            self.assertEqual(decide.stage_reboot("Linux", "ci", str(iso), token="hvs.token"), 1)
        self.assertEqual(calls[-1], ["kexec", "-u"])


class StagedCopySpaceTest(Folder):
    def test_a_staged_copy_from_an_earlier_attempt_counts_as_free_space(self):
        size = 4 * 1024 ** 3
        (self.root / "fleet-installer.iso").write_bytes(b"")
        os.truncate(self.root / "fleet-installer.iso", size)
        usage = SimpleNamespace(total=1, used=1, free=size // 2)
        with mock.patch.dict(decide.NET, {"probe": lambda: (None, size)}), \
                mock.patch.object(decide.shutil, "disk_usage", return_value=usage), \
                mock.patch.dict(os.environ, {"FLEET_NO_ENROLL": "1", "FLEET_EUID": "0", "FLEET_ARCH": "x86_64"}):
            found = {item["name"]: item for item in decide.preflight("Linux", None, "media", None, self.root, need_root=False)}
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
        (release / "fleet-installer.readiness.json").write_text(json.dumps({"version": 2}))
        with mock.patch.object(decide.wifi_module(), "simulated", return_value=False), self.assertRaises(decide.Invariant) as caught:
            decide.check_release_readiness("ci", "0" * 64, (release / "fleet-installer.iso").as_uri())
        self.assertIn("latest Fleet installer", caught.exception.fix)
        (release / "fleet-installer.readiness.json").write_text(json.dumps({"version": 1, "roles": {}}))
        with mock.patch.object(decide.wifi_module(), "simulated", return_value=False), self.assertRaises(decide.Invariant) as caught:
            decide.check_release_readiness("devbox", "0" * 64, (release / "fleet-installer.iso").as_uri())
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
