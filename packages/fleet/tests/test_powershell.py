#!/usr/bin/env python3
"""Every PowerShell script the Windows conversion can send, checked with the real
PowerShell parser, and run against stand-in cmdlets so the property names, the
pipelines and the JSON they print are exercised too (Linux PowerShell cannot call
the Windows Storage cmdlets, so those are replaced by functions of the same name).

Needs PowerShell 7: `pwsh` on PATH (CI has it), or Docker with an image that has it
(FLEET_PWSH_DOCKER_IMAGE, default mcr.microsoft.com/powershell:lts-ubuntu-22.04).
When neither exists these tests are SKIPPED with a loud message locally, and FAIL
when the CI environment variable is set: a green run must have parsed the scripts.
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402

DOCKER_IMAGE = os.environ.get("FLEET_PWSH_DOCKER_IMAGE", "mcr.microsoft.com/powershell:lts-ubuntu-22.04")
PWSH_FLAGS = ["pwsh", "-NoProfile", "-NonInteractive"]
_RUNNER = {}


def powershell_command():
    """argv prefix that runs pwsh, or None. Cached."""
    if "argv" in _RUNNER:
        return _RUNNER["argv"]
    candidates = []
    if shutil.which("pwsh"):
        candidates.append([])
    if shutil.which("docker"):
        candidates.append(["docker", "run", "--rm", "-i", "-e", "TERM=dumb", DOCKER_IMAGE])
    for prefix in candidates:
        try:
            done = subprocess.run([*prefix, *PWSH_FLAGS, "-Command", "$PSVersionTable.PSVersion.Major"],
                                  capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            continue
        if done.returncode == 0 and done.stdout.strip().isdigit():
            _RUNNER["argv"] = prefix
            return prefix
    _RUNNER["argv"] = None
    return None


def run_powershell(script, stdin=None):
    prefix = powershell_command()
    return subprocess.run([*prefix, *PWSH_FLAGS, "-Command", script], capture_output=True, text=True, timeout=600,
                          input=stdin if stdin is not None else None, stdin=None if stdin is not None else subprocess.DEVNULL)


class NeedsPowerShell(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if powershell_command() is None:
            message = ("PowerShell 7 (pwsh, or Docker with an image that has it) is NOT available, so the generated Windows scripts were NOT parsed. "
                       "Install pwsh or Docker; CI must have it.")
            print("\n*** " + message, file=sys.stderr)
            if os.environ.get("CI"):
                raise AssertionError(message)
            raise unittest.SkipTest(message)


PARSE = (
    "$data = [Console]::In.ReadToEnd() | ConvertFrom-Json; $bad = @(); "
    "foreach ($p in $data.PSObject.Properties) { $t = $null; $e = $null; "
    "[void][System.Management.Automation.Language.Parser]::ParseInput($p.Value, [ref]$t, [ref]$e); "
    "foreach ($x in $e) { $bad += ($p.Name + ': ' + $x.Message + ' (column ' + $x.Extent.StartColumnNumber + ')') } }; "
    "foreach ($b in $bad) { Write-Output ('PARSE-ERROR ' + $b) }; "
    "Write-Output ('PARSED ' + @($data.PSObject.Properties).Count)"
)


class ParserTest(NeedsPowerShell):
    def test_every_generated_script_parses_exactly_as_windows_powershell_will_receive_it(self):
        scripts = {name: decide.PS_PREAMBLE + text for name, text in decide.all_powershell_scripts().items()}
        done = run_powershell(PARSE, json.dumps(scripts))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("PARSE-ERROR", done.stdout, done.stdout)
        self.assertIn(f"PARSED {len(scripts)}", done.stdout)

    def test_the_parser_really_rejects_a_broken_script(self):
        done = run_powershell(PARSE, json.dumps({"broken": "if ($x -eq ) { Get-Partition"}))
        self.assertIn("PARSE-ERROR broken", done.stdout, "the parse test must be able to fail")

    def test_no_script_carries_a_double_quote_or_a_newline_onto_the_windows_command_line(self):
        for name, text in decide.all_powershell_scripts().items():
            with self.subTest(name=name):
                self.assertNotIn('"', text)
                self.assertNotIn("\n", text)

    def test_script_builders_refuse_values_that_could_change_the_script(self):
        for bad in ("a'; Remove-Item *; '", 'a"b', "x$(y)", "é"):
            with self.subTest(bad=bad):
                with self.assertRaises(decide.Invariant):
                    decide.ps_literal(bad)
        for bad in (-1, "5", 1.5, True, None):
            with self.subTest(bad=bad):
                with self.assertRaises(decide.Invariant):
                    decide.ps_number(bad)
        for bad in ("", "CD", "1", "C:", "C'"):
            with self.subTest(bad=bad):
                with self.assertRaises(decide.Invariant):
                    decide.ps_letter(bad)
        self.assertEqual(decide.ps_literal("a b"), "'a b'")


# ---- stand-in cmdlets ---------------------------------------------------------------
PARTS_ONE_ESP = """
function Get-Partition {
  param($DriveLetter, $DiskNumber, $PartitionNumber)
  $esp = [PSCustomObject]@{ PartitionNumber = 1; DiskNumber = 0; Size = [uint64]104857600; Offset = [uint64]1048576; GptType = '{C12A7328-F81F-11D2-BA4B-00A0C93EC93B}'; Guid = '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}' }
  $c = [PSCustomObject]@{ PartitionNumber = 3; DiskNumber = 0; Size = [uint64]500000000000; Offset = [uint64]122683392; GptType = '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'; Guid = '{11111111-2222-3333-4444-555555555555}' }
  $new = [PSCustomObject]@{ PartitionNumber = 5; DiskNumber = 0; Size = [uint64]8589934592; Offset = [uint64]499000000000; GptType = '{0fc63daf-8483-4772-8e79-3d69d8477de4}'; Guid = '{99999999-8888-7777-6666-555555555555}' }
  if ($PartitionNumber -eq 5) { return $new }
  if ($DriveLetter -eq 'Z') { return $esp }
  if ($DriveLetter) { return $c }
  return @($esp, $c)
}
"""

BASE_STUBS = r"""
$env:SystemDrive = 'C:'
function Get-PartitionSupportedSize { param($DriveLetter) [PSCustomObject]@{ SizeMin = [uint64]200000000000; SizeMax = [uint64]500000000000 } }
function Get-Disk { param($Number) [PSCustomObject]@{ Number = 0; PartitionStyle = 'GPT'; BusType = 'NVMe'; LogicalSectorSize = [uint32]512 } }
function Confirm-SecureBootUEFI { $false }
function Get-ItemProperty { param($Path) throw 'PEFirmwareType is absent on installed Windows' }
function Get-CimInstance { param($ClassName) if ($ClassName -eq 'Win32_ComputerSystem') { [PSCustomObject]@{ TotalPhysicalMemory = [uint64]17179869184 } } }
function Get-BitLockerVolume { param($MountPoint) throw 'BitLocker is not installed' }
"""


def stubs(*extra):
    return BASE_STUBS + "\n".join(extra) + "\n"


class FactsTest(NeedsPowerShell):
    def facts(self, *extra):
        done = run_powershell(stubs(PARTS_ONE_ESP, *extra) + decide.PS_PREAMBLE + decide.ps_facts_script())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        with unittest.mock.patch.object(decide, "windows_ps", return_value=done.stdout), \
                unittest.mock.patch.object(decide, "windows_firmware_type", return_value=2), \
                unittest.mock.patch.dict(decide.WINDOWS):
            return decide.windows_facts(fresh=True)

    def test_an_ordinary_machine(self):
        facts = self.facts()
        self.assertEqual((facts["Letter"], facts["DiskNumber"], facts["PartitionNumber"]), ("C", 0, 3))
        self.assertEqual((facts["Size"], facts["SizeMin"], facts["SizeMax"]), (500000000000, 200000000000, 500000000000))
        self.assertEqual((facts["Style"], facts["Firmware"], facts["SecureBoot"], facts["LogicalSectorSize"]), ("GPT", 2, False, 512))
        self.assertEqual(facts["Esps"], [{"Number": 1, "Size": 104857600}])
        self.assertEqual(facts["EspNumber"], 1)
        self.assertEqual((facts["Dynamic"], facts["Memory"], facts["OnBattery"], facts["BitLocker"]), (False, 17179869184, False, None))
        self.assertEqual(facts["BusType"], "NVMe")

    def test_findings_accept_what_powershell_really_printed(self):
        facts = self.facts()
        with unittest.mock.patch.object(decide, "windows_facts", return_value=facts), unittest.mock.patch.object(decide.shutil, "which", return_value="bcdedit"):
            found = {item["name"]: item["status"] for item in decide.windows_findings(6 * 1024 ** 3, "\\\\.\\PHYSICALDRIVE0")}
        self.assertEqual(set(found.values()), {"ok"}, found)

    def test_two_efi_partitions_are_both_listed(self):
        facts = self.facts("""
        $real = ${function:Get-Partition}
        function Get-Partition { param($DriveLetter, $DiskNumber, $PartitionNumber)
          $rows = & $real -DriveLetter $DriveLetter -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber
          if (-not $DriveLetter) { $rows + [PSCustomObject]@{ PartitionNumber = 7; DiskNumber = 0; Size = [uint64]52428800; GptType = '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' } } else { $rows } }
        """)
        self.assertEqual([item["Number"] for item in facts["Esps"]], [1, 7])

    def test_a_dynamic_disk_secure_boot_on_battery_and_bitlocker_are_reported(self):
        facts = self.facts("""
        $real = ${function:Get-Partition}
        function Get-Partition { param($DriveLetter, $DiskNumber, $PartitionNumber)
          $rows = & $real -DriveLetter $DriveLetter -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber
          if (-not $DriveLetter) { $rows + [PSCustomObject]@{ PartitionNumber = 9; DiskNumber = 0; Size = [uint64]1048576; GptType = '{5808c8aa-7e8f-42e0-85d2-e1e90434cfb3}' } } else { $rows } }
        function Confirm-SecureBootUEFI { $true }
        function Get-BitLockerVolume { param($MountPoint) [PSCustomObject]@{ ProtectionStatus = 'On' } }
        function Get-CimInstance { param($ClassName)
          if ($ClassName -eq 'Win32_ComputerSystem') { [PSCustomObject]@{ TotalPhysicalMemory = [uint64]4294967296 } }
          if ($ClassName -eq 'Win32_Battery') { [PSCustomObject]@{ BatteryStatus = 1 } } }
        """)
        self.assertEqual((facts["Dynamic"], facts["SecureBoot"], facts["OnBattery"], facts["BitLocker"], facts["Memory"]), (True, True, True, "On", 4294967296))

    def test_no_efi_partition_and_unreadable_secure_boot_do_not_stop_the_query(self):
        facts = self.facts("""
        function Get-Partition { param($DriveLetter, $DiskNumber)
          if ($DriveLetter) { [PSCustomObject]@{ PartitionNumber = 3; DiskNumber = 0; Size = [uint64]500000000000; GptType = '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' } }
          else { @([PSCustomObject]@{ PartitionNumber = 3; DiskNumber = 0; Size = [uint64]500000000000; GptType = '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' }) } }
        function Confirm-SecureBootUEFI { throw 'Cmdlet not supported on this platform' }
        """)
        self.assertEqual(facts["Esps"], [])
        self.assertIsNone(facts["EspNumber"])
        self.assertIsNone(facts["SecureBoot"])

    def test_a_cim_query_that_fails_leaves_the_rest_intact(self):
        facts = self.facts("function Get-CimInstance { param($ClassName) throw 'WMI is unavailable' }")
        self.assertIsNone(facts["Memory"])
        self.assertFalse(facts["OnBattery"])
        self.assertEqual(facts["DiskNumber"], 0)


RECORD = """
$script:calls = @()
function Update-Disk { param($Number) $script:calls += ('Update-Disk ' + $Number) }
function New-Partition { param($DiskNumber, $Size, $GptType, $Offset) $script:calls += ('New-Partition ' + $DiskNumber + ' ' + $Size + ' ' + $GptType + ' ' + $Offset); [PSCustomObject]@{ PartitionNumber = 5 } }
function Resize-Partition { param($DriveLetter, $Size) Write-Output ('RESIZE ' + $DriveLetter + ' ' + $Size) }
function Remove-Partition { [CmdletBinding(SupportsShouldProcess)] param($DiskNumber, $PartitionNumber) Write-Output ('REMOVE ' + $DiskNumber + ' ' + $PartitionNumber) }
"""


class ActionTest(NeedsPowerShell):
    def run_script(self, script, *extra, expect=0):
        done = run_powershell(stubs(PARTS_ONE_ESP, RECORD, *extra) + decide.PS_PREAMBLE + script)
        self.assertEqual(done.returncode, expect, done.stdout + done.stderr)
        return done.stdout.strip()

    def test_shrink_passes_the_drive_and_the_size(self):
        self.assertEqual(self.run_script(decide.ps_shrink_script("c", 123456789)), "RESIZE C 123456789")

    def test_new_partition_prints_where_it_landed(self):
        out = self.run_script(decide.ps_new_partition_script(0, 8589934592))
        self.assertEqual(json.loads(out), {"Number": 5, "Offset": 499000000000, "Size": 8589934592, "Guid": "{99999999-8888-7777-6666-555555555555}"})

    def test_new_partition_still_works_when_update_disk_fails(self):
        out = self.run_script(decide.ps_new_partition_script(0, 8589934592), "function Update-Disk { param($Number) throw 'busy' }")
        self.assertEqual(json.loads(out)["Number"], 5)

    def test_new_partition_uses_the_reserved_offset(self):
        require_offset = "function New-Partition { param($DiskNumber, $Size, $GptType, $Offset) if ($Offset -ne 499000000000) { throw 'wrong offset' }; [PSCustomObject]@{ PartitionNumber = 5 } }"
        out = self.run_script(decide.ps_new_partition_script(0, 8589934592, 499000000000), require_offset)
        self.assertEqual(json.loads(out)["Offset"], 499000000000)

    def test_remove_partition_accepts_confirm_false(self):
        self.assertEqual(self.run_script(decide.ps_remove_partition_script(0, 5)), "REMOVE 0 5")

    def test_restore_grows_a_shrunk_volume_back_to_exactly_its_original_size(self):
        shrunk = ("$script:size = [uint64]490000000000; "
                  "function Get-Partition { param($DriveLetter) [PSCustomObject]@{ Size = $script:size } }; "
                  "function Resize-Partition { param($DriveLetter, $Size) $script:size = $Size; Write-Output ('RESIZE ' + $DriveLetter + ' ' + $Size) }")
        self.assertEqual(self.run_script(decide.ps_restore_script("C", 500000000000), shrunk), "RESIZE C 500000000000")

    def test_restore_refuses_to_report_partial_restoration_as_success(self):
        shrunk = "function Get-Partition { param($DriveLetter) [PSCustomObject]@{ Size = [uint64]490000000000 } }"
        done = run_powershell(stubs(PARTS_ONE_ESP, RECORD, shrunk) + decide.PS_PREAMBLE + decide.ps_restore_script("C", 600000000000))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("original system partition size cannot be restored", done.stdout + done.stderr)
        self.assertNotIn("RESIZE", done.stdout)

    def test_restore_checks_the_size_after_windows_reports_resize_success(self):
        shrunk = "function Get-Partition { param($DriveLetter) [PSCustomObject]@{ Size = [uint64]490000000000 } }"
        done = run_powershell(stubs(PARTS_ONE_ESP, RECORD, shrunk) + decide.PS_PREAMBLE + decide.ps_restore_script("C", 500000000000))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("did not return to its original size", done.stdout + done.stderr)

    def test_restore_does_nothing_when_the_volume_was_never_shrunk(self):
        self.assertEqual(self.run_script(decide.ps_restore_script("C", 500000000000)), "")

    def test_mounting_picks_the_first_free_letter_and_reports_root_and_letter(self):
        taken = "function Test-Path { param($Path) $Path -in @('Z:\\', 'Y:\\') }\nfunction mountvol { $global:LASTEXITCODE = 0 }"
        out = json.loads(self.run_script(decide.ps_mount_esp_script(), taken))
        self.assertEqual(out, {"Root": "X:\\", "Letter": "X"})

    def test_mounting_fails_loudly_when_mountvol_does(self):
        done = run_powershell(stubs(PARTS_ONE_ESP, "function Test-Path { $false }\nfunction mountvol { $global:LASTEXITCODE = 1 }") + decide.PS_PREAMBLE + decide.ps_mount_esp_script())
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("mountvol could not mount", done.stdout + done.stderr)

    def test_mounting_fails_when_every_letter_is_taken(self):
        done = run_powershell(stubs(PARTS_ONE_ESP, "function Test-Path { $true }\nfunction mountvol { $global:LASTEXITCODE = 0 }") + decide.PS_PREAMBLE + decide.ps_mount_esp_script())
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("no free drive letter", done.stdout + done.stderr)

    def test_unmounting_passes_the_letter_and_checks_the_exit_code(self):
        seen = self.run_script(decide.ps_unmount_script("z"), "function mountvol { Write-Host ('MOUNTVOL ' + ($args -join ' ')); $global:LASTEXITCODE = 0 }")
        self.assertEqual(seen, "MOUNTVOL Z: /D")
        done = run_powershell(stubs(PARTS_ONE_ESP, "function mountvol { $global:LASTEXITCODE = 1 }") + decide.PS_PREAMBLE + decide.ps_unmount_script("Z"))
        self.assertNotEqual(done.returncode, 0)

    def test_the_mounted_partition_is_described_by_guid_start_size_and_sector(self):
        out = json.loads(self.run_script(decide.ps_partition_by_letter_script("z")))
        self.assertEqual(out, {"DiskNumber": 0, "Number": 1, "Offset": 1048576, "Size": 104857600, "Guid": "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
                               "GptType": "{C12A7328-F81F-11D2-BA4B-00A0C93EC93B}", "LogicalSectorSize": 512})
        facts_part = decide.loader_load_option(out, out["LogicalSectorSize"])
        self.assertTrue(facts_part.startswith(b"\x01\x00\x00\x00"))

    def test_the_memory_query_prints_a_bare_number(self):
        self.assertEqual(self.run_script(decide.ps_memory_script()), "17179869184")


DISK_STUBS = r"""
function Get-CimInstance { param($ClassName)
  if ($ClassName -eq 'Win32_DiskDrive') {
    [PSCustomObject]@{ DeviceID = '\\.\PHYSICALDRIVE0'; Model = 'Samsung SSD 980'; Size = [uint64]2000398934016; InterfaceType = 'SCSI'; MediaType = 'Fixed hard disk media'; PNPDeviceID = 'SCSI\DISK&VEN_NVME'; SerialNumber = 'S1' }
    [PSCustomObject]@{ DeviceID = '\\.\PHYSICALDRIVE1'; Model = 'Flash'; Size = [uint64]8000000000; InterfaceType = 'USB'; MediaType = 'Removable Media'; PNPDeviceID = 'USBSTOR\DISK'; SerialNumber = 'U1' }
  } }
function Get-CimAssociatedInstance { param([Parameter(ValueFromPipeline = $true)]$InputObject, $ResultClassName)
  process {
    if ($ResultClassName -eq 'Win32_DiskPartition') { [PSCustomObject]@{ Disk = $InputObject.DeviceID } }
    if ($ResultClassName -eq 'Win32_LogicalDisk') { if ($InputObject.Disk -like '*DRIVE0') { [PSCustomObject]@{ DeviceID = 'C:' } } }
  } }
"""


class DisksTest(NeedsPowerShell):
    def test_the_disk_listing_feeds_the_planner(self):
        done = run_powershell(DISK_STUBS + decide.ps_disks_script())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        disks = decide.parse_windows(done.stdout)
        self.assertEqual([d["path"] for d in disks], ["\\\\.\\PHYSICALDRIVE0", "\\\\.\\PHYSICALDRIVE1"])
        internal, stick = disks
        self.assertTrue(internal["internal"] and internal["mounted"])
        self.assertTrue(stick["usb"] and not stick["mounted"])

    def test_one_disk_is_still_a_list_the_parser_understands(self):
        one = DISK_STUBS.replace("[PSCustomObject]@{ DeviceID = '\\\\.\\PHYSICALDRIVE1'", "$null = @{ DeviceID = '\\\\.\\PHYSICALDRIVE1'")
        done = run_powershell(one + decide.ps_disks_script())
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(len(decide.parse_windows(done.stdout)), 1)



WITH_LINUX = """
$real = ${function:Get-Partition}
function Get-Partition { param($DriveLetter, $DiskNumber, $PartitionNumber)
  $rows = & $real -DriveLetter $DriveLetter -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber
  if (-not $DriveLetter -and -not $PartitionNumber) { @($rows) + [PSCustomObject]@{ PartitionNumber = 5; DiskNumber = 0; Size = [uint64]8589934592; Offset = [uint64]499000000000; GptType = '{0fc63daf-8483-4772-8e79-3d69d8477de4}'; Guid = '{99999999-8888-7777-6666-555555555555}' } } else { $rows } }
"""


class LeftoverScriptsTest(NeedsPowerShell):
    """The scripts that find and take back what an unfinished conversion left, run against stand-ins."""

    def run_script(self, script, *extra):
        done = run_powershell(stubs(PARTS_ONE_ESP, *extra) + decide.PS_PREAMBLE + script)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return decide.json_from_output(done.stdout)

    def test_one_linux_partition_is_still_a_list(self):
        listed = self.run_script(decide.ps_linux_partitions_script(0), WITH_LINUX)
        self.assertEqual(listed["Parts"], [{"Number": 5, "Offset": 499000000000, "Size": 8589934592, "Guid": "{99999999-8888-7777-6666-555555555555}"}])

    def test_no_linux_partition_is_an_empty_list(self):
        self.assertEqual(self.run_script(decide.ps_linux_partitions_script(0))["Parts"], [])

    def test_staging_snapshot_carries_the_system_partition_end_and_existing_guids(self):
        layout = self.run_script(decide.ps_linux_partitions_script(0, "C"), WITH_LINUX)
        self.assertEqual(layout["Offset"], 500122683392)
        self.assertEqual(layout["Parts"][0]["Guid"], "{99999999-8888-7777-6666-555555555555}")

    def test_facts_list_linux_partitions_for_leftover_detection(self):
        facts = decide.parse_windows_facts(run_powershell(stubs(PARTS_ONE_ESP, WITH_LINUX) + decide.PS_PREAMBLE + decide.ps_facts_script()).stdout)
        self.assertEqual(facts["LinuxParts"], [{"Number": 5, "Size": 8589934592}])
        plain = decide.parse_windows_facts(run_powershell(stubs(PARTS_ONE_ESP) + decide.PS_PREAMBLE + decide.ps_facts_script()).stdout)
        self.assertEqual(plain["LinuxParts"], [])

    def test_an_efi_partition_left_mounted_is_reused_not_mounted_twice(self):
        mounted = """
        $real = ${function:Get-Partition}
        function Get-Partition { param($DriveLetter, $DiskNumber, $PartitionNumber)
          $rows = & $real -DriveLetter $DriveLetter -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber
          foreach ($r in @($rows)) { if ($r.PartitionNumber -eq 1) { $r | Add-Member -NotePropertyName DriveLetter -NotePropertyValue ([char]'S') -Force } }
          $rows }
        function mountvol { throw 'mountvol must not run when the partition is already mounted' }
        """
        self.assertEqual(self.run_script(decide.ps_mount_esp_script(), mounted), {"Root": "S:\\", "Letter": "S", "Reused": True})

    def test_an_unmounted_efi_partition_is_mounted_on_a_free_letter(self):
        fresh = """
        function Test-Path { param($Path) $Path -eq 'Z:\\' }
        function mountvol { $global:LASTEXITCODE = 0 }
        """
        self.assertEqual(self.run_script(decide.ps_mount_esp_script(), fresh), {"Root": "Y:\\", "Letter": "Y"})

if __name__ == "__main__":
    unittest.main()
