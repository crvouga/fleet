#!/usr/bin/env python3
"""The second one-time boot mechanism: UEFI variables written directly. The load option
is checked byte for byte against a value worked out by hand from the UEFI specification;
the kernel32 calls run against stand-in DLLs, so nothing here can reach real firmware."""

import ctypes
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402

GUID = "{11223344-5566-7788-99aa-bbccddeeff00}"
# Worked out by hand: partition 1, starts at LBA 2048 (1 MiB of 512-byte sectors), 204800 sectors (100 MiB).
HARD_DRIVE_NODE = (
    bytes.fromhex("04 01")                      # media device path, hard drive
    + bytes.fromhex("2a 00")                    # the node is 42 bytes
    + bytes.fromhex("01 00 00 00")              # PartitionNumber = 1
    + bytes.fromhex("00 08 00 00 00 00 00 00")  # PartitionStart  = 0x800 = 2048
    + bytes.fromhex("00 20 03 00 00 00 00 00")  # PartitionSize   = 0x32000 = 204800
    # {11223344-5566-7788-99aa-bbccddeeff00}: first three groups little-endian, the rest as written
    + bytes.fromhex("44 33 22 11  66 55  88 77  99 aa bb cc dd ee ff 00")
    + bytes.fromhex("02")                       # MBRType = GPT
    + bytes.fromhex("02")                       # SignatureType = GUID
)
FILE_NODE = (
    bytes.fromhex("04 04")                      # media device path, file path
    + bytes.fromhex("32 00")                    # 4 + 46 bytes of path
    # \EFI\fleet\grubx64.efi as UTF-16LE, then the 16-bit zero
    + bytes.fromhex("5c00 4500 4600 4900 5c00 6600 6c00 6500 6500 7400 5c00 6700 7200 7500 6200 7800 3600 3400 2e00 6500 6600 6900 0000")
)
END_NODE = bytes.fromhex("7f ff 04 00")
LOAD_OPTION = (
    bytes.fromhex("01 00 00 00")                # Attributes = LOAD_OPTION_ACTIVE
    + bytes.fromhex("60 00")                    # FilePathListLength = 42 + 50 + 4 = 96
    # "Fleet installer" as UTF-16LE, then the 16-bit zero
    + bytes.fromhex("4600 6c00 6500 6500 7400 2000 6900 6e00 7300 7400 6100 6c00 6c00 6500 7200 0000")
    + HARD_DRIVE_NODE + FILE_NODE + END_NODE
)
PART = {"Number": 1, "Offset": 1048576, "Size": 104857600, "Guid": GUID}


class LoadOptionBytesTest(unittest.TestCase):
    def test_the_hard_drive_node(self):
        self.assertEqual(len(HARD_DRIVE_NODE), 42)
        self.assertEqual(decide.efi_hard_drive_node(1, 2048, 204800, GUID), HARD_DRIVE_NODE)

    def test_the_file_node(self):
        self.assertEqual(len(FILE_NODE), 50)
        self.assertEqual(decide.efi_file_node("\\EFI\\fleet\\grubx64.efi"), FILE_NODE)

    def test_the_whole_load_option(self):
        self.assertEqual(len(LOAD_OPTION), 134)
        self.assertEqual(decide.loader_load_option(PART, 512), LOAD_OPTION)

    def test_guid_text_in_either_case_with_or_without_braces_is_the_same_bytes(self):
        for text in (GUID, GUID.upper(), GUID.strip("{}")):
            self.assertEqual(decide.efi_guid_bytes(text), bytes.fromhex("44332211 6655 8877 99aabbccddeeff00"))

    def test_a_4096_byte_sector_disk_counts_in_its_own_sectors(self):
        option = decide.loader_load_option({"Number": 1, "Offset": 1048576, "Size": 104857600, "Guid": GUID}, 4096)
        start, size = struct.unpack_from("<QQ", option, 6 + 32 + 8)
        self.assertEqual((start, size), (256, 25600))

    def test_a_partition_that_does_not_line_up_with_the_sectors_is_refused(self):
        for bad in ({**PART, "Offset": 1048577}, {**PART, "Size": 104857601}, {**PART, "Offset": 0}):
            with self.assertRaises(decide.Invariant):
                decide.loader_load_option(bad, 512)
        with self.assertRaises(decide.Invariant):
            decide.loader_load_option(PART, 1024)

    def test_variable_names_are_four_uppercase_hex_digits(self):
        self.assertEqual(decide.boot_variable_name(0), "Boot0000")
        self.assertEqual(decide.boot_variable_name(0x1A2B), "Boot1A2B")
        with self.assertRaises(decide.Invariant):
            decide.boot_variable_name(0x10000)

    def test_boot_order_is_a_list_of_16_bit_numbers(self):
        self.assertEqual(decide.parse_boot_order(bytes.fromhex("0300 0100 0000")), [3, 1, 0])
        self.assertEqual(decide.parse_boot_order(b""), [])


class FakeFn:
    def __init__(self, impl):
        self.impl, self.argtypes, self.restype = impl, None, None

    def __call__(self, *args):
        return self.impl(*args)


class FakeKernel:
    """kernel32 with a dict for firmware. fail is the Windows error every call returns, when set."""

    def __init__(self):
        self.store, self.error, self.closed, self.calls = {}, 0, [], []
        self.GetFirmwareEnvironmentVariableExW = FakeFn(self.get)
        self.SetFirmwareEnvironmentVariableExW = FakeFn(self.set)
        self.GetCurrentProcess = FakeFn(lambda: -1)
        self.CloseHandle = FakeFn(lambda handle: self.closed.append(getattr(handle, "value", handle)) or True)

    def get(self, name, guid, buffer, size, attributes):
        self.calls.append(("get", name, guid))
        if name not in self.store:
            self.error = decide.ERROR_ENVVAR_NOT_FOUND
            return 0
        data, attrs = self.store[name]
        ctypes.memmove(buffer, data, len(data))
        attributes._obj.value = attrs
        return len(data)

    def set(self, name, guid, buffer, size, attributes):
        self.calls.append(("set", name, guid, size, attributes))
        if size == 0:
            if name not in self.store:
                self.error = decide.ERROR_ENVVAR_NOT_FOUND
                return False
            del self.store[name]
            return True
        self.store[name] = (bytes(buffer.raw[:size]), attributes)
        return True


class FakeAdvapi:
    def __init__(self, kernel, assigned=True):
        self.kernel, self.assigned, self.seen = kernel, assigned, {}
        self.OpenProcessToken = FakeFn(self.open_token)
        self.LookupPrivilegeValueW = FakeFn(self.lookup)
        self.AdjustTokenPrivileges = FakeFn(self.adjust)

    def open_token(self, process, access, token):
        self.seen["access"] = access
        token._obj.value = 4242
        return True

    def lookup(self, system, name, luid):
        self.seen["privilege"] = name
        luid._obj.LowPart = 20
        return True

    def adjust(self, token, disable_all, request, length, previous, needed):
        self.seen["token"] = getattr(token, "value", token)
        entry = request._obj.Privileges[0]
        self.seen["attributes"], self.seen["count"], self.seen["luid"] = entry.Attributes, request._obj.PrivilegeCount, entry.Luid.LowPart
        self.kernel.error = 0 if self.assigned else decide.ERROR_NOT_ALL_ASSIGNED
        return True


def windows_firmware(assigned=True):
    kernel = FakeKernel()
    advapi = FakeAdvapi(kernel, assigned)
    firmware = decide.WindowsFirmware(kernel, advapi)
    firmware.last_error = lambda: kernel.error
    firmware.clear_error = lambda: setattr(kernel, "error", 0)
    return firmware, kernel, advapi


class KernelCallsTest(unittest.TestCase):
    def test_the_privilege_is_enabled_the_way_windows_wants_it(self):
        firmware, kernel, advapi = windows_firmware()
        firmware.enable_privilege()
        self.assertEqual(advapi.seen["privilege"], "SeSystemEnvironmentPrivilege")
        self.assertEqual(advapi.seen["access"], 0x28)  # TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY
        self.assertEqual((advapi.seen["count"], advapi.seen["attributes"], advapi.seen["luid"], advapi.seen["token"]), (1, 2, 20, 4242))
        self.assertEqual(kernel.closed, [4242], "the token handle must be closed")

    def test_a_privilege_the_token_does_not_hold_is_an_error_even_though_the_call_succeeded(self):
        firmware, kernel, _ = windows_firmware(assigned=False)
        with self.assertRaises(OSError) as caught:
            firmware.enable_privilege()
        self.assertEqual(caught.exception.errno, 1300)
        self.assertEqual(kernel.closed, [4242])

    def test_write_read_and_delete_use_the_global_variable_guid_and_nv_bs_rt(self):
        firmware, kernel, _ = windows_firmware()
        firmware.write("BootNext", b"\x05\x00")
        self.assertEqual(kernel.store["BootNext"], (b"\x05\x00", 7))
        self.assertEqual(kernel.calls[0][2], "{8BE4DF61-93CA-11D2-AA0D-00E098032B8C}")
        self.assertEqual(firmware.read("BootNext"), (b"\x05\x00", 7))
        firmware.delete("BootNext")
        self.assertIsNone(firmware.read("BootNext"))

    def test_a_missing_variable_reads_as_none_and_deleting_it_is_not_an_error(self):
        firmware, _, _ = windows_firmware()
        self.assertIsNone(firmware.read("Boot0042"))
        firmware.delete("Boot0042")

    def test_a_real_failure_is_raised_with_the_windows_error_number(self):
        firmware, kernel, _ = windows_firmware()
        kernel.GetFirmwareEnvironmentVariableExW = FakeFn(lambda *a: (setattr(kernel, "error", 1314), 0)[1])
        with self.assertRaises(OSError) as caught:
            firmware.read("BootOrder")
        self.assertEqual(caught.exception.errno, 1314)
        kernel.SetFirmwareEnvironmentVariableExW = FakeFn(lambda *a: (setattr(kernel, "error", 998), False)[1])
        with self.assertRaises(OSError) as caught:
            firmware.write("BootNext", b"\0\0")
        self.assertEqual(caught.exception.errno, 998)

    def test_without_windows_dlls_it_cannot_even_be_built_so_it_cannot_reach_firmware(self):
        if hasattr(ctypes, "WinDLL"):
            self.skipTest("this is Windows")
        with self.assertRaises(AttributeError):
            decide.WindowsFirmware()


class FileFirmwareTest(unittest.TestCase):
    def test_it_keeps_attributes_and_values_in_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            firmware = decide.FileFirmware(tmp)
            self.assertIsNone(firmware.read("BootNext"))
            firmware.write("BootNext", b"\x01\x00")
            self.assertEqual(firmware.read("BootNext"), (b"\x01\x00", 7))
            firmware.delete("BootNext")
            firmware.delete("BootNext")
            self.assertIsNone(firmware.read("BootNext"))
            with self.assertRaises(decide.Invariant):
                decide.FileFirmware(str(Path(tmp) / "missing"))


class OpenFirmwareTest(unittest.TestCase):
    def env(self, **values):
        clean = {k: v for k, v in os.environ.items() if k not in ("FLEET_FIRMWARE_STANDIN", "FLEET_WINDOWS_TARGET")}
        clean.update(values)
        return mock.patch.dict(os.environ, clean, clear=True)

    def test_a_stand_in_directory_replaces_the_real_thing(self):
        with tempfile.TemporaryDirectory() as tmp, self.env(FLEET_FIRMWARE_STANDIN=tmp):
            self.assertIsInstance(decide.open_firmware(), decide.FileFirmware)

    def test_a_test_redirect_without_a_stand_in_means_no_firmware_at_all(self):
        with self.env(FLEET_WINDOWS_TARGET="/tmp/x"), mock.patch.object(decide.os, "name", "nt"), \
                mock.patch.object(decide, "WindowsFirmware", side_effect=AssertionError("real firmware must not be built")):
            self.assertIsNone(decide.open_firmware())

    def test_off_windows_there_is_no_firmware(self):
        with self.env(), mock.patch.object(decide.os, "name", "posix"), \
                mock.patch.object(decide, "WindowsFirmware", side_effect=AssertionError("real firmware must not be built")):
            self.assertIsNone(decide.open_firmware())

    def test_on_windows_it_builds_the_real_one_and_enables_the_privilege(self):
        built = []

        class Real:
            def __init__(self):
                built.append(self)

            def enable_privilege(self):
                self.enabled = True

        with self.env(), mock.patch.object(decide.os, "name", "nt"), mock.patch.object(decide, "WindowsFirmware", Real):
            firmware = decide.open_firmware()
        self.assertIs(firmware, built[0])
        self.assertTrue(firmware.enabled)

    def test_a_token_without_the_privilege_means_that_mechanism_is_simply_not_available(self):
        class Refused:
            def enable_privilege(self):
                raise OSError(1300, "not all assigned")

        with self.env(), mock.patch.object(decide.os, "name", "nt"), mock.patch.object(decide, "WindowsFirmware", Refused):
            self.assertIsNone(decide.open_firmware())


class FakeFirmware:
    """UEFI variables in a dict, with failures and silent losses on demand."""

    def __init__(self, variables=None, fail=(), lose=()):
        self.vars, self.fail, self.lose = dict(variables or {}), set(fail), set(lose)

    def read(self, name):
        if ("read", name) in self.fail:
            raise OSError(5, f"cannot read {name}")
        return self.vars.get(name)

    def write(self, name, data, attributes=7):
        if ("write", name) in self.fail:
            raise OSError(5, f"cannot write {name}")
        if name not in self.lose:
            self.vars[name] = (bytes(data), attributes)

    def delete(self, name):
        if ("delete", name) in self.fail:
            raise OSError(5, f"cannot delete {name}")
        self.vars.pop(name, None)


PART_FACTS = {"DiskNumber": 0, "Number": 1, "Offset": 1048576, "Size": 104857600, "Guid": GUID, "GptType": decide.ESP_GUID, "LogicalSectorSize": 512}


class NvramBootTest(unittest.TestCase):
    def start(self, **kw):
        return FakeFirmware({"BootOrder": (struct.pack("<3H", 3, 0, 1), 7), "Boot0000": (b"x", 7), "Boot0001": (b"y", 7), "Boot0003": (b"z", 7), **kw.pop("variables", {})}, **kw)

    def test_the_option_is_written_appended_to_the_boot_order_and_chosen_for_next_boot(self):
        firmware = self.start()
        undo = decide.WindowsUndo()
        number, option = decide.nvram_one_time_boot(firmware, PART_FACTS, 512, undo)
        self.assertEqual(number, 2, "the lowest number nothing uses")
        self.assertEqual(firmware.vars["Boot0002"], (LOAD_OPTION, 7))
        self.assertEqual(option, firmware.vars["Boot0002"][0])
        self.assertEqual(struct.unpack("<4H", firmware.vars["BootOrder"][0]), (3, 0, 1, 2), "appended last: never first")
        self.assertEqual(firmware.vars["BootNext"], (b"\x02\x00", 7))
        self.assertEqual(decide.verify_nvram(firmware, number, option), [])

    def test_a_number_missing_from_the_variables_but_listed_in_the_order_is_not_reused(self):
        firmware = self.start(variables={"BootOrder": (struct.pack("<2H", 2, 0), 7)})
        number, _ = decide.nvram_one_time_boot(firmware, PART_FACTS, 512, decide.WindowsUndo())
        self.assertEqual(number, 4)

    def test_undo_puts_back_exactly_what_was_there(self):
        for previous in ({}, {"BootNext": (b"\x09\x00", 7)}):
            with self.subTest(previous=previous):
                firmware = self.start(variables=previous)
                before = dict(firmware.vars)
                undo = decide.WindowsUndo()
                decide.nvram_one_time_boot(firmware, PART_FACTS, 512, undo)
                undo.run()
                self.assertEqual(firmware.vars, before)

    def test_a_machine_without_a_boot_order_still_gets_the_option_and_next_boot(self):
        firmware = FakeFirmware()
        undo = decide.WindowsUndo()
        number, option = decide.nvram_one_time_boot(firmware, PART_FACTS, 512, undo)
        self.assertEqual(number, 0)
        self.assertNotIn("BootOrder", firmware.vars)
        self.assertEqual(decide.verify_nvram(firmware, number, option), [])
        undo.run()
        self.assertEqual(firmware.vars, {})

    def test_every_write_failing_leaves_nothing_behind(self):
        for name in ("Boot0002", "BootOrder", "BootNext"):
            with self.subTest(failing=name):
                firmware = self.start(fail={("write", name)})
                before = dict(firmware.vars)
                undo = decide.WindowsUndo()
                with self.assertRaises(OSError):
                    decide.nvram_one_time_boot(firmware, PART_FACTS, 512, undo)
                firmware.fail.clear()
                undo.run()
                self.assertEqual(firmware.vars, before)

    def test_verification_catches_a_write_the_firmware_silently_dropped(self):
        for lost, words in (("Boot0002", "does not hold"), ("BootNext", "BootNext")):
            with self.subTest(lost=lost):
                firmware = self.start(lose={lost})
                number, option = decide.nvram_one_time_boot(firmware, PART_FACTS, 512, decide.WindowsUndo())
                problems = decide.verify_nvram(firmware, number, option)
                self.assertTrue(problems and words in " ".join(problems), problems)

    def test_verification_catches_a_boot_next_that_points_elsewhere(self):
        firmware = self.start()
        number, option = decide.nvram_one_time_boot(firmware, PART_FACTS, 512, decide.WindowsUndo())
        firmware.vars["BootNext"] = (b"\x07\x00", 7)
        self.assertEqual(decide.verify_nvram(firmware, number, option), ["BootNext does not point at it"])


if __name__ == "__main__":
    unittest.main()
