#!/usr/bin/env python3
"""The live installer always says what is happening, what to do and how to report it."""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

FLEET = Path(__file__).resolve().parents[1]
SCRIPT = FLEET / "scripts" / "live_console.py"
FORM = FLEET.parents[1] / ".github" / "ISSUE_TEMPLATE" / "fleet-installer.yml"
sys.path.insert(0, str(FLEET / "scripts"))
import decide  # noqa: E402
import live_console  # noqa: E402

# Assembled at runtime: shaped like a Vault token for redaction, never a real one.
SECRET = "hv" + "s." + "fleet-test-only-not-a-credential"


class LiveConsoleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cmdline = self.root / "cmdline"
        self.cmdline.write_text(f"init=/x copytoram fleet.enroll={SECRET} fleet.from=windows fleet.role=ci\n")
        toplevel = self.root / "system"
        (toplevel / "etc/fleet").mkdir(parents=True)
        (toplevel / "etc/fleet/revision").write_text("c839ee07aabbccddeeff00112233445566778899\n")
        (self.root / "manifest").write_text(f"base {toplevel}\ndisko /x\n")
        self.log = self.root / "install.log"
        self.console = self.root / "console"
        self.urls = self.root / "qr-urls"
        qrencode = self.root / "qrencode"
        qrencode.write_text(f'#!/bin/sh\nfor last; do :; done\nprintf "%s\\n" "$last" >> {self.urls}\necho QR-CODE\n')
        qrencode.chmod(qrencode.stat().st_mode | stat.S_IEXEC)
        self.systemctl = self.root / "systemctl"
        self.systemctl.write_text(f'#!/bin/sh\necho "$*" >> {self.root / "systemctl.log"}\n[ "$1" = is-active ] && exit 3\nexit 0\n')
        self.systemctl.chmod(self.systemctl.stat().st_mode | stat.S_IEXEC)
        self.env = {**os.environ, "FLEET_LIVE_STATE": str(self.root / "state"), "FLEET_INSTALL_LOG": str(self.log),
                    "FLEET_CMDLINE": str(self.cmdline), "FLEET_MANIFEST": str(self.root / "manifest"),
                    "FLEET_CONSOLE": str(self.console), "FLEET_QRENCODE": str(qrencode),
                    "FLEET_SYSTEMCTL": str(self.systemctl), "FLEET_AUTO_STATE": str(self.root / "started"),
                    "FLEET_CONSOLE_SIZE": "128x48"}

    def tearDown(self):
        self.tmp.cleanup()

    def live(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *args], capture_output=True, text=True, env=self.env, timeout=30)

    def test_every_step_names_itself_what_to_do_and_that_nothing_is_erased_yet(self):
        for number, (ident, _, _) in enumerate(live_console.STEPS, 1):
            if ident == "erase":
                Path(str(self.log) + ".erasing").touch()
            self.console.write_text("")
            self.assertEqual(self.live("step", ident).returncode, 0)
            screen = self.console.read_text()
            self.assertIn(f"[>] {number}.", screen)
            self.assertIn(f" NOW     Step {number} of 7", screen)
            self.assertIn("Alt+F2", screen)
            flat = " ".join(screen.split())
            if number >= 5:
                self.assertNotIn("Not erased", flat)
                self.assertIn("ERASING NOW" if ident == "erase" else "Erased.", flat)
            else:
                self.assertIn("DISK Not erased. Windows is still on this computer. Nothing is erased until steps 1 to 4", flat)
                self.assertIn("<- the first step that changes the disk", screen)

    def test_a_wait_explains_the_reason_and_when_it_gives_up(self):
        self.live("step", "checks")
        Path(str(self.log) + ".diagnostic").write_text(
            "FLEET_CACHE_UNAVAILABLE: this revision is not readable with its pinned signing key. Retrying before disk changes.\n")
        self.console.write_text("")
        now = json.loads((self.root / "state/state.json").read_text())["updated"] + 0.25
        # A loaded runner can cross a second between saving and drawing. Fix
        # the clock so this assertion checks the countdown, not scheduling.
        with patch.dict(os.environ, self.env, clear=True), patch.object(live_console.time, "time", return_value=now), patch("sys.stdout"):
            self.assertEqual(live_console.main(["wait", "--attempt", "2", "--remaining", "330", "--retry", "30"]), 0)
        screen = self.console.read_text()
        flat = " ".join(screen.split())
        self.assertIn("[~] 3.", screen)
        self.assertIn("Attempt 2 is not ready", flat)
        self.assertIn("update cache", flat)
        self.assertIn("5 min 30 s", flat)
        self.assertIn("restarts into Windows", flat)
        self.assertIn("Nothing is erased either way", flat)
        self.console.write_text("")
        with patch.dict(os.environ, self.env, clear=True), patch.object(live_console.time, "time", return_value=now + 1), patch("sys.stdout"):
            self.assertEqual(live_console.main(["tick"]), 0)
        self.assertIn("5 min 29 s", " ".join(self.console.read_text().split()))

    def test_a_stop_shows_recovery_a_return_countdown_and_a_scannable_redacted_report(self):
        self.live("step", "checks")
        Path(str(self.log) + ".diagnostic").write_text(
            f"FLEET_APPROVAL_REQUIRED: this hardware identity is not approved. token {SECRET}\n")
        self.console.write_text("")
        self.live("stopped", "--status", "2", "--returning", "120")
        screen = " ".join(self.console.read_text().split())
        self.assertIn("STOPPED at step 3 of 7", screen)
        self.assertIn("approve this computer under Pending", screen)
        self.assertIn("Restarts into Windows in 2 min 0 s. Press Enter", screen)
        self.assertIn("QR-CODE", screen)
        url = self.urls.read_text().strip()
        self.assertLessEqual(len(url), live_console.QR_CAPACITY[14])
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(query["template"], ["fleet-installer.yml"])
        self.assertEqual(query["title"], ["Fleet installer screen: FLEET_APPROVAL_REQUIRED"])
        self.assertIn("step 3 of 7", query["step"][0])
        self.assertIn("base c839ee07 windows stopped-before-erase exit=2 step=3/7", query["diagnostic"][0])
        self.assertNotIn("%20", url)
        for text in (screen, url, (self.root / "state/state.json").read_text()):
            self.assertNotIn(SECRET, text)

    def test_a_failure_after_erasing_never_offers_to_return(self):
        self.live("step", "install")
        Path(str(self.log) + ".erasing").touch()
        self.console.write_text("")
        self.live("stopped", "--status", "1", "--returning", "0")
        screen = " ".join(self.console.read_text().split())
        self.assertIn("after the internal disk was erased", screen)
        self.assertIn("make an install USB", screen)
        self.assertNotIn("Restarts into", screen)
        for command in ("retry", "return"):
            result = self.live(command)
            self.assertEqual(result.returncode, 2)
            self.assertIn("fleet-report", result.stderr)
        self.assertFalse((self.root / "systemctl.log").exists() and "reboot" in (self.root / "systemctl.log").read_text())

    def test_retry_and_return_before_erasing(self):
        self.live("step", "checks")
        self.live("stopped", "--status", "2")
        (self.root / "started").write_text("5\n")
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        sudo = self.root / "sudo"
        sudo.write_text('#!/bin/sh\nshift\nexec "$@"\n')
        sudo.chmod(sudo.stat().st_mode | stat.S_IEXEC)
        self.assertEqual(self.live("retry").returncode, 0)
        self.assertFalse((self.root / "started").exists())
        self.assertEqual(self.live("return").returncode, 0)
        calls = (self.root / "systemctl.log").read_text()
        self.assertIn(f"restart --no-block {live_console.UNIT}", calls)
        self.assertIn("reboot", calls)

    def test_status_and_report_at_the_prompt(self):
        empty = self.live("status")
        self.assertIn("No Fleet installation has started", empty.stdout)
        self.live("step", "checks")
        self.live("stopped", "--status", "2")
        status = self.live("status")
        for command in ("fleet-status", "fleet-report", "fleet-retry", "fleet-return"):
            self.assertIn(command, status.stdout)
        report = self.live("report", "--full")
        url = next(line for line in report.stdout.splitlines() if line.startswith("https://"))
        self.assertLessEqual(len(url), decide.ISSUE_URL_MAX)
        self.assertIn("Revision: c839ee07aabbccddeeff00112233445566778899",
                      urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["diagnostic"][0])

    def test_progress_redraws_the_steps_only_while_a_long_step_runs(self):
        self.live("step", "install")
        self.log.write_text("2026-10-26T18:00:00Z nixos-install of /nix/store/" + "a" * 32 + "-nixos-system-ci\n")
        for _ in range(3):
            self.console.write_text("")
            self.live("tick")
            screen = self.console.read_text()
            self.assertIn("[>] 6. Install the Fleet base system", screen)
            self.assertIn("Still working", screen)
            self.assertIn("nixos-install of nixos-system-ci", " ".join(screen.split()))
        self.live("stopped", "--status", "1")
        self.console.write_text("")
        self.live("tick")
        self.assertEqual(self.console.read_text(), "")

    def network(self, **changes):
        facts = {"run": 4, "sent": "sent", "arrived": True, "code": "refused",
                 "verdict": "The Wi-Fi network refused the saved password.",
                 "adapters": [{"name": "wlp1s0", "type": "wifi", "driver": "iwlwifi", "id": "pci 8086:2723", "link": "down", "carrier": False}],
                 "radios": [{"soft": False, "hard": False}], "clock": "2026-10-26T16:00:00Z", "via": [],
                 "profile": {"ssid": "Vouga Home", "auth": "sae", "hidden": False},
                 "scan": {"nearby": 9, "visible": True, "signal": 62, "security": "WPA2 WPA3", "band": "5 GHz"},
                 "checks": {"adapter": {"state": "ok", "detail": "wlp1s0 (iwlwifi)"}, "settings": {"state": "ok", "detail": "WPA3 Personal"},
                            "visible": {"state": "ok", "detail": "signal 62%, 5 GHz, WPA2 WPA3"},
                            "connect": {"state": "fail", "detail": "The Wi-Fi network refused the saved password."}},
                 "attempts": [{"auth": "sae", "hidden": False, "result": "refused", "detail": "Secrets were required, but not provided"},
                              {"auth": "wpa-psk", "hidden": False, "result": "refused", "detail": "Secrets were required, but not provided"}],
                 "kernel": ["iwlwifi 0000:01:00.0: Direct firmware load for iwlwifi-so-a0.ucode failed with error -2"], **changes}
        (self.root / "state").mkdir(exist_ok=True)
        (self.root / "state/network.json").write_text(json.dumps(facts))

    def test_the_network_step_shows_each_check_and_what_to_do_with_the_name_only_on_screen(self):
        self.cmdline.write_text("copytoram fleet.from=windows fleet.attempt=0123456789abcdef fleet.wizard=1a2b3c4 fleet.wifi=sent fleet.role=ci\n")
        self.live("step", "network")
        self.network()
        self.console.write_text("")
        self.live("tick")
        screen = " ".join(self.console.read_text().split())
        self.assertIn('[x] Saved Wi-Fi "Vouga Home", WPA3 Personal, from Windows', screen)
        self.assertIn("[!] Connect The Wi-Fi network refused the saved password.", screen)
        self.assertIn("type fleet-wifi", screen)
        self.assertIn("USB tethering", screen)
        self.assertIn("Not erased. Windows is still on this computer.", screen)
        (self.root / "state/attempt.log").write_text("FLEET_NETWORK_WAIT_EXPIRED: the checks before erasing were still not ready after 10 minutes.\n")
        self.live("stopped", "--status", "2", "--returning", "120")
        url = self.urls.read_text().splitlines()[-1]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(query["title"], ["Fleet installer screen: FLEET_NETWORK_WAIT_EXPIRED (refused)"])
        self.assertIn("net refused wifi=sent,arrived auth=sae seen=62%,5GHz,WPA2 WPA3", query["diagnostic"][0])
        self.assertIn("Started from: windows wizard=1a2b3c4 attempt=0123456789abcdef", self.live("report", "--full").stdout)
        report = self.live("report", "--full").stdout
        for text in (url, report):
            self.assertNotIn("Vouga", text)
        self.assertIn("try sae:refused wpa-psk:refused (Secrets were required, but not provided)", report)
        self.assertIn("klog iwlwifi 0000:01:00.0: Direct firmware load", report)

    def test_the_report_code_is_as_big_as_the_console_allows(self):
        # A stand-in that draws a square the size of a real code for the link it is given.
        fake = self.root / "qrencode-sized"
        fake.write_text("#!/usr/bin/env python3\nimport sys, math\n"
                        f"url = sys.argv[-1]\nopen({str(self.urls)!r}, 'a').write(url + '\\n')\n"
                        f"caps = {live_console.QR_CAPACITY!r}\n"
                        "version = min(v for v, c in caps.items() if c >= len(url))\n"
                        "side = 21 + 4 * version\n"
                        "print('\\n'.join(['\\033[47m' + '#' * side + '\\033[0m'] * math.ceil(side / 2)))\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.env["FLEET_QRENCODE"] = str(fake)
        self.network()
        self.live("step", "network")
        Path(str(self.log) + ".diagnostic").write_text("FLEET_NETWORK_UNAVAILABLE: The Wi-Fi network refused the saved password.\n")
        for size, beside in (("240x67", True), ("128x48", True), ("100x37", False)):
            self.env["FLEET_CONSOLE_SIZE"] = size
            self.console.write_text("")
            self.live("stopped", "--status", "2")
            columns, rows = map(int, size.split("x"))
            lines = self.console.read_text().splitlines()
            self.assertLessEqual(len(lines), rows, size)
            self.assertLessEqual(max(live_console.visible(line) for line in lines), columns, size)
            drawn = [line for line in lines if "\033[" in line]
            if beside:
                self.assertTrue(drawn and "STOPPED" in drawn[1], size)
            else:
                self.assertEqual(drawn, [], size)
                self.assertIn("fleet-report", " ".join(" ".join(lines).split()))
        urls = self.urls.read_text().splitlines()
        self.assertNotIn("cut+to+fit", urls[0], "a 1920x1080 console carries the whole compact report")
        self.assertIn("cut+to+fit", urls[1])
        self.assertLessEqual(len(urls[1]), live_console.QR_CAPACITY[14])

    def test_the_install_unit_never_describes_the_wait_as_wiping(self):
        nix = (FLEET / "modules/installer.nix").read_text()
        unit = nix.split("systemd.services.fleet-auto-install = {", 1)[1].split("};", 1)[0]
        description = re.search(r'description = "([^"]+)"', unit).group(1)
        self.assertNotRegex(description.lower(), r"wipe|erases? the")
        self.assertIn('systemd.settings.Manager.ShowStatus = "error"', nix)

    def test_a_broken_screen_never_stops_the_installation(self):
        blocker = self.root / "not-a-directory"
        blocker.write_text("")
        self.env["FLEET_LIVE_STATE"] = str(blocker / "state")
        self.assertEqual(self.live("step", "checks").returncode, 0)
        self.assertEqual(self.live("bogus").returncode, 2)


class IssueFormTests(unittest.TestCase):
    def test_prefilled_fields_exist_on_the_github_form(self):
        text = FORM.read_text()
        ids = re.findall(r"^\s+id:\s*([a-z-]+)\s*$", text, re.M)
        for field in decide.ISSUE_FIELDS:
            self.assertIn(field, ids)
        self.assertEqual(decide.ISSUE_FORM, FORM.name)

    def test_cli_failures_end_with_a_report_link(self):
        link = decide.report_link(f"Next: the enrollment token {SECRET} was refused. Nothing was written.", "doctor")
        self.assertTrue(link.startswith("Report: https://github.com/crvouga/fleet/issues/new?template=fleet-installer.yml"))
        self.assertNotIn(SECRET, link)
        self.assertLessEqual(len(link), 2100)


if __name__ == "__main__":
    unittest.main()
