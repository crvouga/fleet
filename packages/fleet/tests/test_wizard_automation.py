"""Automatic preparation must stay behind consent and preserve hard refusals.

All commands are mocked; helper tests use a verified ISO and regular files.
"""
import errno
import hashlib
import http.client
import io
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import diagnostics  # noqa: E402
import elevate  # noqa: E402
import helper  # noqa: E402
import imaging  # noqa: E402
import preparation  # noqa: E402
import iso_fixture  # noqa: E402


def failed(name):
    return decide.finding(name, "fail", name + " is unavailable", "manual fix")


class WindowsFirmwareQueryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "Exercise the native GetFirmwareType ABI on Windows CI")
    def test_native_windows_api_reads_the_boot_mode(self):
        self.assertIn(decide.windows_firmware_type(), (1, 2))


class PreparationTests(unittest.TestCase):
    def test_linux_review_can_offer_automatic_boot_tools_without_running_commands(self):
        with mock.patch.object(preparation, "linux_boot_commands", return_value=[["apt-get", "install", "kexec-tools"]]), \
                mock.patch.object(preparation, "execute") as execute:
            found = preparation.review_findings("Linux", [failed("boot-tool"), failed("firmware")])
        self.assertEqual([(f["name"], f["status"]) for f in found], [("boot-tool", "info"), ("firmware", "fail")])
        self.assertTrue(found[0]["automatic"])
        execute.assert_not_called()

    def test_known_package_managers_and_unknown_linux(self):
        for manager in ("apt-get", "dnf", "zypper", "pacman", None):
            with self.subTest(manager=manager), mock.patch.object(preparation.os.path, "exists", return_value=False), \
                    mock.patch.object(decide, "os_boot_tool", return_value="kexec"), \
                    mock.patch.object(preparation.shutil, "which", side_effect=lambda tool: "/usr/bin/" + tool if tool == manager else None):
                commands = preparation.linux_boot_commands()
            if manager:
                self.assertTrue(commands)
                self.assertTrue(all(c[0] == "/usr/bin/" + manager for c in commands))
                self.assertIn("kexec-tools", commands[-1])
            else:
                self.assertEqual(commands, [])

    def test_nixos_and_custom_tool_paths_never_use_foreign_package_managers(self):
        for nixos, tool in ((True, "kexec"), (False, "/custom/kexec")):
            with mock.patch.object(preparation.os.path, "exists", return_value=nixos), \
                    mock.patch.object(decide, "os_boot_tool", return_value=tool), \
                    mock.patch.object(preparation.shutil, "which") as which:
                self.assertEqual(preparation.linux_boot_commands(), [])
            which.assert_not_called()

    def test_macos_and_media_checks_never_request_system_preparation(self):
        for platform in ("Darwin", "Other"):
            self.assertEqual(preparation.automatic(platform, [failed("shrink"), failed("boot-tool")]), {})
        self.assertEqual(preparation.automatic("Windows", [failed("usb-size")]), {})

    def test_windows_consolidates_only_the_queried_system_volume_once(self):
        progress = mock.Mock()
        with mock.patch.object(decide, "windows_facts", return_value={"Letter": "D"}) as facts, \
                mock.patch.object(preparation, "execute") as execute, \
                mock.patch.dict(decide.WINDOWS, {"facts": {"stale": True}}):
            self.assertTrue(preparation.run("Windows", [failed("shrink")], progress))
            self.assertIsNone(decide.WINDOWS["facts"])
        facts.assert_called_once_with(fresh=True)
        execute.assert_called_once_with(["defrag.exe", "D:", "/X"], timeout=7200)

    def test_simulated_disks_cannot_accidentally_install_packages_or_defragment(self):
        with mock.patch.dict(os.environ, {"FLEET_DISKS_FILE": "simulated.json"}), \
                mock.patch.object(decide, "run_logged") as run:
            with self.assertRaises(decide.Invariant):
                preparation.execute(["apt-get", "install", "kexec-tools"])
        run.assert_not_called()

    def test_failed_preparation_stops_and_names_the_non_destructive_fallback(self):
        with mock.patch.dict(os.environ, {"FLEET_DISKS_FILE": ""}), \
                mock.patch.object(decide, "run_logged", return_value=subprocess.CompletedProcess([], 1, "", "unavailable")):
            with self.assertRaises(decide.Invariant) as caught:
                preparation.execute(["defrag.exe", "C:", "/X"])
        self.assertIn("USB", caught.exception.fix)

    def test_a_preparation_timeout_has_an_actionable_result_and_is_not_retried(self):
        with mock.patch.dict(os.environ, {"FLEET_DISKS_FILE": ""}), \
                mock.patch.object(decide, "run_logged", side_effect=subprocess.TimeoutExpired("defrag.exe", 7200)) as run:
            with self.assertRaises(decide.Invariant) as caught:
                preparation.execute(["defrag.exe", "C:", "/X"])
        self.assertIn("USB", caught.exception.fix)
        run.assert_called_once()


class HelperPreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.iso = self.root / "image.iso"
        tree = iso_fixture.installer_tree()
        tree['fleet-readiness.json'] = b'{"version":1,"roles":{"ci":{"blocked":[]}}}'
        self.iso.write_bytes(iso_fixture.build(tree))
        self.chosen = {"ok": True, "disk_id": "original", "path": "/dev/test"}
        self.request = {"role": "ci", "iso": str(self.iso), "sha256": imaging.sha256_of(self.iso), "disk_id": "original"}
        patches = (
            mock.patch.object(decide, "current_os", return_value="Linux"),
            mock.patch.object(decide, "state_dir", return_value=self.root / "state"),
            mock.patch.object(decide, "choose_disk", return_value=self.chosen),
            mock.patch.object(decide, "installed_for", return_value=False),
            mock.patch.object(preparation, "linux_boot_commands", return_value=[["apt-get", "install", "kexec-tools"]]),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def install(self):
        return helper.install_here(self.request, mock.Mock())

    def test_remediable_check_is_prepared_then_rechecked_before_handoff(self):
        with mock.patch.object(decide, "preflight", side_effect=[[failed("boot-tool")], []]) as preflight, \
                mock.patch.object(preparation, "execute") as execute, \
                mock.patch.object(decide, "perform_install", return_value=0) as perform:
            self.install()
        self.assertEqual(preflight.call_count, 2)
        execute.assert_called_once()
        perform.assert_called_once()

    def test_a_hard_failure_prevents_even_package_installation(self):
        with mock.patch.object(decide, "preflight", return_value=[failed("boot-tool"), failed("firmware")]), \
                mock.patch.object(preparation, "execute") as execute, \
                mock.patch.object(decide, "perform_install") as perform:
            with self.assertRaises(decide.Invariant):
                self.install()
        execute.assert_not_called()
        perform.assert_not_called()

    def test_all_privileged_blockers_retain_their_details_and_recovery_steps(self):
        found = [
            decide.finding("firmware", "fail", "Windows boot mode could not be determined", "Check BIOS Mode in msinfo32."),
            decide.finding("secure-boot", "fail", "Secure Boot is on and the installer is not signed", "Turn Secure Boot off with shutdown /r /fw."),
        ]
        with mock.patch.object(decide, "preflight", return_value=found), \
                mock.patch.object(preparation, "execute") as execute, \
                mock.patch.object(decide, "perform_install") as perform:
            with self.assertRaises(decide.Invariant) as caught:
                self.install()
        execute.assert_not_called()
        perform.assert_not_called()
        failure = caught.exception
        self.assertEqual(failure.context["failed"], repr([f"{item['name']}: {item['detail']}" for item in found]))
        advice = diagnostics.guidance(failure.what, failure.fix, changed=False)
        self.assertEqual(advice["summary"], "This computer is not ready for installation.")
        for item in found:
            self.assertIn(item["fix"], " ".join(advice["steps"]))

    def test_ineffective_preparation_never_loops_or_reboots(self):
        with mock.patch.object(decide, "preflight", return_value=[failed("boot-tool")]), \
                mock.patch.object(preparation, "execute") as execute, \
                mock.patch.object(decide, "perform_install") as perform:
            with self.assertRaises(decide.Invariant):
                self.install()
        execute.assert_called_once()
        perform.assert_not_called()

    def test_disk_change_before_preparation_prevents_every_mutation(self):
        with mock.patch.object(decide, "preflight", return_value=[failed("boot-tool")]), \
                mock.patch.object(decide, "choose_disk", side_effect=[self.chosen, {**self.chosen, "disk_id": "changed"}]), \
                mock.patch.object(preparation, "execute") as execute:
            with self.assertRaises(decide.Invariant):
                self.install()
        execute.assert_not_called()


class RetryTests(unittest.TestCase):
    def test_a_broken_transfer_is_cleaned_up_and_retried_to_a_verified_file(self):
        image = bytearray(96 * 1024)
        image[decide.ISO_MAGIC_OFFSET:decide.ISO_MAGIC_OFFSET + 5] = b"CD001"
        broken = mock.MagicMock()
        broken.__enter__.return_value = broken
        broken.headers = {"Content-Length": str(len(image))}
        broken.read.side_effect = http.client.IncompleteRead(b"partial", len(image))
        good = io.BytesIO(image)
        good.headers = {"Content-Length": str(len(image))}
        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.object(imaging.time, "sleep"), mock.patch.object(imaging.time, "monotonic", side_effect=range(100)), \
                mock.patch.object(imaging, "open_url", side_effect=[broken, good]) as opened:
            target = Path(temporary) / "verified.iso"
            imaging.download("https://release/image.iso", target, hashlib.sha256(image).hexdigest())
            self.assertEqual(target.read_bytes(), image)
            self.assertEqual(list(Path(temporary).glob("*.partial")), [])
        self.assertEqual(opened.call_count, 2)

    def test_network_recovery_and_bounded_failure(self):
        interrupted = ConnectionResetError(errno.ECONNRESET, "network interruption")
        for errors, count, success in (([interrupted, "done"], 2, True), ([interrupted] * 3, 3, False)):
            with mock.patch.object(imaging.time, "sleep"), mock.patch.object(imaging.time, "monotonic", side_effect=range(100)), \
                    mock.patch.object(imaging, "_download_once", side_effect=errors) as download:
                if success:
                    self.assertEqual(imaging.download("url", "dest", "sha"), "done")
                else:
                    with self.assertRaises(ConnectionResetError):
                        imaging.download("url", "dest", "sha")
            self.assertEqual(download.call_count, count)

    def test_local_errors_missing_assets_and_bad_checksums_are_never_retried(self):
        for error in (OSError(errno.ENOSPC, "disk full"), PermissionError("permission"),
                      urllib.error.URLError(ssl.SSLCertVerificationError("untrusted certificate")),
                      urllib.error.HTTPError("url", 404, "missing", {}, None),
                      decide.Invariant("checksum mismatch", "stop", {})):
            with self.subTest(error=type(error)), mock.patch.object(imaging, "_download_once", side_effect=error) as download:
                with self.assertRaises(type(error)):
                    imaging.download("url", "dest", "sha")
                download.assert_called_once()
                if isinstance(error, urllib.error.HTTPError):
                    error.close()

    def test_cancellation_stops_retry_before_another_network_request(self):
        cancel = mock.Mock(side_effect=[False, True])
        with mock.patch.object(imaging, "_download_once", side_effect=TimeoutError("timeout")) as download:
            with self.assertRaises(imaging.Cancelled):
                imaging.download("url", "dest", "sha", cancel=cancel)
        download.assert_called_once()


class TerminalElevationTests(unittest.TestCase):
    def test_linux_uses_its_open_terminal_when_no_desktop_prompt_exists(self):
        with mock.patch.object(elevate, "mode_for", return_value="Linux"), \
                mock.patch.object(elevate.shutil, "which", side_effect=lambda tool: "/usr/bin/sudo" if tool == "sudo" else None), \
                mock.patch.object(elevate.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)), \
                mock.patch.object(elevate.subprocess, "Popen") as popen, \
                mock.patch.object(elevate.sys, "stdin") as stdin:
            stdin.isatty.return_value = True
            elevate.start("Linux", ["/installer", "--helper", "/job"])
        popen.assert_called_once_with(["/usr/bin/sudo", "--", "/installer", "--helper", "/job"])


if __name__ == "__main__":
    unittest.main()
