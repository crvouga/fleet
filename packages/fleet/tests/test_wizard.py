#!/usr/bin/env python3
"""The installer wizard, end to end, on any operating system.

No bash and no stubs on PATH: the server, the page's API, the privileged
helper (a real subprocess), the download and the USB writer all run for real.
Disks are described by a JSON file and the "USB stick" is an ordinary file.
"""

import hashlib
import http.client
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

# Enrollment asks GitHub for approval. Tests that are not about it opt out.
os.environ.setdefault("FLEET_NO_ENROLL", "1")

WIZARD = Path(__file__).resolve().parents[1] / "wizard"
sys.path.insert(0, str(WIZARD))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import elevate  # noqa: E402
import helper  # noqa: E402
import imaging  # noqa: E402
import leases  # noqa: E402
import main as wizard_main  # noqa: E402
import server  # noqa: E402
import iso_fixture  # noqa: E402

# Windows device mutexes are global even when every write is a fixture.
# Give independent test processes distinct fake devices; retain real locking.
INTERNAL = {
    "path": f"/dev/fleet-test-internal-{os.getpid()}", "tran": "nvme", "rm": False, "hotplug": False, "usb": False, "internal": True,
    "mounted": True, "whole": True, "size": 500 * 10**9, "model": "Samsung SSD 980", "serial": "S5",
}
USB = {
    "path": f"/dev/fleet-test-usb-{os.getpid()}", "tran": "usb", "rm": True, "hotplug": True, "usb": True, "internal": False,
    "mounted": False, "whole": True, "size": 8 * 10**9, "model": "Flash", "serial": "U1",
}
USB_OTHER = dict(USB, serial="U2", path="/dev/sdc")
SSH_KEY = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32).decode()


def make_iso(size=96 * 1024, fill=7):
    blob = bytearray([fill]) * size
    blob[decide.ISO_MAGIC_OFFSET:decide.ISO_MAGIC_OFFSET + 5] = b"CD001"
    return bytes(blob)


class Waitable:
    """A finished-or-running stand-in for the elevated helper process."""

    def __init__(self, thread=None, code=0):
        self.thread = thread
        self.returncode = code

    def poll(self):
        return None if self.thread is not None and self.thread.is_alive() else self.returncode

    def wait(self, timeout=None):
        if self.thread is not None:
            self.thread.join(timeout)
        return self.returncode


class ImagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.iso = self.root / "src.iso"
        self.iso.write_bytes(make_iso())
        self.sha = hashlib.sha256(self.iso.read_bytes()).hexdigest()

    def tearDown(self):
        self.tmp.cleanup()

    def test_checksum_file_must_be_a_sha256(self):
        self.assertEqual(imaging.parse_checksum(f"{self.sha.upper()}  fleet-installer.iso\n"), self.sha)
        for bad in ("", "not-a-hash file", "abc", "g" * 64):
            with self.assertRaises(decide.Invariant, msg=bad):
                imaging.parse_checksum(bad)

    def test_download_verifies_and_only_publishes_a_whole_image(self):
        dest = self.root / "cache" / "fleet-installer.iso"
        imaging.download(self.iso.as_uri(), dest, self.sha)
        self.assertEqual(dest.read_bytes(), self.iso.read_bytes())
        self.assertFalse(dest.with_name(dest.name + ".partial").exists())

    def test_a_wrong_checksum_leaves_nothing_behind(self):
        dest = self.root / "cache" / "fleet-installer.iso"
        with self.assertRaises(decide.Invariant) as caught:
            imaging.download(self.iso.as_uri(), dest, "0" * 64)
        self.assertIn("does not match its checksum", caught.exception.what)
        self.assertIn(self.sha, caught.exception.context["got"])
        self.assertFalse(dest.exists())
        self.assertFalse(dest.with_name(dest.name + ".partial").exists())

    def test_a_checksummed_file_that_is_not_an_iso_is_refused(self):
        junk = self.root / "junk.iso"
        junk.write_bytes(b"x" * 100000)
        with self.assertRaises(decide.Invariant) as caught:
            imaging.download(junk.as_uri(), self.root / "out.iso", hashlib.sha256(junk.read_bytes()).hexdigest())
        self.assertIn("not an ISO9660", caught.exception.what)
        self.assertFalse((self.root / "out.iso").exists())

    def test_a_missing_source_names_the_url(self):
        with self.assertRaises(RuntimeError) as caught:
            imaging.download((self.root / "gone.iso").as_uri(), self.root / "out.iso", self.sha)
        self.assertIn("gone.iso", str(caught.exception))
        self.assertFalse((self.root / "out.iso").exists())

    def test_a_good_cached_image_is_not_downloaded_again(self):
        dest = self.root / "fleet-installer.iso"
        imaging.download(self.iso.as_uri(), dest, self.sha)
        moved = self.root / "moved.iso"
        self.iso.rename(moved)
        imaging.download(self.iso.as_uri(), dest, self.sha)  # the source is gone; the cache answers
        self.assertEqual(imaging.sha256_of(dest), self.sha)

    def test_cancel_stops_a_download_and_cleans_up(self):
        with self.assertRaises(imaging.Cancelled):
            imaging.download(self.iso.as_uri(), self.root / "out.iso", self.sha, cancel=lambda: True)
        self.assertEqual([p.name for p in self.root.glob("out.iso*")], [])

    def test_cancel_cannot_be_ignored_when_the_image_is_already_cached(self):
        with self.assertRaises(imaging.Cancelled):
            imaging.download("unused", self.iso, self.sha, cancel=lambda: True)

    def test_probe_reports_size_and_errors(self):
        error, size = imaging.probe(self.iso.as_uri())
        self.assertIsNone(error)
        self.assertEqual(size, self.iso.stat().st_size)
        error, size = imaging.probe((self.root / "nope").as_uri())
        self.assertTrue(error)
        self.assertIsNone(size)

    def test_write_image_writes_pads_and_proves_the_bytes(self):
        target = self.root / "usb.img"
        target.write_bytes(b"\xff" * (self.iso.stat().st_size + 10000))
        seen = []
        imaging.write_image(self.iso, target, target.stat().st_size, self.sha, lambda done, total: seen.append((done, total)))
        written = target.read_bytes()
        self.assertEqual(written[:self.iso.stat().st_size], self.iso.read_bytes())
        self.assertEqual(seen[-1][0], seen[-1][1])
        self.assertEqual(max(done for done, _ in seen), self.iso.stat().st_size)

    def test_an_image_that_is_not_a_sector_multiple_is_padded_not_truncated(self):
        odd = self.root / "odd.iso"
        odd.write_bytes(make_iso(size=96 * 1024 + 123))
        sha = hashlib.sha256(odd.read_bytes()).hexdigest()
        target = self.root / "usb.img"
        target.write_bytes(b"")
        imaging.write_image(odd, target, 10**9, sha)
        self.assertEqual(target.read_bytes()[:odd.stat().st_size], odd.read_bytes())
        self.assertEqual(target.stat().st_size % imaging.SECTOR, 0)

    def test_a_disk_too_small_is_refused_before_writing(self):
        target = self.root / "usb.img"
        target.write_bytes(b"\xff" * 10)
        with self.assertRaises(decide.Invariant) as caught:
            imaging.write_image(self.iso, target, 1000, self.sha)
        self.assertIn("smaller than the installer", caught.exception.what)
        self.assertEqual(target.read_bytes(), b"\xff" * 10)

    def test_sector_padding_must_fit_before_opening_the_disk(self):
        odd = self.root / "odd.iso"
        odd.write_bytes(make_iso(size=96 * 1024 + 1))
        with mock.patch.object(imaging.os, "open") as opened:
            with self.assertRaises(decide.Invariant):
                imaging.write_image(odd, "unused", odd.stat().st_size, self.sha)
        opened.assert_not_called()

    def test_media_that_corrupts_what_it_stores_is_caught_by_the_read_back(self):
        target = self.root / "usb.img"
        target.write_bytes(b"")
        real_write = os.write

        def flaky(fd, data):
            return real_write(fd, b"\x00" + data[1:])

        with mock.patch.object(imaging.os, "write", flaky):
            with self.assertRaises(decide.Invariant) as caught:
                imaging.write_image(self.iso, target, 10**9, self.sha)
        self.assertIn("does not hold the installer", caught.exception.what)
        self.assertIn("another USB disk", caught.exception.fix)

    def test_a_short_write_is_caught_immediately(self):
        target = self.root / "usb.img"
        target.write_bytes(b"")
        real_write = os.write
        with mock.patch.object(imaging.os, "write", lambda fd, data: real_write(fd, data[:-1]) ):
            with self.assertRaises(decide.Invariant) as caught:
                imaging.write_image(self.iso, target, 10**9, self.sha)
        self.assertIn("short write", caught.exception.what)

    def test_cache_dir_is_per_user_and_overridable(self):
        with mock.patch.dict(os.environ, {"FLEET_CACHE": str(self.root / "c")}):
            self.assertEqual(imaging.cache_dir("Linux"), self.root / "c")
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "L")}, clear=False):
            os.environ.pop("FLEET_CACHE", None)
            self.assertEqual(imaging.cache_dir("Windows"), self.root / "L" / "fleet-installer")
            self.assertIn("Caches", str(imaging.cache_dir("Darwin")))


class HelperUnitTests(unittest.TestCase):
    def test_native_nix_launcher_is_reentered_for_the_privileged_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher = root / "launcher"
            launcher.write_text("native wrapper\n")
            with mock.patch.object(elevate, "__file__", str(root / "elevate.py")):
                self.assertEqual(elevate.helper_argv(root / "job"),
                                 [str(launcher.resolve()), "--helper", str(root / "job")])

    def test_a_device_lease_excludes_another_process_and_releases_on_exit(self):
        name = "lease-test-" + str(os.getpid())
        code = "import leases,sys;\nwith leases.DeviceLease(sys.argv[1]): print('acquired')"
        env = dict(os.environ, PYTHONPATH=str(WIZARD))
        with leases.DeviceLease(name):
            blocked = subprocess.run([sys.executable, "-c", code, name], env=env, capture_output=True, text=True, check=False)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("another installer", blocked.stderr)
        released = subprocess.run([sys.executable, "-c", code, name], env=env, capture_output=True, text=True, check=False)
        self.assertEqual(released.returncode, 0, released.stderr)

    def test_canned_disks_cannot_redirect_to_a_device_or_default_to_real_writes(self):
        with mock.patch.dict(os.environ, {"FLEET_DISKS_FILE": "fixture"}):
            os.environ.pop("FLEET_WRITE_TARGET", None)
            with self.assertRaises(decide.Invariant):
                helper.raw_target("Linux", USB)
            os.environ["FLEET_WRITE_TARGET"] = os.devnull
            with self.assertRaises(decide.Invariant):
                helper.raw_target("Linux", USB)

    def test_unknown_capacity_stops_before_windows_diskpart_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            iso = Path(tmp) / "iso"
            iso.write_bytes(make_iso())
            request = {"iso": str(iso), "sha256": hashlib.sha256(iso.read_bytes()).hexdigest()}
            progress = helper.Progress(tmp)
            with mock.patch.object(helper, "find_disk", return_value=dict(USB, size=0)), mock.patch.object(helper, "run_prep") as prepare:
                with self.assertRaises(decide.Invariant):
                    helper.write_usb(request, progress)
            prepare.assert_not_called()

    def test_prep_commands_per_operating_system(self):
        windows = helper.prep_commands("Windows", {"path": r"\\.\PHYSICALDRIVE3"})
        self.assertEqual(windows, [("diskpart", "select disk 3\nclean\n")])
        with self.assertRaises(decide.Invariant):
            helper.prep_commands("Windows", {"path": "/dev/sdb"})
        self.assertEqual(helper.prep_commands("Darwin", {"path": "/dev/disk4"}), [(["diskutil", "unmountDisk", "force", "/dev/disk4"], None)])
        self.assertEqual(helper.prep_commands("Linux", {"path": "/dev/sdb"}, ["/dev/sdb1", "/dev/sdb2"]),
                         [(["umount", "/dev/sdb1"], None), (["umount", "/dev/sdb2"], None)])
        self.assertEqual(helper.prep_commands("Linux", {"path": "/dev/sdb"}), [])

    def test_macos_writes_the_raw_device(self):
        self.assertEqual(helper.raw_target("Darwin", {"path": "/dev/disk4"}), "/dev/rdisk4")
        self.assertEqual(helper.raw_target("Linux", {"path": "/dev/sdb"}), "/dev/sdb")

    def test_the_write_redirect_cannot_be_used_without_the_canned_disk_list(self):
        with mock.patch.dict(os.environ, {"FLEET_WRITE_TARGET": "x"}):
            os.environ.pop("FLEET_DISKS_FILE", None)
            with self.assertRaises(decide.Invariant):
                helper.raw_target("Linux", {"path": "/dev/sdb"})

    def test_progress_rows_are_read_whole_lines_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "p.jsonl"
            path.write_bytes(b'{"step":"a","message":"one"}\n{"step":"b","mess')
            rows, offset = elevate.read_progress(path, 0)
            self.assertEqual([r["message"] for r in rows], ["one"])
            path.write_bytes(path.read_bytes() + b'age":"two"}\n')
            rows, offset = elevate.read_progress(path, offset)
            self.assertEqual([r["message"] for r in rows], ["two"])

    def test_the_macos_prompt_command_is_quoted(self):
        script = elevate.applescript_command(["/Applications/Fleet Installer", "--helper", '/tmp/a"b'])
        self.assertTrue(script.endswith("with administrator privileges"))
        self.assertIn("Fleet Installer", script)
        self.assertNotIn('a"b', script.replace('\\"', ""))

    def test_elevation_modes(self):
        with mock.patch.dict(os.environ, {"FLEET_ELEVATE": "none"}):
            self.assertEqual(elevate.mode_for("Windows"), "none")
        with mock.patch.dict(os.environ, {"FLEET_ELEVATE": "sometimes"}):
            with self.assertRaises(decide.Invariant):
                elevate.mode_for("Linux")


class InvariantTests(unittest.TestCase):
    def test_an_invariant_carries_what_where_and_the_fix(self):
        with self.assertRaises(decide.Invariant) as caught:
            decide.invariant(False, "the thing broke", "Do this.", file="/x", token="hvs.SECRETVALUE123")
        self.assertEqual(caught.exception.what, "the thing broke")
        self.assertEqual(caught.exception.fix, "Do this.")
        self.assertEqual(caught.exception.context["file"], "'/x'")
        self.assertNotIn("SECRETVALUE123", json.dumps(caught.exception.context))

    def test_a_true_invariant_is_silent(self):
        decide.invariant(True, "never raised")

    def test_iso_detection_boundaries(self):
        good = make_iso()
        self.assertTrue(decide.looks_like_iso(good))
        self.assertTrue(decide.looks_like_iso(good[:decide.ISO_MAGIC_OFFSET + 5]))
        self.assertFalse(decide.looks_like_iso(good[:decide.ISO_MAGIC_OFFSET + 4]))
        self.assertFalse(decide.looks_like_iso(b""))
        self.assertFalse(decide.looks_like_iso(b"x" * 100000))

    def test_state_markers_are_validated_not_trusted(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.assertEqual(decide.checked_marker(directory, "installed"), {})
            (directory / "installed").write_text("role=ci\nstatus=installed\n")
            self.assertTrue(decide.installed_for("ci", directory))
            self.assertFalse(decide.installed_for("devbox", directory))
            for corrupt in ("", "garbage", "role=ci\n", "status=installed\n", "role=toaster\nstatus=installed\n", "role=ci\nstatus=maybe\n"):
                (directory / "installed").write_text(corrupt)
                with self.assertRaises(decide.Invariant, msg=repr(corrupt)) as caught:
                    decide.installed_for("ci", directory)
                self.assertIn("delete that file", caught.exception.fix)

    def test_unknown_roles_cannot_reach_the_boot_command(self):
        with self.assertRaises(decide.Invariant):
            decide._boot_command("init=/x", "toaster", "/tmp/a.iso")
        command = decide._boot_command("init=/x fleet.role=ci", "devbox", "/tmp/a.iso", "hvs.TOKENVALUE1", "https://v.example")
        self.assertTrue(command.endswith("fleet.role=devbox"))
        self.assertEqual(command.rsplit("fleet.role=", 1)[1], "devbox")  # the installer reads the last one

    def test_the_boot_command_names_the_wizard_attempt_only_when_well_formed(self):
        with mock.patch.dict(decide.HANDOFF, {"attempt": "0123456789abcdef", "wizard": "1a2b3c4"}):
            command = decide._boot_command("fleet.attempt=old fleet.role=ci", "ci", "/tmp/a.iso", origin="windows")
        self.assertIn("fleet.attempt=0123456789abcdef fleet.wizard=1a2b3c4", command)
        self.assertNotIn("fleet.attempt=old", command)
        with mock.patch.dict(decide.HANDOFF, {"attempt": "bad value; rm", "wizard": "x y"}):
            command = decide._boot_command("fleet.role=ci", "ci", "/tmp/a.iso", origin="windows")
        self.assertNotIn("fleet.attempt=", command)
        self.assertNotIn("fleet.wizard=", command)

    def test_the_boot_command_says_whether_wifi_settings_rode_along(self):
        # The live installer's screen and report tell "none sent" from "sent but lost".
        for carried, word in ((True, "fleet.wifi=sent"), (False, "fleet.wifi=none")):
            command = decide._boot_command("init=/x fleet.wifi=stale fleet.role=ci", "ci", "/tmp/a.iso", origin="windows", wifi=carried)
            self.assertEqual(command.split().count(word), 1)
            self.assertNotIn("fleet.wifi=stale", command)
            self.assertTrue(command.endswith("fleet.role=ci"))
        self.assertNotIn("fleet.wifi=", decide._boot_command("init=/x fleet.role=ci", "ci", "/tmp/a.iso"))

    def test_a_mounted_internal_disk_is_the_running_system_and_is_eligible(self):
        chosen = decide.plan_disks([INTERNAL, USB], "install")
        self.assertTrue(chosen["ok"], chosen)
        self.assertEqual(chosen["path"], INTERNAL["path"])
        self.assertIsNone(decide.install_block(INTERNAL))
        for refused in (USB, dict(INTERNAL, rm=True), dict(INTERNAL, hotplug=True)):
            self.assertIsNotNone(decide.install_block(refused))
        self.assertFalse(decide.plan_disks([INTERNAL, dict(INTERNAL, path="/dev/nvme1n1", serial="S6")], "install")["ok"])

    def test_media_never_picks_an_internal_disk(self):
        self.assertIsNotNone(decide.media_block(INTERNAL))
        self.assertIsNone(decide.media_block(USB))
        self.assertEqual(decide.media_block(dict(USB, mounted=True)), "mounted")


class WizardCase(unittest.TestCase):
    """A running wizard over real HTTP, with a file standing in for the USB stick."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.iso = self.root / "release" / "fleet-installer.iso"
        self.iso.parent.mkdir()
        self.iso.write_bytes(make_iso())
        self.sha = hashlib.sha256(self.iso.read_bytes()).hexdigest()
        self.sumfile = self.root / "release" / "fleet-installer.iso.sha256"
        self.sumfile.write_text(f"{self.sha}  fleet-installer.iso\n")
        self.disks = self.root / "disks.json"
        self.disks.write_text(json.dumps([INTERNAL, USB]))
        self.target = self.root / "usb.img"
        self.target.write_bytes(b"\xee" * 300000)
        patch = mock.patch.dict(os.environ, {
            "FLEET_STATE": str(self.root / "state"),
            "FLEET_CACHE": str(self.root / "cache"),
            "FLEET_ELEVATE": "none",
            "FLEET_INSTALLER_URL": self.iso.as_uri(),
            "FLEET_INSTALLER_SHA256_URL": self.sumfile.as_uri(),
            "FLEET_DISKS_FILE": str(self.disks),
            "FLEET_WRITE_TARGET": str(self.target),
            "FLEET_ARCH": "x86_64",
            "FLEET_NODE_CONF": str(self.root / "no-node.conf"),
            "FLEET_EFI_DIR": str(self.root),
        })
        patch.start()
        self.addCleanup(patch.stop)
        decide.LOG["path"] = None
        decide.LOG.pop("sink", None)
        decide.start_log(["test"])
        self.start_server()

    def start_server(self, os_name=None):
        self.wizard = server.Wizard(os_name)
        self.httpd = server.serve(self.wizard)
        self.port = self.httpd.server_address[1]
        self.server_thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.server_thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, method, path, body=None, **kwargs):
        status, data = wizard_main.call(self.port, self.wizard.secret, method, path, body, **kwargs)
        try:
            return status, json.loads(data)
        except ValueError:
            return status, data

    def wait_job(self, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            _status, job = self.call("GET", "/api/job")
            if job["state"] in ("done", "failed", "cancelled"):
                return job
            time.sleep(0.1)
        self.fail("the job never finished")

    def usb_plan(self, disk_id=None):
        _status, scan = self.call("GET", "/api/scan")
        return self.call("POST", "/api/plan", {"mode": "usb", "disk_id": disk_id or scan["usb"][0]["id"]})

    def run_plan(self, plan, **overrides):
        body = {"plan_id": plan["id"], "ack": True, "disk_id": plan["disk_id"]}
        body.update(overrides)
        return self.call("POST", "/api/run", body)


class ServerTests(WizardCase):
    def test_wifi_plan_keeps_password_private_and_usb_handoff_reads_back(self):
        import fleet_wifi
        network = {"ssid": "Fixture Wi-Fi", "password": "fixture-wifi-password", "auth": "wpa-psk", "hidden": True}
        self.disks.write_text(json.dumps([INTERNAL, {**USB, "size": self.target.stat().st_size}]))
        _status, scan = self.call("GET", "/api/scan")
        status, plan = self.call("POST", "/api/plan", {"mode": "usb", "disk_id": scan["usb"][0]["id"], "wifi": network})
        self.assertEqual(status, 200)
        self.assertNotIn("wifi", plan)
        self.assertNotIn(network["password"], json.dumps(plan))
        self.assertIn("Keep this USB private", plan["summary"])
        self.run_plan(plan)
        job = self.wait_job()
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(fleet_wifi.read_trailer(self.target), network)
        self.assertNotIn(network["password"], json.dumps(job))
        self.assertNotIn(network["password"], Path(decide.LOG["path"]).read_text())

    def test_duplicate_disk_identifiers_cannot_pick_a_target_silently(self):
        self.disks.write_text(json.dumps([USB, dict(USB, path="/dev/sdc")]))
        status, body = self.usb_plan()
        self.assertEqual(status, 409)
        self.assertIn("uniquely", body["error"])
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_expired_reviews_cannot_start_a_write(self):
        _status, plan = self.usb_plan()
        self.wizard.plan["created"] -= server.PLAN_TTL + 1
        status, body = self.run_plan(plan)
        self.assertEqual(status, 409)
        self.assertIn("expired", body["error"])
        self.assertEqual(self.wizard.job.snapshot()["state"], "idle")

    def test_simultaneous_confirmations_launch_exactly_one_worker(self):
        from concurrent.futures import ThreadPoolExecutor
        _status, plan = self.usb_plan()
        barrier = threading.Barrier(8)
        def confirm(_index):
            barrier.wait(5)
            return self.run_plan(plan)[0]
        with mock.patch.object(self.wizard, "run_job") as worker:
            with ThreadPoolExecutor(max_workers=8) as pool:
                codes = list(pool.map(confirm, range(8)))
            self.assertEqual(codes.count(200), 1, codes)
            self.assertEqual(codes.count(409), 7, codes)
            worker.assert_called_once()
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_browser_secret_never_enters_the_http_log(self):
        self.call("GET", "/?t=" + self.wizard.secret)
        self.assertNotIn(self.wizard.secret, Path(decide.LOG["path"]).read_text())
    def test_scan_describes_this_computer_and_the_choices(self):
        status, scan = self.call("GET", "/api/scan")
        self.assertEqual(status, 200)
        self.assertEqual([r["id"] for r in scan["roles"]], list(decide.ROLES))
        self.assertEqual([u["plain"] for u in scan["usb"]], [decide.plain_name(USB)])
        self.assertTrue(scan["internal"]["ok"])
        self.assertTrue(scan["release"]["ok"])
        self.assertEqual(scan["release"]["size"], self.iso.stat().st_size)
        self.assertNotIn("Darwin", scan["os"])

    def test_every_role_has_a_title_and_a_description(self):
        self.assertEqual(sorted(server.ROLE_INFO), sorted(decide.ROLES))

    def test_requests_without_the_secret_or_from_elsewhere_are_refused(self):
        self.assertEqual(self.call("GET", "/api/scan", token=False)[0], 403)
        self.assertEqual(self.call("GET", "/api/scan", host="evil.example")[0], 403)
        self.assertEqual(self.call("GET", "/api/scan", host=f"127.0.0.1:{self.port + 1}")[0], 403)
        status, _ = wizard_main.call(self.port, "wrong-secret", "GET", "/api/scan")
        self.assertEqual(status, 403)
        # a web page in the browser carries its own Origin
        import http.client
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request("GET", "/api/scan", headers={"X-Fleet-Token": self.wizard.secret, "Origin": "https://evil.example"})
        self.assertEqual(connection.getresponse().status, 403)

    def test_the_page_accepts_the_secret_in_its_address(self):
        import http.client
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request("GET", f"/?t={self.wizard.secret}")
        reply = connection.getresponse()
        self.assertEqual(reply.status, 200)
        self.assertIn(b"Fleet installer", reply.read())
        self.assertIn("no-store", reply.getheader("Cache-Control"))

    def test_reload_can_load_the_static_page_but_cannot_read_machine_facts_without_a_token(self):
        status, page = wizard_main.call(self.port, self.wizard.secret, "GET", "/", token=False)
        self.assertEqual(status, 200)
        self.assertNotIn(self.wizard.secret.encode(), page)
        self.assertEqual(self.call("GET", "/api/scan", token=False)[0], 403)

    def test_malformed_requests_get_a_clear_answer_not_a_crash(self):
        import http.client
        for body, kind, want in ((b"{not json", "application/json", 400), (b"[]", "application/json", 409), (b"{}", "text/plain", 409)):
            connection = http.client.HTTPConnection("127.0.0.1", self.port)
            connection.request("POST", "/api/plan", body, {"X-Fleet-Token": self.wizard.secret, "Content-Type": kind, "Content-Length": str(len(body))})
            self.assertEqual(connection.getresponse().status, want, body)
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request("POST", "/api/plan", b"{}", {"X-Fleet-Token": self.wizard.secret, "Content-Type": "application/json", "Content-Length": str(server.MAX_BODY + 1)})
        self.assertEqual(connection.getresponse().status, 409)
        self.assertEqual(self.call("GET", "/nope")[0], 404)

    def test_listening_on_loopback_only(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")

    def test_startup_and_requests_do_not_need_dns(self):
        with mock.patch("socket.getfqdn", side_effect=RuntimeError("DNS is unavailable")):
            self.start_server()
            self.assertEqual(self.httpd.server_name, "127.0.0.1")
            self.assertEqual(self.httpd.server_port, self.port)
            status, page = self.call("GET", "/", token=False)
        self.assertEqual(status, 200)
        self.assertIn(b"Fleet installer", page)

    def test_plan_for_a_usb_disk_that_is_not_there_is_refused_with_a_fix(self):
        status, body = self.call("POST", "/api/plan", {"mode": "usb", "disk_id": "deadbeefdeadbeef"})
        self.assertEqual(status, 409)
        self.assertIn("not present", body["error"])
        self.assertIn("Rescan", body["fix"])

    def test_an_internal_disk_cannot_be_planned_as_a_usb_target(self):
        status, body = self.call("POST", "/api/plan", {"mode": "usb", "disk_id": decide.disk_id(INTERNAL)})
        self.assertEqual(status, 409)

    def test_unknown_modes_and_roles_are_refused(self):
        self.assertEqual(self.call("POST", "/api/plan", {"mode": "format-c"})[0], 409)
        self.assertEqual(self.call("POST", "/api/plan", {"mode": "here", "role": "toaster"})[0], 409)
        self.assertEqual(self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "token": "has space and junk"})[0], 409)

    def test_this_computer_cannot_install_itself_on_macos_or_arm(self):
        for os_name in ("Darwin",):
            self.httpd.shutdown()
            self.start_server(os_name)
            status, body = self.call("POST", "/api/plan", {"mode": "here", "role": "ci"})
            self.assertEqual(status, 409, os_name)
            self.assertIn("cannot restart straight into the installer", body["fix"])
        with mock.patch.dict(os.environ, {"FLEET_ARCH": "arm64"}):
            self.httpd.shutdown()
            self.start_server("Linux")
            _status, scan = self.call("GET", "/api/scan")
            self.assertTrue(any("arm64" in reason for reason in scan["here_blockers"]))

    def test_the_plan_never_echoes_the_token_or_the_device_path(self):
        status, plan = self.usb_plan()
        self.assertEqual(status, 200)
        self.assertNotIn("token", plan)
        self.assertNotIn("path", plan)
        self.assertTrue(plan["ready"], plan["findings"])
        self.assertIn(decide.plain_name(USB), plan["summary"])

    def test_a_plan_with_a_failed_check_cannot_be_run(self):
        with mock.patch.dict(os.environ, {"FLEET_INSTALLER_URL": (self.root / "missing.iso").as_uri()}):
            _status, plan = self.usb_plan()
            self.assertFalse(plan["ready"])
            self.assertTrue(any(f["name"] == "network" and f["status"] == "fail" for f in plan["findings"]))
            status, body = self.run_plan(plan)
        self.assertEqual(status, 409)
        self.assertIn("failed checks", body["error"])
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_running_needs_the_current_plan_the_tick_and_the_same_disk(self):
        _status, plan = self.usb_plan()
        for overrides in ({"plan_id": "stale"}, {"ack": False}, {"ack": "yes"}, {"disk_id": decide.disk_id(INTERNAL)}):
            status, body = self.run_plan(plan, **overrides)
            self.assertEqual(status, 409, overrides)
        self.assertEqual(self.call("POST", "/api/run", {})[0], 409)
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)
        self.assertEqual(self.call("GET", "/api/job")[1]["state"], "idle")

    def test_making_a_usb_runs_the_real_helper_and_proves_the_bytes(self):
        _status, plan = self.usb_plan()
        self.assertEqual(self.run_plan(plan)[0], 200)
        job = self.wait_job()
        self.assertEqual(job["state"], "done", job)
        first_scratch = self.wizard.job.scratch
        self.assertTrue(job["result"]["ok"])
        self.assertEqual(self.target.read_bytes()[:self.iso.stat().st_size], self.iso.read_bytes())
        self.assertTrue(any("Writing" in line for line in job["log"]), job["log"])
        self.assertEqual(self.run_plan(plan)[0], 409, "a completed acknowledgement cannot be replayed")
        _status, fresh = self.usb_plan()
        self.assertEqual(self.run_plan(fresh)[0], 200)
        job = self.wait_job()
        self.assertEqual(job["state"], "done", job)
        scratches = [first_scratch, self.wizard.job.scratch]
        # The worker publishes its result before its finally block removes the
        # request directory. Observe only these jobs and wait for that cleanup.
        deadline = time.monotonic() + 5
        while any(path.exists() for path in scratches) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual([path for path in scratches if path.exists()], [])

    def test_a_corrupt_release_stops_before_any_disk_is_touched(self):
        self.sumfile.write_text("0" * 64 + "  fleet-installer.iso\n")
        _status, plan = self.usb_plan()
        self.assertEqual(self.run_plan(plan)[0], 200)
        job = self.wait_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("does not match its checksum", job["result"]["message"])
        self.assertTrue(job["result"]["fix"])
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_a_disk_that_changed_after_the_plan_is_refused_by_the_helper(self):
        _status, plan = self.usb_plan()
        self.disks.write_text(json.dumps([INTERNAL, USB_OTHER]))  # a different stick, same slot
        self.assertEqual(self.run_plan(plan)[0], 200)
        job = self.wait_job()
        self.assertEqual(job["state"], "failed", job)
        self.assertRegex(job["result"]["message"], "not present exactly once|not the one that was chosen")
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_the_helper_refuses_an_internal_disk_even_if_asked_directly(self):
        scratch = Path(tempfile.mkdtemp())
        (scratch / "request.json").write_text(json.dumps({
            "action": "write-usb", "iso": str(self.iso), "sha256": self.sha,
            "disk_id": decide.disk_id(INTERNAL), "path": INTERNAL["path"],
        }))
        self.assertEqual(helper.run(scratch), 1)
        result = json.loads((scratch / "result.json").read_text())
        self.assertFalse(result["ok"])
        self.assertIn("refusing to write the installer to this disk", result["message"])
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)
        self.assertEqual((scratch / "request.claimed.json").read_text(), "{}", "the token does not outlive the run")
        self.assertFalse((scratch / "request.json").exists())
        shutil.rmtree(scratch)

    def test_the_helper_rechecks_the_image_it_is_given(self):
        scratch = Path(tempfile.mkdtemp())
        tampered = self.root / "tampered.iso"
        tampered.write_bytes(make_iso(fill=9))
        (scratch / "request.json").write_text(json.dumps({
            "action": "write-usb", "iso": str(tampered), "sha256": self.sha,
            "disk_id": decide.disk_id(USB), "path": USB["path"],
        }))
        self.assertEqual(helper.run(scratch), 1)
        result = json.loads((scratch / "result.json").read_text())
        self.assertIn("changed after it was downloaded", result["message"])
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)
        shutil.rmtree(scratch)

    def test_a_declined_permission_prompt_is_explained(self):
        with mock.patch.object(elevate, "start", lambda os_name, argv: Waitable(None, 1)):
            _status, plan = self.usb_plan()
            self.run_plan(plan)
            job = self.wait_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("permission prompt was probably declined", job["result"]["message"])
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_no_way_to_elevate_says_what_to_run_instead(self):
        def nope(os_name, argv):
            raise elevate.ElevationUnavailable("Close this window and run: sudo fleet-installer")
        with mock.patch.object(elevate, "start", nope):
            _status, plan = self.usb_plan()
            self.run_plan(plan)
            job = self.wait_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("sudo fleet-installer", job["result"]["message"])

    def test_cancelling_the_download_erases_nothing(self):
        gate = threading.Event()
        real = imaging.download

        def slow(url, dest, sha, progress=None, cancel=None, **kwargs):
            gate.wait(5)
            return real(url, dest, sha, progress, cancel, **kwargs)

        with mock.patch.object(imaging, "download", slow):
            _status, plan = self.usb_plan()
            self.run_plan(plan)
            self.call("POST", "/api/cancel", {})
            gate.set()
            job = self.wait_job()
        self.assertEqual(job["state"], "cancelled")
        self.assertEqual(self.target.read_bytes(), b"\xee" * 300000)

    def test_only_one_job_at_a_time(self):
        gate = threading.Event()
        real = imaging.download

        def slow(url, dest, sha, progress=None, cancel=None, **kwargs):
            gate.wait(5)
            return real(url, dest, sha, progress, cancel, **kwargs)

        with mock.patch.object(imaging, "download", slow):
            _status, plan = self.usb_plan()
            self.assertEqual(self.run_plan(plan)[0], 200)
            status, body = self.run_plan(plan)
            self.assertEqual(status, 409)
            self.assertIn("already running", body["error"])
            gate.set()
            self.wait_job()

    def test_the_job_state_machine_only_moves_forward(self):
        job = server.Job()
        with self.assertRaises(decide.Invariant):
            job.move("done")
        job.move("downloading")
        job.move("working")
        with self.assertRaises(decide.Invariant):
            job.move("done")
        with self.assertRaises(decide.Invariant):
            job.move("downloading")
        job.move("done", {"ok": True, "message": "verified"})
        self.assertEqual(job.snapshot()["result"]["message"], "verified")

    def test_cancellation_wins_atomically_before_the_privileged_step(self):
        job = server.Job()
        job.move("downloading")
        job.request_cancel()
        with self.assertRaises(imaging.Cancelled):
            job.move("working")
        self.assertEqual(job.snapshot()["state"], "downloading")
        job.move("cancelled", {"ok": False})
        other = server.Job()
        other.move("downloading")
        other.move("working")
        with self.assertRaises(decide.Invariant):
            other.request_cancel()
        self.assertFalse(other.cancel.is_set())


class DevboxKeyTests(unittest.TestCase):
    def test_key_validation_rejects_private_keys_options_and_injection(self):
        self.assertEqual(decide.validate_ssh_key(SSH_KEY + " owner@example"), SSH_KEY)
        for bad in ("", "-----BEGIN OPENSSH PRIVATE KEY-----", 'command="sh" ' + SSH_KEY, SSH_KEY + "\n" + SSH_KEY, "ssh-rsa " + SSH_KEY.split()[1], "ssh-ed25519 !!!!"):
            with self.subTest(bad=bad), self.assertRaises(decide.Invariant):
                decide.validate_ssh_key(bad)

    def test_devbox_boot_command_carries_only_the_validated_public_key(self):
        command = decide._boot_command("fleet.role=ci", "devbox", "/tmp/installer.iso", ssh_key=SSH_KEY)
        encoded = next(t.split("=", 1)[1] for t in command.split() if t.startswith("fleet.ssh="))
        self.assertEqual(base64.urlsafe_b64decode(encoded).decode(), SSH_KEY)
        self.assertTrue(command.endswith("fleet.role=devbox"))


@unittest.skipIf(os.name == "nt", "CI node conversion runs on Linux with flock")
class RunnerConversionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "node.conf").write_text("role=ci\n")
        (self.root / "runner.conf").write_text("scope=organization\napp_id=123\ninstallation_id=456\ntarget=example\n")
        (self.root / "credential").write_text("test-only-credential")
        (self.root / "state").mkdir()
        env = mock.patch.dict(os.environ, FLEET_NODE_CONF=str(self.root / "node.conf"), FLEET_RUNNER_CONF=str(self.root / "runner.conf"),
                              FLEET_CREDENTIAL=str(self.root / "credential"), FLEET_BUSY_DIR=str(self.root / "jobs"), FLEET_HOSTNAME="ci-test")
        env.start()
        self.addCleanup(env.stop)

    def test_busy_runner_cannot_be_withdrawn_or_rebooted_for_conversion(self):
        (self.root / "jobs" / "slot-1").mkdir(parents=True)
        (self.root / "jobs" / "slot-1" / "busy").touch()
        with mock.patch.object(decide, "call_runner") as withdraw:
            with self.assertRaises(decide.Invariant):
                decide.retire_runner_for_install(self.root / "state")
        withdraw.assert_not_called()
        self.assertFalse((self.root / "state" / "withdrawn").exists())

    def test_idle_runner_withdraws_once_and_blocks_new_job_admission(self):
        with mock.patch.object(decide, "call_runner", return_value=0) as withdraw:
            decide.retire_runner_for_install(self.root / "state")
            decide.retire_runner_for_install(self.root / "state")
        withdraw.assert_called_once()
        self.assertEqual(withdraw.call_args.args[0], "withdraw")
        self.assertTrue((self.root / "jobs" / "draining").exists())
        self.assertEqual(decide.checked_marker(self.root / "state", "withdrawn")["role"], "ci")

    def test_failed_withdrawal_never_claims_that_the_runner_is_retired(self):
        with mock.patch.object(decide, "call_runner", return_value=99):
            with self.assertRaises(decide.Invariant):
                decide.retire_runner_for_install(self.root / "state")
        self.assertFalse((self.root / "state" / "withdrawn").exists())
        self.assertFalse((self.root / "jobs" / "draining").exists())

    def test_withdrawn_node_can_be_reinstalled_into_its_previous_role(self):
        state = self.root / "state"
        (state / "installed").write_text("status=installed\nrole=ci\ndisk=test\n")
        self.assertTrue(decide.installed_for("ci", state))
        (state / "withdrawn").write_text("status=withdrawn\nrole=ci\n")
        self.assertFalse(decide.installed_for("ci", state))

class WindowsHereTests(unittest.TestCase):
    """Windows converts itself in place; macOS cannot restart into the installer."""

    def test_only_macos_is_told_to_make_a_usb(self):
        import server
        internal = {"ok": True}
        with mock.patch.object(decide, "machine_arch", return_value="x86_64"):
            self.assertEqual(server.Wizard("Windows").here_blockers([], internal), [])
            reasons = server.Wizard("Darwin").here_blockers([], internal)
        self.assertTrue(reasons and "install USB" in reasons[0], reasons)

    def test_the_helper_hands_windows_the_verified_image_without_copying_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            iso = root / "fleet-installer.iso"
            tree = iso_fixture.installer_tree()
            tree['fleet-readiness.json'] = b'{"version":1,"roles":{"ci":{"blocked":[]}}}'
            iso.write_bytes(iso_fixture.build(tree))
            sha = imaging.sha256_of(iso)
            disk = {"path": "\\\\.\\PHYSICALDRIVE0", "tran": "nvme", "rm": False, "hotplug": False, "usb": False, "internal": True,
                    "mounted": True, "whole": True, "size": 10**12, "model": "SSD", "serial": "S1"}
            calls = []

            def perform(os_name, role, image, token, vault, directory, chosen, on_progress=None):
                calls.append((os_name, role, image, dict(decide.HANDOFF)))
                on_progress(1, 2)
                return 0

            env = {"FLEET_STATE": str(root / "state"), "FLEET_NO_ENROLL": "1"}
            with mock.patch.dict(os.environ, env), \
                    mock.patch.object(decide, "current_os", return_value="Windows"), \
                    mock.patch.object(decide, "collect", return_value=[disk]), \
                    mock.patch.object(decide, "preflight", return_value=[]), \
                    mock.patch.object(decide, "perform_install", perform), \
                    mock.patch.dict(decide.NET, {"probe": lambda: (None, 1), "lookup": lambda t, r: decide.finding("enrollment", "ok", "x")}):
                request = {"role": "ci", "iso": str(iso), "sha256": sha, "disk_id": decide.disk_id(disk), "attempt": "0123456789abcdef"}
                progress = helper.Progress(root)
                (root / "state").mkdir()
                result = helper.install_here(request, progress)
                self.assertEqual(calls[0][3]["attempt"], "0123456789abcdef", "the boot names the wizard attempt")
                self.assertEqual(decide.HANDOFF, {}, "nothing leaks into a later boot command")
                # A refusal from the Windows staging keeps its own reason, not a generic one.
                def refuse(*args, **kwargs):
                    decide.say("Next: turn Secure Boot off with shutdown /r /fw. Nothing was written.")
                    return 2
                with mock.patch.object(decide, "perform_install", refuse), self.assertRaises(decide.Invariant) as caught:
                    helper.install_here(request, progress)
                self.assertEqual(caught.exception.fix, "turn Secure Boot off with shutdown /r /fw. Nothing was written.")
            self.assertEqual([call[:3] for call in calls], [("Windows", "ci", str(iso))], "Windows writes the image where it was verified; no second copy")
            self.assertFalse((root / "state" / "fleet-installer.iso").exists())
            self.assertEqual(result["restart"], True)
            self.assertIn("ci", result["message"])
            rows = [json.loads(line) for line in (root / "progress.jsonl").read_text().splitlines()]
            self.assertTrue(any(r["step"] == "write" and r["percent"] == 50 for r in rows), rows)
            steps = [r["step"] for r in rows]
            # The page says "restarting" only once the restart is actually scheduled.
            self.assertLess(steps.index("prepare"), steps.index("write"))
            self.assertGreater(steps.index("reboot"), steps.index("write"))

    def test_an_installed_computer_is_not_told_a_restart_is_coming(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            iso = root / "fleet-installer.iso"
            tree = iso_fixture.installer_tree()
            tree['fleet-readiness.json'] = b'{"version":1,"roles":{"ci":{"blocked":[]}}}'
            iso.write_bytes(iso_fixture.build(tree))
            disk = {"path": "/dev/nvme0n1", "tran": "nvme", "rm": False, "hotplug": False, "usb": False, "internal": True,
                    "mounted": True, "whole": True, "size": 10**12, "model": "SSD", "serial": "S1"}
            with mock.patch.dict(os.environ, {"FLEET_STATE": str(root / "state"), "FLEET_NO_ENROLL": "1"}), \
                    mock.patch.object(decide, "current_os", return_value="Linux"), \
                    mock.patch.object(decide, "collect", return_value=[disk]), \
                    mock.patch.object(decide, "preflight", return_value=[]), \
                    mock.patch.object(decide, "installed_for", return_value=True), \
                    mock.patch.object(decide, "perform_install") as perform:
                result = helper.install_here({"role": "ci", "iso": str(iso), "sha256": imaging.sha256_of(iso),
                                              "disk_id": decide.disk_id(disk)}, helper.Progress(root))
            perform.assert_not_called()
            self.assertEqual(result["restart"], False)
            self.assertIn("already installed as ci", result["message"])


class QuitServerTests(WizardCase):
    def test_quit_stops_the_server(self):
        self.assertEqual(self.call("POST", "/api/quit", {})[0], 200)
        self.server_thread.join(timeout=2)
        self.assertFalse(self.server_thread.is_alive(), "quit did not stop the HTTP server")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=0.25)
        try:
            with self.assertRaises(OSError):
                connection.request("GET", "/api/scan", headers={"X-Fleet-Token": self.wizard.secret})
                connection.getresponse()
        finally:
            connection.close()


class InstallHereTests(WizardCase):
    """Converting a running Linux machine. The reboot itself is replaced."""

    def setUp(self):
        super().setUp()
        extra = mock.patch.dict(os.environ, {
            "FLEET_OS": "Linux", "FLEET_EUID": "0", "FLEET_KEXEC": sys.executable, "FLEET_ISO_FS": "ext4",
            "FLEET_ALLOW_ANY_OS_INSTALL": "1", "FLEET_VAULT_ADDR": "https://vault.example",
        })
        extra.start()
        self.addCleanup(extra.stop)
        self.httpd.shutdown()
        self.start_server("Linux")
        self.calls = []

        def in_process(os_name, argv):
            scratch = Path(argv[-1])
            thread = threading.Thread(target=helper.run, args=(scratch,))
            thread.start()
            return Waitable(thread, 0)

        patch = mock.patch.object(elevate, "start", in_process)
        patch.start()
        self.addCleanup(patch.stop)

        def record(os_name, role, iso, token, vault, directory, chosen, on_progress=None):
            self.calls.append({"role": role, "token": token, "vault": vault, "iso": iso, "disk": chosen["path"], "sha": imaging.sha256_of(iso)})
            return 0

        patch = mock.patch.object(decide, "perform_install", record)
        patch.start()
        self.addCleanup(patch.stop)
        decide.NET["lookup"] = lambda token, role: decide.finding("enrollment", "ok", "token is valid")

    def test_converting_this_machine_hands_the_verified_image_to_the_installer(self):
        _status, scan = self.call("GET", "/api/scan")
        self.assertEqual(scan["here_blockers"], [])
        status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "token": "hvs.CAESIwrapped", "disk_id": scan["internal"]["id"]})
        self.assertEqual(status, 200, plan)
        self.assertTrue(plan["ready"], plan["findings"])
        self.assertIn("including this computer's operating system", plan["summary"])
        self.assertNotIn("hvs.CAESIwrapped", json.dumps(plan))
        self.assertEqual(self.run_plan(plan)[0], 200)
        job = self.wait_job()
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(len(self.calls), 1)
        call = self.calls[0]
        self.assertEqual((call["role"], call["token"], call["vault"], call["disk"]), ("ci", "hvs.CAESIwrapped", "https://vault.example", INTERNAL["path"]))
        self.assertEqual(call["sha"], self.sha)
        log = Path(decide.LOG["path"]).read_text()
        self.assertNotIn("hvs.CAESIwrapped", log)

    def _enrolling_wizard(self, wait="20"):
        from enroll_fakes import FakeGitHub
        github = FakeGitHub()
        self.addCleanup(github.close)
        patch = mock.patch.dict(os.environ, {"FLEET_GITHUB_API": github.url, "FLEET_NO_BROWSER": "1", "FLEET_ENROLL_POLL": "1", "FLEET_ENROLL_WAIT": wait})
        patch.start()
        self.addCleanup(patch.stop)
        os.environ.pop("FLEET_NO_ENROLL", None)
        self.addCleanup(os.environ.__setitem__, "FLEET_NO_ENROLL", "1")
        return github

    def _approve_when_asked(self, github, answer=None):
        """The owner's click, once the wizard has shown the link in its job log."""
        from urllib.parse import parse_qs, urlparse
        for _ in range(100):
            job = self.call("GET", "/api/job")[1]
            link = next((line[line.index("https://"):] for line in job["log"] if "issues/new?" in line), None)
            if link:
                # The page shows it as a link with a deadline, not only as a log line.
                self.assertEqual(job["approval"]["url"], link.strip())
                self.assertGreater(job["approval"]["deadline"], time.time())
                self.assertIsNone(job["percent"], "a new step does not inherit the download's 100%")
                break
            time.sleep(0.2)
        self.assertTrue(link, "the wizard never showed the approval link")
        query = parse_qs(urlparse(link.strip()).query)
        _, public = decide.parse_enroll_request(query["title"][0], query["body"][0])
        number = github.open_issue(query["title"][0], query["body"][0])
        github.comment(number, answer or "fleet-sealed: " + decide.seal(json.dumps({"role": "ci", "token": "hvs.CAESIapproved"}).encode(), public))

    def test_the_review_names_the_wifi_network_but_never_its_password(self):
        _status, scan = self.call("GET", "/api/scan")
        network = {"ssid": "Fixture Wi-Fi", "password": "fixture-wifi-password", "auth": "wpa-psk", "hidden": False}
        status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "token": "hvs.CAESIwrapped",
                                                       "disk_id": scan["internal"]["id"], "wifi": network})
        self.assertEqual(status, 200, plan)
        self.assertEqual(plan["network"], {"ssid": "Fixture Wi-Fi", "source": "entered"})
        self.assertNotIn("fixture-wifi-password", json.dumps(plan))

    def test_converting_without_a_token_waits_for_the_owner_on_github(self):
        github = self._enrolling_wizard()
        _status, scan = self.call("GET", "/api/scan")
        status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "disk_id": scan["internal"]["id"]})
        self.assertEqual(status, 200, plan)
        self.assertTrue(plan["ready"], plan["findings"])
        self.assertTrue(any(f["name"] == "enrollment" and "approve" in f["detail"] for f in plan["findings"]), plan["findings"])
        self.assertEqual(self.run_plan(plan)[0], 200)
        self._approve_when_asked(github)
        job = self.wait_job()
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(self.calls[0]["token"], "hvs.CAESIapproved")
        self.assertNotIn("hvs.CAESIapproved", json.dumps(job))
        self.assertNotIn("hvs.CAESIapproved", Path(decide.LOG["path"]).read_text())

    def test_a_refused_approval_ends_the_job_before_anything_is_erased(self):
        github = self._enrolling_wizard()
        _status, scan = self.call("GET", "/api/scan")
        _status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "disk_id": scan["internal"]["id"]})
        self.run_plan(plan)
        self._approve_when_asked(github, answer="fleet-error: Vault has no age key for the ci role. Run `just setup`.")
        job = self.wait_job()
        self.assertEqual(job["state"], "failed", job)
        self.assertIn("just setup", job["result"]["message"])
        self.assertEqual(self.calls, [])

    def test_no_approval_in_time_ends_the_job_before_anything_is_erased(self):
        self._enrolling_wizard(wait="2")
        _status, scan = self.call("GET", "/api/scan")
        _status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "disk_id": scan["internal"]["id"]})
        self.run_plan(plan)
        job = self.wait_job()
        self.assertEqual(job["state"], "failed", job)
        self.assertIn("nobody approved", job["result"]["message"])
        self.assertEqual(self.calls, [])

    def test_cancel_stops_the_wait_for_approval(self):
        self._enrolling_wizard()
        _status, scan = self.call("GET", "/api/scan")
        _status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "disk_id": scan["internal"]["id"]})
        self.run_plan(plan)
        for _ in range(100):
            if any("issues/new?" in line for line in self.call("GET", "/api/job")[1]["log"]):
                break
            time.sleep(0.2)
        self.assertEqual(self.call("POST", "/api/cancel", {})[0], 200)
        job = self.wait_job()
        self.assertEqual(job["state"], "cancelled", job)
        self.assertEqual(self.calls, [])

    def test_another_helper_cannot_replace_the_image_during_a_boot_handoff(self):
        state = Path(os.environ["FLEET_STATE"])
        state.mkdir(parents=True, exist_ok=True)
        staged = state / "fleet-installer.iso"
        original = self.iso.read_bytes()
        staged.write_bytes(original)
        replacement = self.root / "replacement.iso"
        replacement.write_bytes(make_iso(fill=8))
        entered, release = threading.Event(), threading.Event()
        def hold_lease():
            with leases.DeviceLease(INTERNAL["path"]):
                entered.set()
                release.wait(10)
        holder = threading.Thread(target=hold_lease)
        holder.start()
        try:
            self.assertTrue(entered.wait(5), "the foreign writer did not acquire its lease")
            request = {"role": "ci", "iso": str(replacement), "sha256": imaging.sha256_of(replacement), "disk_id": decide.disk_id(INTERNAL)}
            with self.assertRaises(decide.Invariant):
                helper.install_here(request, helper.Progress(self.root))
            self.assertEqual(staged.read_bytes(), original, "the active writer's handoff image must remain intact")
            self.assertEqual(self.calls, [])
        finally:
            release.set()
            holder.join(5)

    def test_devbox_requires_a_public_key_in_the_review(self):
        status, body = self.call("POST", "/api/plan", {"mode": "here", "role": "devbox"})
        self.assertEqual(status, 409)
        self.assertIn("SSH public key", body["error"])
        self.assertEqual(self.calls, [])

    def test_devbox_gui_passes_its_access_key_to_the_privileged_installer(self):
        with mock.patch.dict(os.environ):
            status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "devbox", "ssh_key": SSH_KEY})
            self.assertEqual(status, 200, plan)
            self.assertTrue(plan["ready"], plan["findings"])
            self.assertEqual(self.run_plan(plan)[0], 200)
            job = self.wait_job()
            self.assertEqual(job["state"], "done", job)
            self.assertEqual(os.environ["FLEET_DEVBOX_SSH_KEY"], SSH_KEY)
        self.assertEqual(self.calls[0]["role"], "devbox")

    def test_an_installed_marker_that_is_corrupt_stops_the_install(self):
        state = Path(os.environ["FLEET_STATE"])
        state.mkdir(parents=True, exist_ok=True)
        (state / "installed").write_text("role=toaster\nstatus=installed\n")
        _status, scan = self.call("GET", "/api/scan")
        status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "disk_id": scan["internal"]["id"]})
        self.assertEqual(status, 200, plan)
        self.run_plan(plan)
        job = self.wait_job()
        self.assertEqual(job["state"], "failed")
        self.assertIn("unknown role", job["result"]["message"])
        self.assertIn("delete that file", job["result"]["fix"])
        self.assertEqual(self.calls, [])

    def test_a_failed_privileged_check_stops_before_the_reboot(self):
        with mock.patch.dict(os.environ, {"FLEET_EFI_DIR": str(self.root / "legacy-bios")}):
            _status, scan = self.call("GET", "/api/scan")
            status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "disk_id": scan["internal"]["id"]})
            self.assertFalse(plan["ready"])
            self.assertTrue(any(f["name"] == "firmware" and f["status"] == "fail" for f in plan["findings"]))
            self.assertEqual(self.run_plan(plan)[0], 409)
        self.assertEqual(self.calls, [])

    def test_a_second_internal_disk_makes_the_target_ambiguous_and_is_refused(self):
        self.disks.write_text(json.dumps([INTERNAL, dict(INTERNAL, path="/dev/nvme1n1", serial="S6")]))
        _status, scan = self.call("GET", "/api/scan")
        self.assertTrue(scan["here_blockers"])
        status, body = self.call("POST", "/api/plan", {"mode": "here", "role": "ci"})
        self.assertEqual(status, 409)

    def test_reinstall_is_an_explicit_boolean_in_the_acknowledged_plan(self):
        for value in ("true", "false", 1, [], {}):
            with self.subTest(value=value):
                status, _body = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "reinstall": value})
                self.assertEqual(status, 409)
        status, plan = self.call("POST", "/api/plan", {"mode": "here", "role": "ci", "reinstall": True})
        self.assertEqual(status, 200, plan)
        self.assertIs(plan["reinstall"], True)
        self.assertIn("Hard reinstall", plan["summary"])


class PageTests(unittest.TestCase):
    def test_the_page_script_is_valid_javascript(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        html = (WIZARD / "index.html").read_text(encoding="utf-8")
        script = html.split("<script>", 1)[1].split("</script>", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "page.js"
            path.write_text(script, encoding="utf-8")
            done = subprocess.run([node, "--check", str(path)], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_every_element_the_script_looks_up_exists_in_the_page(self):
        html = (WIZARD / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="app"', html)
        for needed in ("/api/scan", "/api/plan", "/api/run", "/api/job", "/api/cancel"):
            self.assertIn(needed, html)

    def test_the_selftest_the_packaged_app_runs_passes_from_source(self):
        # Builds and source tests run concurrently on Windows. Each simulated
        # device must keep real locking without colliding with another selftest.
        with tempfile.TemporaryDirectory() as tmp:
            processes = [subprocess.Popen(
                [sys.executable, str(WIZARD / "main.py"), "--selftest"],
                env=dict(os.environ, FLEET_STATE=str(Path(tmp) / str(index))),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            ) for index in range(2)]
            try:
                for process in processes:
                    stdout, stderr = process.communicate(timeout=120)
                    self.assertEqual(process.returncode, 0, stdout + stderr)
                    self.assertIn("SELFTEST OK", stdout)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
