#!/usr/bin/env python3
"""Hardware support tiers: one pure classification, enforced before any destructive step.

Table-driven over decide.classify_hardware; then the gates (wizard start and the
privileged helper) and the documented matrix against the code's own."""

import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wizard"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import helper  # noqa: E402
import imaging  # noqa: E402
import preparation  # noqa: E402
from test_wizard import INTERNAL, WizardCase  # noqa: E402

finding = decide.finding
S, P, U = decide.TIER_SUPPORTED, decide.TIER_PARTIAL, decide.TIER_UNSUPPORTED
ROOT = Path(__file__).resolve().parents[1]

GOOD_LINUX = [finding("architecture", "ok", "x86_64"), finding("firmware", "ok", "booted in UEFI mode"),
              finding("boot-tool", "ok", "kexec"), finding("staging", "ok", "ext4"), finding("memory", "ok", "16 GiB"),
              finding("network", "ok", "reachable"), finding("space", "ok", "ok")]
GOOD_WINDOWS = [finding("architecture", "ok", "x86_64"), finding("firmware", "ok", "UEFI"), finding("secure-boot", "ok", "off"),
                finding("partition-style", "ok", "GPT"), finding("efi-partition", "ok", "1"), finding("system-disk", "ok", "yes"),
                finding("shrink", "ok", "ok"), finding("memory", "ok", "16 GiB")]
ONE_DISK = {"ok": True, "plain": "disk", "disk_id": "d", "path": "/dev/x"}
TWO_DISKS = {"ok": False, "next": "Next: more than one internal disk was found. Disconnect the extra disk and run this program again. Nothing was written.", "code": 2}
NO_DISK = {"ok": False, "next": "Next: no fixed internal disk was found. Connect that disk and run this program again. Nothing was written.", "code": 2}


def replace(findings, name, status, detail="x", fix="Fix it.", **extra):
    return [{**finding(name, status, detail, fix), **extra} if item["name"] == name else item for item in findings]


def add(findings, name, status, detail="x", fix="Fix it."):
    return findings + [finding(name, status, detail, fix)]


# (title, os, mode, findings, disk plan, network, tier, reason codes that must appear)
CASES = [
    ("Linux x64 UEFI with kexec", "Linux", "here", GOOD_LINUX, ONE_DISK, None, S, []),
    ("Linux x64 on wired or unknown network", "Linux", "here", GOOD_LINUX, ONE_DISK, "wired", S, []),
    ("Linux x64 with Wi-Fi as the only network", "Linux", "here", GOOD_LINUX, ONE_DISK, "wifi", P, ["wifi-driver-unverified"]),
    ("Linux kexec-tools installed automatically", "Linux", "here",
     replace(GOOD_LINUX, "boot-tool", "info", "Install the missing Linux boot tool using this system's package manager.", "", automatic=True),
     ONE_DISK, None, S, ["linux-boot-tool-install"]),
    ("Linux without kexec and no way to install it", "Linux", "here", replace(GOOD_LINUX, "boot-tool", "fail"), ONE_DISK, None, U, ["no-boot-tool"]),
    ("Linux unsupported staging filesystem (NTFS/APFS)", "Linux", "here", replace(GOOD_LINUX, "staging", "fail"), ONE_DISK, None, U,
     ["unsupported-staging-filesystem"]),
    ("Linux booted in legacy BIOS", "Linux", "here", replace(GOOD_LINUX, "firmware", "fail"), ONE_DISK, None, U, ["firmware-not-uefi"]),
    ("Linux ARM64", "Linux", "here", replace(GOOD_LINUX, "architecture", "fail", "aarch64"), ONE_DISK, None, U, ["arch-not-x86-64"]),
    ("RAM below the image plus 2 GiB", "Linux", "here", replace(GOOD_LINUX, "memory", "fail"), ONE_DISK, None, U, ["ram-below-minimum"]),
    ("Not enough staging space", "Linux", "here", replace(GOOD_LINUX, "space", "fail"), ONE_DISK, None, P, ["staging-space"]),
    ("Installer release unreachable", "Linux", "here", replace(GOOD_LINUX, "network", "fail"), ONE_DISK, None, P, ["installer-unreachable"]),
    ("A job is running on this node", "Linux", "here", add(GOOD_LINUX, "runner-idle", "fail"), ONE_DISK, None, P, ["job-running"]),
    ("Windows x64 UEFI GPT Secure Boot off", "Windows", "here", GOOD_WINDOWS, ONE_DISK, None, S, []),
    ("Windows Secure Boot on", "Windows", "here", replace(GOOD_WINDOWS, "secure-boot", "fail"), ONE_DISK, None, P, ["secure-boot-on"]),
    ("Windows Secure Boot state unreadable", "Windows", "here", replace(GOOD_WINDOWS, "secure-boot", "warn"), ONE_DISK, None, P, ["secure-boot-unknown"]),
    ("Windows BitLocker on", "Windows", "here", add(GOOD_WINDOWS, "bitlocker", "warn"), ONE_DISK, None, P, ["bitlocker-recovery-key"]),
    ("Windows RAID/VMD storage mode", "Windows", "here", add(GOOD_WINDOWS, "disk-controller", "warn"), ONE_DISK, None, P, ["raid-or-vmd-controller"]),
    ("Windows on battery", "Windows", "here", add(GOOD_WINDOWS, "power", "warn"), ONE_DISK, None, P, ["running-on-battery"]),
    ("Windows with an earlier Linux partition", "Windows", "here", add(GOOD_WINDOWS, "leftover-partition", "warn"), ONE_DISK, None, P,
     ["leftover-linux-partition"]),
    ("Windows MBR disk", "Windows", "here", replace(GOOD_WINDOWS, "partition-style", "fail"), ONE_DISK, None, U, ["disk-not-gpt"]),
    ("Windows legacy BIOS", "Windows", "here", replace(GOOD_WINDOWS, "firmware", "fail"), ONE_DISK, None, U, ["firmware-not-uefi"]),
    ("Windows dynamic disk", "Windows", "here", add(GOOD_WINDOWS, "dynamic-disk", "fail"), ONE_DISK, None, U, ["windows-dynamic-disk"]),
    ("Windows 520-byte sectors", "Windows", "here", add(GOOD_WINDOWS, "sector-size", "fail"), ONE_DISK, None, U, ["unsupported-sector-size"]),
    ("Windows without an EFI partition", "Windows", "here", replace(GOOD_WINDOWS, "efi-partition", "fail"), ONE_DISK, None, U, ["no-efi-partition"]),
    ("Windows runs from another disk", "Windows", "here", replace(GOOD_WINDOWS, "system-disk", "fail"), ONE_DISK, None, U, ["ambiguous-system-disk"]),
    ("Windows cannot shrink enough", "Windows", "here", replace(GOOD_WINDOWS, "shrink", "fail"), ONE_DISK, None, U, ["windows-cannot-shrink"]),
    ("Windows free space consolidated automatically", "Windows", "here",
     replace(GOOD_WINDOWS, "shrink", "info", "Consolidate free space once.", "", automatic=True), ONE_DISK, None, S,
     ["windows-free-space-consolidation"]),
    ("Two internal disks", "Linux", "here", GOOD_LINUX, TWO_DISKS, None, U, ["multiple-internal-disks"]),
    ("No eligible internal disk", "Linux", "here", GOOD_LINUX, NO_DISK, None, U, ["no-eligible-internal-disk"]),
    ("macOS cannot restart into the installer", "Darwin", "here", [finding("architecture", "ok", "arm64")], ONE_DISK, None, U,
     ["os-cannot-restart-into-installer"]),
    ("A check the table does not know fails", "Linux", "here", add(GOOD_LINUX, "future-check", "fail"), ONE_DISK, None, P, ["check-failed-future-check"]),
    ("USB from macOS", "Darwin", "usb", [], None, None, S, ["media-only"]),
    ("USB from Linux ARM64", "Linux", "usb", [finding("architecture", "fail", "aarch64")], None, None, S, ["media-only"]),
    ("USB too small", "Windows", "usb", [finding("usb-size", "fail", "1 GB")], None, None, U, ["usb-too-small"]),
]


class ClassificationTests(unittest.TestCase):
    def test_every_path(self):
        for title, os_name, mode, findings, disks, network, tier, codes in CASES:
            with self.subTest(title):
                result = decide.classify_hardware(os_name, mode, findings, disks, network)
                self.assertEqual(result["tier"], tier, result)
                present = {reason["code"] for reason in result["reasons"]}
                for code in codes:
                    self.assertIn(code, present, result)
                self.assertEqual(set(result), {"tier", "reasons", "required_actions", "acknowledgement", "checked"})
                if tier == U:
                    self.assertTrue(result["required_actions"], "an unsupported verdict must say what to do instead")
                    self.assertIsNone(result["acknowledgement"])
                if tier == P:
                    self.assertTrue(result["acknowledgement"], "a partial verdict must name its limitation")
                if tier == S:
                    self.assertIsNone(result["acknowledgement"])

    def test_the_tier_is_the_worst_reason(self):
        findings = add(replace(GOOD_WINDOWS, "secure-boot", "fail"), "partition-style", "fail")
        findings = replace(findings, "partition-style", "fail")
        result = decide.classify_hardware("Windows", "here", findings, ONE_DISK)
        self.assertEqual(result["tier"], U)
        self.assertEqual({r["code"] for r in result["reasons"]}, {"secure-boot-on", "disk-not-gpt"})

    def test_the_acknowledgement_names_every_limitation_and_the_actions_come_from_the_checks(self):
        findings = add(replace(GOOD_WINDOWS, "secure-boot", "warn", "Secure Boot state could not be read", "Turn Secure Boot off."),
                       "bitlocker", "warn", "BitLocker is on for C:", "Save the recovery key.")
        result = decide.classify_hardware("Windows", "here", findings, ONE_DISK)
        self.assertIn("Secure Boot state could not be read", result["acknowledgement"])
        self.assertIn("BitLocker is on for C:", result["acknowledgement"])
        self.assertEqual(result["required_actions"], ["Turn Secure Boot off.", "Save the recovery key."])

    def test_passed_checks_are_listed_as_evidence(self):
        self.assertIn("firmware", decide.classify_hardware("Linux", "here", GOOD_LINUX, ONE_DISK)["checked"])

    def test_it_is_pure(self):
        before = json.dumps(GOOD_LINUX, sort_keys=True)
        with mock.patch.object(decide, "run_logged", side_effect=AssertionError("ran a command")), \
                mock.patch("builtins.open", side_effect=AssertionError("opened a file")):
            decide.classify_hardware("Linux", "here", GOOD_LINUX, ONE_DISK, "wifi")
        self.assertEqual(json.dumps(GOOD_LINUX, sort_keys=True), before)

    def test_the_real_windows_and_linux_findings_use_known_names_only(self):
        """Every check name the code can emit at fail/warn is either in the table or knowingly generic."""
        source = (ROOT / "scripts" / "decide.py").read_text()
        # The target-machine checks: windows_findings and preflight (not node readiness or the Wi-Fi code).
        scope = (source.split("def windows_findings", 1)[1].split("def windows_plan_lines", 1)[0]
                 + source.split("def preflight", 1)[1].split("def show_findings", 1)[0])
        emitted = set(re.findall(r'finding\("([a-z-]+)", "(?:fail|warn)"', scope))
        known = {name for name, _status in decide.FINDING_TIERS}
        ignorable = {"privilege", "windows", "enrollment", "enrollment-binding"}
        self.assertEqual(emitted - known - ignorable, set())


class GateTests(unittest.TestCase):
    def test_unsupported_is_refused_even_when_acknowledged(self):
        result = decide.classify_hardware("Linux", "here", replace(GOOD_LINUX, "firmware", "fail"), ONE_DISK)
        for acknowledged in (False, True):
            with self.assertRaises(decide.Invariant) as caught:
                decide.refuse_unsupported(result, acknowledged)
            self.assertIn("unsupported", caught.exception.what)
            self.assertIn("Nothing was erased", caught.exception.fix + "Nothing was erased")

    def test_partial_needs_the_acknowledgement(self):
        result = decide.classify_hardware("Linux", "here", GOOD_LINUX, ONE_DISK, "wifi")
        with self.assertRaises(decide.Invariant) as caught:
            decide.refuse_unsupported(result, False)
        self.assertIn("partially automated", caught.exception.what)
        with self.assertRaises(decide.Invariant):
            decide.refuse_unsupported(result, "yes")  # only the boolean True counts
        decide.refuse_unsupported(result, True)

    def test_supported_passes_without_one(self):
        decide.refuse_unsupported(decide.classify_hardware("Linux", "here", GOOD_LINUX, ONE_DISK), False)


class WizardGateTests(WizardCase):
    def setUp(self):
        super().setUp()
        extra = mock.patch.dict(os.environ, {"FLEET_OS": "Linux", "FLEET_EUID": "0", "FLEET_KEXEC": sys.executable,
                                             "FLEET_ISO_FS": "ext4", "FLEET_ALLOW_ANY_OS_INSTALL": "1"})
        extra.start()
        self.addCleanup(extra.stop)
        self.httpd.shutdown()
        self.start_server("Linux")

    def plan(self, **body):
        _status, scan = self.call("GET", "/api/scan")
        return self.call("POST", "/api/plan", {"mode": "here", "disk_id": scan["internal"]["id"], **body})

    def test_scan_and_plan_carry_the_classification(self):
        _status, scan = self.call("GET", "/api/scan")
        self.assertEqual(scan["hardware"]["here"]["tier"], S)
        self.assertEqual(scan["hardware"]["usb"]["tier"], S)
        status, plan = self.plan()
        self.assertEqual(status, 200, plan)
        self.assertEqual(plan["classification"]["tier"], S)
        self.assertTrue(plan["ready"])

    def test_wifi_only_is_partial_and_start_refuses_without_the_acknowledgement(self):
        status, plan = self.plan(wifi={"ssid": "Home", "password": "correct horse"})
        self.assertEqual(status, 200, plan)
        self.assertEqual(plan["classification"]["tier"], P)
        self.assertIn("Wi-Fi", plan["classification"]["acknowledgement"])
        self.assertTrue(plan["ready"])
        status, body = self.run_plan(plan)
        self.assertEqual(status, 409)
        self.assertIn("partially automated", body["error"])
        self.assertEqual(self.wizard.job.snapshot()["state"], "idle")
        status, _ = self.run_plan(plan, ack_limitations=False)
        self.assertEqual(status, 409)

    def test_the_acknowledgement_starts_the_job_and_reaches_the_helper_request(self):
        status, plan = self.plan(wifi={"ssid": "Home", "password": "correct horse"})
        seen = {}

        def in_process(os_name, argv):
            seen.update(json.loads((Path(argv[-1]) / "request.json").read_text()))
            raise __import__("elevate").ElevationUnavailable("stop here")

        with mock.patch("elevate.start", in_process):
            self.assertEqual(self.run_plan(plan, ack_limitations=True)[0], 200)
            self.wait_job()
        self.assertTrue(seen["ack_limitations"])
        self.assertEqual(seen["network"], "wifi")

    def test_an_unsupported_plan_is_not_ready_and_start_refuses_it_even_if_tampered(self):
        with mock.patch.dict(os.environ, {"FLEET_EFI_DIR": str(self.root / "no-efi")}):
            status, plan = self.plan()
        self.assertEqual(status, 200, plan)
        self.assertEqual(plan["classification"]["tier"], U)
        self.assertFalse(plan["ready"])
        self.assertEqual(self.run_plan(plan)[0], 409)
        self.wizard.plan["ready"] = True  # defence in depth: the gate does not rely on `ready`
        status, body = self.run_plan(plan, ack_limitations=True)
        self.assertEqual(status, 409)
        self.assertIn("unsupported", body["error"])
        self.assertEqual(self.wizard.job.snapshot()["state"], "idle")

    def test_usb_is_supported_and_never_needs_the_acknowledgement(self):
        status, plan = self.usb_plan()
        self.assertEqual(status, 200, plan)
        self.assertEqual(plan["classification"]["tier"], S)
        self.assertEqual(self.run_plan(plan)[0], 200)
        self.wait_job()


class HelperGateTests(WizardCase):
    """The privileged step classifies again from fresh facts and trusts nobody's verdict."""

    def setUp(self):
        super().setUp()
        extra = mock.patch.dict(os.environ, {"FLEET_OS": "Linux", "FLEET_EUID": "0", "FLEET_KEXEC": sys.executable,
                                             "FLEET_ISO_FS": "ext4", "FLEET_ALLOW_ANY_OS_INSTALL": "1"})
        extra.start()
        self.addCleanup(extra.stop)
        for patch in (mock.patch.object(decide, "perform_install", return_value=0),):
            self.performed = patch.start()
            self.addCleanup(patch.stop)

    def request(self, **extra):
        chosen = decide.plan_disks([INTERNAL], "install")
        return {"iso": str(self.iso), "sha256": imaging.sha256_of(self.iso), "disk_id": chosen["disk_id"], **extra}

    def install(self, **extra):
        return helper.install_here(self.request(**extra), helper.Progress(self.root))

    def test_wifi_only_without_the_acknowledgement_is_refused_before_any_change(self):
        with mock.patch.object(preparation, "execute") as execute, self.assertRaises(decide.Invariant) as caught:
            self.install(network="wifi")
        self.assertIn("partially automated", caught.exception.what)
        execute.assert_not_called()
        self.performed.assert_not_called()

    def test_the_acknowledgement_lets_it_through(self):
        self.install(network="wifi", ack_limitations=True)
        self.performed.assert_called_once()

    def test_unsupported_is_refused_even_with_an_acknowledgement(self):
        with mock.patch.dict(os.environ, {"FLEET_EFI_DIR": str(self.root / "no-efi")}), \
                self.assertRaises(decide.Invariant):
            self.install(ack_limitations=True)
        self.performed.assert_not_called()


class MatrixDocumentationTests(unittest.TestCase):
    """The matrix in the docs is generated from the code's own, so it cannot drift."""

    def rows(self, name):
        text = (ROOT / "docs" / name).read_text()
        block = text.split("<!-- hardware-matrix:start -->", 1)[1].split("<!-- hardware-matrix:end -->", 1)[0]
        rows = []
        for line in block.splitlines():
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) == 3 and cells[1] in (S, P, U):
                rows.append((cells[0], cells[1], cells[2]))
        return rows

    def test_installer_and_hardware_docs_match_the_code(self):
        for name in ("installer.md", "hardware.md"):
            self.assertEqual(self.rows(name), list(decide.HARDWARE_MATRIX), name)

    def test_every_code_reason_is_documented(self):
        text = (ROOT / "docs" / "installer.md").read_text()
        codes = {code for _tier, code in decide.FINDING_TIERS.values()}
        codes |= {code for code, _detail in decide.AUTOMATIC_REASON.values()}
        codes |= {"wifi-driver-unverified", "multiple-internal-disks", "no-eligible-internal-disk",
                  "os-cannot-restart-into-installer", "media-only"}
        self.assertEqual({code for code in codes if f"`{code}`" not in text}, set())


if __name__ == "__main__":
    unittest.main()
