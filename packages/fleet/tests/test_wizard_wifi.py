"""Wi-Fi transfer without a real adapter, saved host password, or disk device."""
import gzip
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import fleet_wifi as wifi  # noqa: E402
import wifi_capture  # noqa: E402

NETWORK = {"ssid": "Home ; Wi-Fi=1", "password": "test-only-password", "auth": "wpa-psk", "hidden": True}


class WifiTransferTests(unittest.TestCase):
    def test_missing_wireless_driver_cannot_allow_an_offline_disk_install(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(wifi, "discover", return_value=None), mock.patch.object(
            wifi, "LIVE", Path(directory) / "absent"
        ), mock.patch.object(wifi.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")), mock.patch.object(
            wifi, "internet_ready"
        ) as probe:
            with self.assertRaises(wifi.NetworkUnavailable):
                wifi.main(["ready"])
            probe.assert_not_called()

    def test_profile_load_timeout_is_retryable_before_disk_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live, profile = root / "live.json", root / "profile.nmconnection"
            wifi.write_private(live, wifi.encode(NETWORK))
            with mock.patch.object(wifi, "LIVE", live), mock.patch.object(wifi, "PROFILE", profile), mock.patch.object(
                wifi, "read_private", return_value=NETWORK
            ), mock.patch.object(
                wifi.subprocess, "run", side_effect=subprocess.TimeoutExpired("nmcli", 20)
            ), mock.patch.object(wifi, "ready") as connect:
                with self.assertRaises(wifi.NetworkUnavailable):
                    wifi.main(["ready"])
                connect.assert_not_called()

    def test_slow_download_finishes_before_enrollment_and_disk_is_rechecked_afterward(self):
        events = []
        disks = [{"path": "/dev/fleet-test", "type": "disk", "tran": "nvme", "size": 10**12, "internal": True, "whole": True,
                  "model": "Fixture", "serial": "fixture", "rm": False, "hotplug": False}]
        chosen = decide.plan_disks(disks, "install")
        self.assertTrue(chosen["ok"])
        def fetch(path):
            events.append("download")
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(b"verified image")
            return 0
        def approve(role):
            events.append("approval")
            return "hvs.fixture-token", None
        def choose(*args):
            events.append("disk")
            return chosen
        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.object(decide, "current_os", return_value="Linux"), \
                mock.patch.object(decide, "state_dir", return_value=Path(temporary)), \
                mock.patch.object(decide, "choose_disk", side_effect=choose), \
                mock.patch.object(decide, "preflight", return_value=[]), \
                mock.patch.object(decide, "enroll_token", return_value=(["ci"], None, None)), \
                mock.patch.object(decide, "enroll_enabled", return_value=True), \
                mock.patch.object(decide, "installed_for", return_value=False), \
                mock.patch.object(decide, "fetch_installer", side_effect=fetch), \
                mock.patch.object(decide, "self_enroll", side_effect=approve), \
                mock.patch.object(decide, "perform_install", return_value=0), \
                mock.patch.dict(decide.NET, {"lookup": lambda *args: {"status": "ok"}}):
            self.assertEqual(decide.cmd_install(["ci", "--yes"], "install"), 0)
        self.assertLess(events.index("download"), events.index("approval"))
        self.assertEqual(events[-1], "disk")

    @unittest.skipIf(os.name == "nt", "The live initramfs runs Linux shell commands")
    def test_live_initramfs_hook_moves_credentials_privately_out_of_stage_one(self):
        root = Path(__file__).resolve().parents[1]
        text = (root / "modules/installer.nix").read_text()
        script = text.split("boot.initrd.postMountCommands =", 1)[1].split("''\n", 1)[1].split("\n  '';", 1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source, destination = folder / "seed.json", folder / "run/wifi.json"
            source.write_bytes(wifi.encode(NETWORK))
            script = script.replace("/run/fleet-wifi", str(destination.parent)).replace("/fleet-wifi.json", str(source))
            completed = subprocess.run(["bash", "-eu", "-c", script], capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertFalse(source.exists())
            self.assertEqual(wifi.read_private(destination), NETWORK)

    @unittest.skipIf(os.name == "nt", "Linux kexec requires POSIX file permissions")
    def test_linux_handoff_loads_private_initramfs_and_cleans_it_on_failure(self):
        import iso_fixture
        for code in (0, 1):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                image = Path(temporary) / "installer.iso"
                image.write_bytes(iso_fixture.build(iso_fixture.installer_tree()))
                loaded = []
                def run(args, **kwargs):
                    if "--load" in args:
                        private = Path(next(v.split("=", 1)[1] for v in args if v.startswith("--initrd=")))
                        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
                        loaded.append(private)
                        self.assertTrue(private.read_bytes().endswith(wifi.initrd(NETWORK)))
                        self.assertNotIn(NETWORK["password"], repr(args))
                    return SimpleNamespace(returncode=code)
                with mock.patch.object(decide.shutil, "which", return_value="kexec"), \
                        mock.patch.object(decide, "iso_filesystem", return_value="ext4"), \
                        mock.patch.object(decide, "run_logged", side_effect=run):
                    self.assertEqual(decide.stage_reboot("Linux", "ci", str(image), wifi=NETWORK), code)
                self.assertEqual(len(loaded), 1)
                self.assertFalse(loaded[0].exists())

    def test_bad_wifi_stops_before_runner_retirement_or_boot_preparation(self):
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "installer.iso"
            image.write_bytes(b"verified-image")
            with mock.patch.object(decide, "retire_runner_for_install") as retire, \
                    mock.patch.object(decide, "stage_reboot") as reboot, \
                    mock.patch.object(decide, "stage_windows") as windows:
                with self.assertRaises(decide.Invariant):
                    decide.perform_install("Windows", "ci", str(image), None, None, temporary,
                                           {"ok": True, "disk_id": "fixture"}, wifi={**NETWORK, "auth": "wpa-eap"})
                retire.assert_not_called()
                reboot.assert_not_called()
                windows.assert_not_called()

    def test_validation_and_keyfile_preserve_special_characters_without_injection(self):
        p = {**NETWORK, "password": r" p;ass=word\end "}
        result = wifi.keyfile(p)
        self.assertIn("ssid=72;111;109;101;32;59;32;87;105;45;70;105;61;49;", result)
        self.assertIn(r"psk=\sp;ass=word\\end\s", result)
        self.assertIn("autoconnect-retries=0", result)
        self.assertNotIn("interface-name", result)
        for bad in ({**NETWORK, "password": "bad\n[ipv4]\nmethod=manual"},
                    {**NETWORK, "ssid": "x" * 33}, {**NETWORK, "auth": "wpa-eap"},
                    {**NETWORK, "password": "short"}, {**NETWORK, "hidden": "true"}):
            with self.subTest(bad=bad.keys()), self.assertRaises(wifi.WifiError) as caught:
                wifi.validate(bad)
            self.assertNotIn(str(bad.get("password")), str(caught.exception))
        self.assertIn("key-mgmt=sae", wifi.keyfile({**NETWORK, "auth": "sae"}))
        self.assertNotIn("[wifi-security]", wifi.keyfile({**NETWORK, "auth": "open", "password": ""}))

    def test_initramfs_is_root_only_and_contains_only_the_validated_profile(self):
        archive = gzip.decompress(wifi.initrd(NETWORK))
        self.assertEqual(archive[:6], b"070701")
        fields = [int(archive[6 + i * 8:14 + i * 8], 16) for i in range(13)]
        self.assertEqual(fields[1], stat.S_IFREG | 0o600)
        self.assertEqual(fields[2:4], [0, 0])
        size, name_size = fields[6], fields[11]
        self.assertEqual(archive[110:110 + name_size], b"fleet-wifi.json\0")
        start = (110 + name_size + 3) // 4 * 4
        self.assertEqual(wifi.decode(archive[start:start + size]), NETWORK)
        self.assertIn(b"TRAILER!!!", archive)
        self.assertNotIn(NETWORK["password"], decide.grub_config("ci", "/kernel", "/initrd", "copytoram fleet.role=ci", wifi=True))

    def test_usb_write_checks_capacity_integrity_and_clears_an_old_handoff(self):
        with tempfile.TemporaryDirectory() as temporary:
            disk = Path(temporary) / "usb"
            image = b"verified ISO bytes" * 64
            capacity = (len(image) + 4095) // 4096 * 4096 + wifi.TRAILER_SIZE
            disk.write_bytes(image + bytes(capacity - len(image)))
            wifi.write_trailer(disk, capacity, len(image), NETWORK)
            self.assertEqual(wifi.read_trailer(disk), NETWORK)
            self.assertEqual(disk.read_bytes()[:len(image)], image)
            before = disk.read_bytes()
            with self.assertRaises(wifi.WifiError):
                wifi.write_trailer(disk, capacity - 1, len(image), NETWORK)
            self.assertEqual(disk.read_bytes(), before)
            corrupted = bytearray(before)
            corrupted[-wifi.TRAILER_SIZE + 55] ^= 1
            disk.write_bytes(corrupted)
            with self.assertRaises(wifi.WifiError):
                wifi.read_trailer(disk)
            wifi.write_trailer(disk, capacity, len(image), None)
            self.assertIsNone(wifi.read_trailer(disk))

    @unittest.skipIf(os.name == "nt", "POSIX owner/mode enforcement runs in Linux VM and portable Unix tests")
    def test_live_import_and_persistence_restore_after_reboot_and_reject_unsafe_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live, persistent, target = root / "run/live/wifi.json", root / "nix/network/wifi.json", root / "run/nm/profile"
            wifi.write_private(persistent, wifi.encode(NETWORK))
            wifi.prepare(live, persistent, target, devices=[])
            self.assertEqual(wifi.read_private(live), NETWORK)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(target.parent.stat().st_mode), 0o700)
            target.unlink()
            live.unlink()
            wifi.prepare(live, persistent, target, devices=[])
            self.assertIn("psk=test-only-password", target.read_text())
            os.chmod(live, 0o644)
            with self.assertRaises(wifi.WifiError):
                wifi.read_private(live)
            live.unlink()
            live.symlink_to(persistent)
            with self.assertRaises((wifi.WifiError, OSError)):
                wifi.read_private(live)

    @unittest.skipIf(os.name == "nt", "Private runtime files are created by the Linux installer")
    def test_conflicting_usb_profiles_stop_before_configuration_and_identical_copies_are_safe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            a, b = root / "a", root / "b"
            a.write_bytes(wifi.trailer(NETWORK))
            b.write_bytes(wifi.trailer({**NETWORK, "ssid": "different"}))
            args = (root / "live/wifi.json", root / "persist/wifi.json", root / "nm/profile")
            with self.assertRaises(wifi.WifiError):
                wifi.prepare(*args, devices=[a, b])
            self.assertFalse(args[0].exists())
            self.assertFalse(args[2].exists())
            b.write_bytes(wifi.trailer(NETWORK))
            self.assertEqual(wifi.prepare(*args, devices=[a, b]), NETWORK)

    def test_reconnect_is_bounded_and_checks_internet_without_password_arguments(self):
        attempts = iter([10, 0])
        def run(args, **kw):
            if args[:2] == ["nmcli", "--terse"] and args[-1] == "device":
                return SimpleNamespace(returncode=0, stdout=b"wlan0:wifi:disconnected\n", stderr=b"")
            return SimpleNamespace(returncode=next(attempts) if "--wait" in args else 0, stdout=b"", stderr=b"")
        run = mock.Mock(side_effect=run)
        sleep, probe = mock.Mock(), mock.Mock()
        self.assertEqual(wifi.ready(NETWORK, run, sleep, probe), NETWORK)
        self.assertEqual(sum("--wait" in call.args[0] for call in run.call_args_list), 2)
        probe.assert_called_once()
        self.assertNotIn(NETWORK["password"], repr(run.call_args_list))
        run = mock.Mock(side_effect=lambda args, **kw: SimpleNamespace(
            returncode=0, stdout=b"wlan0:wifi:disconnected\n" if args[-1] == "device" else b"", stderr=b""))
        with self.assertRaises(wifi.WifiError):
            wifi.ready(NETWORK, run, sleep, mock.Mock(side_effect=OSError("captive portal")))
        self.assertEqual(sum("--wait" in call.args[0] for call in run.call_args_list), 3)


    def test_simulated_installs_never_read_the_host_wifi_password(self):
        for seam in ("FLEET_DISKS_FILE", "FLEET_WINDOWS_TARGET", "FLEET_WRITE_TARGET", "FLEET_ALLOW_UNPRIVILEGED", "FLEET_DD", "FLEET_LSBLK", "FLEET_DISKUTIL", "FLEET_POWERSHELL"):
            with mock.patch.dict(os.environ, {seam: "test"}), mock.patch.object(wifi_capture, "capture") as capture:
                self.assertIsNone(wifi.discover("Windows"))
                capture.assert_not_called()
                self.assertEqual(wifi.discover("Windows", NETWORK), NETWORK)

    def test_command_standins_cannot_make_the_wifi_writer_open_a_host_device(self):
        with mock.patch.dict(os.environ, {"FLEET_DD": "fixture-dd"}), mock.patch.object(wifi.os, "open") as opened:
            with self.assertRaises(wifi.WifiError):
                wifi.write_trailer("/dev/fleet-nonexistent-device", 1024 * 1024, 4096, NETWORK)
            opened.assert_not_called()


class WifiCaptureTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Exercise the native Windows ABI on Windows CI")
    def test_native_windows_api_reads_only_the_connected_profile_and_frees_buffers(self):
        import ctypes as c
        import struct
        xml = '<WLANProfile><SSIDConfig><SSID><name>Fixture</name></SSID></SSIDConfig><MSM><security><authEncryption><authentication>WPA2PSK</authentication></authEncryption><sharedKey><protected>false</protected><keyMaterial>fixture-password</keyMaterial></sharedKey></security></MSM></WLANProfile>'
        interfaces = c.create_string_buffer(struct.pack('<II', 1, 0) + bytes(16 + 512) + struct.pack('<I', 1))
        current = c.create_string_buffer(520)
        name = 'FixtureProfile'.encode('utf-16-le')
        current[8:8 + len(name)] = name
        profile = c.create_unicode_buffer(xml)
        freed, closed = [], []
        class Function:
            def __init__(self, call):
                self.call = call
            def __call__(self, *args):
                return self.call(*args)
        def opened(version, reserved, actual, handle):
            handle._obj.value = 123
            actual._obj.value = 2
            return 0
        def enumerated(handle, reserved, pointer):
            pointer._obj.value = c.addressof(interfaces)
            return 0
        def queried(handle, guid, opcode, reserved, size, pointer, kind):
            self.assertEqual(opcode, 7)
            size._obj.value = 520
            pointer._obj.value = c.addressof(current)
            return 0
        def retrieved(handle, guid, selected, reserved, pointer, flags, access):
            self.assertEqual(selected, 'FixtureProfile')
            self.assertEqual(flags._obj.value, 4)
            pointer._obj.value = c.addressof(profile)
            return 0
        api = SimpleNamespace(
            WlanOpenHandle=Function(opened), WlanEnumInterfaces=Function(enumerated),
            WlanQueryInterface=Function(queried), WlanGetProfile=Function(retrieved),
            WlanFreeMemory=Function(lambda pointer: freed.append(pointer.value)),
            WlanCloseHandle=Function(lambda *args: closed.append(True)),
        )
        with mock.patch.object(c, 'WinDLL', return_value=api):
            result = wifi_capture.windows()
        self.assertEqual(result['password'], 'fixture-password')
        self.assertEqual(result['ssid'], 'Fixture')
        self.assertCountEqual(freed, [c.addressof(current), c.addressof(profile), c.addressof(interfaces)])
        self.assertEqual(closed, [True])

    def test_networkmanager_reads_only_the_active_wireless_profile_without_binding_an_adapter(self):
        identifier = "11111111-1111-1111-1111-111111111111"
        fields = {"802-11-wireless.ssid": NETWORK["ssid"], "802-11-wireless-security.key-mgmt": "wpa-psk",
                  "802-11-wireless-security.psk": NETWORK["password"], "802-11-wireless.hidden": "yes"}
        def output(args):
            if "--active" in args:
                return f"22222222-2222-2222-2222-222222222222:802-3-ethernet\n{identifier}:802-11-wireless"
            self.assertEqual(args[-1], identifier)
            return fields[args[args.index("--get-values") + 1]]
        with mock.patch.object(wifi_capture.shutil, "which", return_value="/bin/nmcli"), mock.patch.object(wifi_capture, "output", side_effect=output):
            self.assertEqual(wifi_capture.linux(), NETWORK)

    def test_windows_profile_uses_hex_ssid_and_rejects_enterprise_or_encrypted_keys(self):
        xml = '''<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><SSIDConfig><SSID><hex>486f6d65</hex><name>ignored</name></SSID><nonBroadcast>true</nonBroadcast></SSIDConfig><MSM><security><authEncryption><authentication>WPA2PSK</authentication><useOneX>false</useOneX></authEncryption><sharedKey><protected>false</protected><keyMaterial>fixture-password</keyMaterial></sharedKey></security></MSM></WLANProfile>'''
        p = wifi_capture.windows_xml(xml)
        self.assertEqual(p, {"ssid": "Home", "password": "fixture-password", "auth": "wpa-psk", "hidden": True})
        for bad in (xml.replace("WPA2PSK", "WPA2"), xml.replace("<protected>false", "<protected>true"), "<broken"):
            with self.assertRaises(wifi.WifiError) as caught:
                wifi_capture.windows_xml(bad)
            self.assertNotIn("fixture-password", str(caught.exception))

    def test_the_review_reads_the_network_name_without_secrets_and_tolerates_failure(self):
        def output(args):
            self.assertNotIn("--show-secrets", args)
            return "no:Neighbour\nyes:Home ; Wi-Fi=1\n"
        with mock.patch.object(wifi_capture.shutil, "which", return_value="/bin/nmcli"), mock.patch.object(wifi_capture, "output", side_effect=output):
            self.assertEqual(wifi_capture.connected_name("Linux"), "Home ; Wi-Fi=1")
        with mock.patch.object(wifi_capture.shutil, "which", return_value="/bin/nmcli"), \
                mock.patch.object(wifi_capture, "output", side_effect=wifi.WifiError("unreadable")):
            self.assertIsNone(wifi_capture.connected_name("Linux"))

    def test_capture_failures_never_return_command_output_or_credentials(self):
        with mock.patch.object(wifi_capture.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, NETWORK["password"], NETWORK["password"])):
            with self.assertRaises(wifi.WifiError) as caught:
                wifi_capture.output(["network-tool"])
            self.assertNotIn(NETWORK["password"], str(caught.exception))


@unittest.skipIf(os.name == "nt", "the live installer's readiness runs on Linux (sysfs, nmcli, POSIX file ownership)")
class LiveReadinessTests(unittest.TestCase):
    """The live installer connects what it can and says exactly why it could not."""

    SSID = "Vouga Home"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sys = self.root / "sys"
        self.env = mock.patch.dict(os.environ, {"FLEET_LIVE_STATE": str(self.root / "live"), "FLEET_SYS": str(self.sys),
                                                "FLEET_CMDLINE": str(self.root / "cmdline")})
        self.env.start()
        (self.root / "cmdline").write_text("copytoram fleet.from=windows fleet.wifi=sent fleet.role=ci\n")
        patches = [mock.patch.object(wifi, "LIVE", self.root / "run/wifi.json"),
                   mock.patch.object(wifi, "PROFILE", self.root / "nm/fleet-wifi.nmconnection")]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def nic(self, name, driver=None, wireless=False, pci=("0x8086", "0x2723"), carrier="0"):
        device = self.sys / "devices/pci0000:00" / name
        device.mkdir(parents=True)
        (device / "vendor").write_text(pci[0] + "\n")
        (device / "device").write_text(pci[1] + "\n")
        if driver:
            (self.sys / "drivers" / driver).mkdir(parents=True, exist_ok=True)
            (device / "driver").symlink_to(self.sys / "drivers" / driver)
        entry = self.sys / "class/net" / name
        entry.mkdir(parents=True)
        (entry / "device").symlink_to(device)
        (entry / "operstate").write_text("down\n")
        (entry / "carrier").write_text(carrier + "\n")
        if wireless:
            (entry / "wireless").mkdir()

    def nmcli(self, devices="wlp1s0:wifi:disconnected", scan="", up=None, routes=""):
        """A stand-in for the network tools; `up` maps an auth to NetworkManager's error."""
        calls = []
        def run(args, **kw):
            calls.append(args)
            out, err, code = "", "", 0
            if args[:2] == ["ip", "route"] or args[:2] == ["ip", "-6"]:
                out = routes
            elif args[-1] == "device" and "DEVICE,TYPE,STATE" in args:
                out = devices
            elif "list" in args:
                out = scan
            elif "up" in args:
                keyfile = wifi.PROFILE.read_text() if wifi.PROFILE.exists() else ""
                auth = "sae" if "key-mgmt=sae" in keyfile else "wpa-psk"
                if up and auth in up:
                    code, err = 4, up[auth]
            elif args[0] == "journalctl":
                out = ("wlp1s0: deauthenticated from 12:34:56:78:9a:bc (Reason: 15=4WAY_HANDSHAKE_TIMEOUT)\n"
                       "iwlwifi 0000:01:00.0: Direct firmware load for iwlwifi-so-a0.ucode failed with error -2\n")
            return SimpleNamespace(returncode=code, stdout=out.encode(), stderr=err.encode())
        return run, calls

    def network(self):
        return json.loads((self.root / "live/network.json").read_text())

    def test_terse_fields_keep_escaped_colons_in_network_names(self):
        self.assertEqual(wifi.terse(r"Cafe\: 2nd floor:72:WPA2 WPA3:5180 MHz"), ["Cafe: 2nd floor", "72", "WPA2 WPA3", "5180 MHz"])

    def test_variants_follow_what_the_network_in_range_offers(self):
        sae = {**NETWORK, "auth": "sae", "hidden": False}
        psk = {**NETWORK, "hidden": False}
        self.assertEqual([v["auth"] for v in wifi.variants(sae, {"visible": True, "security": "WPA2 WPA3"})], ["sae", "wpa-psk"])
        self.assertEqual([v["auth"] for v in wifi.variants(psk, {"visible": True, "security": "WPA3"})], ["sae", "wpa-psk"])
        self.assertEqual(wifi.variants(psk, {"visible": True, "security": "WPA2"}), [psk])
        self.assertEqual([v["hidden"] for v in wifi.variants(psk, {"visible": False, "nearby": 4})], [False, True])

    def test_wpa3_from_windows_falls_back_to_wpa2_and_the_working_profile_is_kept(self):
        self.nic("wlp1s0", "iwlwifi", wireless=True)
        profile = {"ssid": self.SSID, "password": "test-only-password", "auth": "sae", "hidden": False}
        wifi.write_private(wifi.LIVE, wifi.encode(profile))
        run, calls = self.nmcli(scan="Vouga Home:62:WPA2 WPA3:5180 MHz\nOther:40:WPA2:2412 MHz\n",
                                up={"sae": f"Error: Connection activation failed: Secrets were required, but not provided for '{self.SSID}'"})
        probe = mock.Mock()
        wifi.check(run, probe)
        self.assertEqual(wifi.read_private(wifi.LIVE)["auth"], "wpa-psk")
        self.assertIn("key-mgmt=wpa-psk", wifi.PROFILE.read_text())
        facts = self.network()
        self.assertEqual(facts["code"], "ready")
        self.assertEqual([a["result"] for a in facts["attempts"]], ["refused", "connected"])
        self.assertEqual(facts["scan"], {"nearby": 2, "visible": True, "signal": 62, "security": "WPA2 WPA3", "band": "5 GHz"})
        self.assertEqual(facts["sent"], "sent")
        text = (self.root / "live/network.json").read_text()
        self.assertNotIn(profile["password"], text)
        self.assertNotIn(self.SSID, json.dumps(facts["attempts"]))
        self.assertNotIn(profile["password"], repr(calls))
        self.assertEqual(oct((self.root / "live/network.json").stat().st_mode & 0o777), "0o644")

    def test_a_refused_password_is_named_and_retryable(self):
        self.nic("wlp1s0", "iwlwifi", wireless=True)
        wifi.write_private(wifi.LIVE, wifi.encode({**NETWORK, "ssid": self.SSID, "hidden": False}))
        run, _ = self.nmcli(scan="Vouga Home:62:WPA2:2437 MHz\n",
                            up={"wpa-psk": "Error: Connection activation failed: (7) Secrets were required, but not provided"})
        with mock.patch.object(wifi.time, "sleep") as sleep, self.assertRaises(wifi.NetworkUnavailable) as caught:
            wifi.check(run, mock.Mock())
        self.assertEqual(str(caught.exception), "The Wi-Fi network refused the saved password.")
        facts = self.network()
        self.assertEqual(facts["code"], "refused")
        self.assertEqual(facts["checks"]["visible"]["state"], "ok")
        self.assertEqual(len([a for a in facts["attempts"] if a["result"] == "refused"]), 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertIn("deauthenticated from <mac>", " ".join(facts["kernel"]))
        self.assertNotIn("12:34:56", json.dumps(facts))

    def test_no_adapter_names_the_hardware_without_a_driver(self):
        self.nic("enp2s0", "r8169", pci=("0x10ec", "0x8168"))
        unclaimed = self.sys / "bus/pci/devices/0000:02:00.0"
        unclaimed.mkdir(parents=True)
        (unclaimed / "class").write_text("0x028000\n")
        (unclaimed / "vendor").write_text("0x14e4\n")
        (unclaimed / "device").write_text("0x43b1\n")
        wifi.write_private(wifi.LIVE, wifi.encode(NETWORK))
        run, _ = self.nmcli(devices="enp2s0:ethernet:unmanaged")
        clock = iter(range(0, 1000, 5))
        with self.assertRaises(wifi.NetworkUnavailable) as caught:
            wifi.ready(NETWORK, run, mock.Mock(), mock.Mock(), wifi.Facts(self.root / "live/network.json"),
                       clock=lambda: next(clock))
        self.assertIn("pci 14e4:43b1", str(caught.exception))
        facts = self.network()
        self.assertEqual(facts["code"], "no-driver")
        self.assertTrue(facts["kernel"])

    def test_working_internet_is_used_as_is_and_a_chosen_network_replaces_the_carried_one(self):
        wifi.write_private(wifi.LIVE, wifi.encode(NETWORK))
        chosen = {"ssid": "Phone hotspot", "password": "another-test-password", "auth": "wpa-psk", "hidden": False}
        run, calls = self.nmcli(routes="default via 192.0.2.1 dev wlp1s0 proto dhcp\n")
        with mock.patch.object(wifi, "discover", return_value=chosen):
            wifi.check(run, mock.Mock())
        self.assertFalse(any("up" in args for args in calls), "a working connection is never replaced")
        self.assertEqual(wifi.read_private(wifi.LIVE), chosen)
        self.assertEqual(self.network()["via"], ["wlp1s0"])

    def test_settings_lost_on_the_way_are_told_apart_from_none_sent(self):
        run, _ = self.nmcli()
        for marker, expected in (("sent", "settings-lost"), ("none", "no-settings")):
            (self.root / "cmdline").write_text(f"fleet.from=windows fleet.wifi={marker} fleet.role=ci\n")
            with mock.patch.object(wifi, "discover", return_value=None), self.assertRaises(wifi.NetworkUnavailable):
                wifi.check(run, mock.Mock())
            self.assertEqual(self.network()["code"], expected)
        self.assertEqual(self.network()["run"], 2)

    def test_internet_check_says_which_part_failed(self):
        with mock.patch.object(wifi.socket, "getaddrinfo", side_effect=OSError("no name")):
            with self.assertRaises(wifi.WifiError) as caught:
                wifi.internet_ready()
        self.assertIn("DNS", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
