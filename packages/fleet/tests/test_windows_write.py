#!/usr/bin/env python3
"""Writing the installer into the new partition: byte offsets past 4 GiB and 2 TiB, sector
alignment, and the retry through the partition's own device when the whole-disk handle is refused."""

import errno
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402

GIB = 1024 ** 3
TIB = 1024 ** 4
BLOCK = 4096


class FakeDevices:
    """Raw disks as Windows hands them out: every read and write must start on a sector and
    cover whole sectors (a misaligned request is ERROR_INVALID_PARAMETER there). Sparse, so a
    multi-terabyte offset costs nothing. Patches os.open/lseek/read/write/fsync/close for the
    fake paths only; every other path is passed through."""

    def __init__(self, refuse_open=(), refuse_write=(), lie_about_seek=()):
        self.blocks, self.writes, self.opened, self.seeks = {}, [], [], []
        self.refuse_open, self.refuse_write, self.lie_about_seek = set(refuse_open), set(refuse_write), set(lie_about_seek)
        self.fds, self.next_fd = {}, 9000
        self.paths = set()

    def add(self, path):
        self.paths.add(path)
        self.blocks.setdefault(path, {})

    def patch(self):
        real = {name: getattr(os, name) for name in ("open", "lseek", "read", "write", "fsync", "close")}
        outer = self

        def fake_open(path, flags, *a, **k):
            if path not in outer.paths:
                return real["open"](path, flags, *a, **k)
            outer.opened.append((path, flags & (os.O_RDWR | os.O_RDONLY | os.O_WRONLY)))
            if path in outer.refuse_open:
                raise PermissionError(errno.EACCES, "Access is denied", path)
            outer.next_fd += 1
            outer.fds[outer.next_fd] = {"path": path, "pos": 0}
            return outer.next_fd

        def fake_lseek(fd, offset, whence):
            if fd not in outer.fds:
                return real["lseek"](fd, offset, whence)
            assert whence == os.SEEK_SET
            outer.seeks.append((outer.fds[fd]["path"], offset))
            outer.fds[fd]["pos"] = offset
            return offset + 1 if outer.fds[fd]["path"] in outer.lie_about_seek else offset

        def fake_write(fd, data):
            if fd not in outer.fds:
                return real["write"](fd, data)
            state = outer.fds[fd]
            if state["path"] in outer.refuse_write:
                raise PermissionError(errno.EACCES, "Access is denied", state["path"])
            if state["pos"] % BLOCK or len(data) % BLOCK:
                raise OSError(errno.EINVAL, "the parameter is incorrect: unaligned raw write", state["pos"], len(data))
            outer.writes.append((state["path"], state["pos"], len(data)))
            for index in range(0, len(data), BLOCK):
                outer.blocks[state["path"]][(state["pos"] + index) // BLOCK] = bytes(data[index:index + BLOCK])
            state["pos"] += len(data)
            return len(data)

        def fake_read(fd, count):
            if fd not in outer.fds:
                return real["read"](fd, count)
            state = outer.fds[fd]
            if state["pos"] % BLOCK or count % BLOCK:
                raise OSError(errno.EINVAL, "the parameter is incorrect: unaligned raw read")
            data = b"".join(outer.blocks[state["path"]].get((state["pos"] + i) // BLOCK, bytes(BLOCK)) for i in range(0, count, BLOCK))
            state["pos"] += count
            return data

        def passthrough(name):
            def call(fd, *args):
                if fd not in outer.fds:
                    return real[name](fd, *args)
                if name == "close":
                    del outer.fds[fd]
                return None
            return call

        return [mock.patch.object(os, "open", fake_open), mock.patch.object(os, "lseek", fake_lseek), mock.patch.object(os, "write", fake_write),
                mock.patch.object(os, "read", fake_read), mock.patch.object(os, "fsync", passthrough("fsync")), mock.patch.object(os, "close", passthrough("close"))]

    def __enter__(self):
        self.patches = self.patch()
        for patch in self.patches:
            patch.start()
        return self

    def __exit__(self, *exc):
        for patch in reversed(self.patches):
            patch.stop()

    def image_at(self, path, offset, size):
        out = b"".join(self.blocks[path].get((offset + i) // BLOCK, bytes(BLOCK)) for i in range(0, decide.padded_size(size), BLOCK))
        return out[:size]


class WriteRegionOffsetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.iso = Path(self.tmp.name) / "image.iso"
        # Not a multiple of the sector size, and bigger than one write chunk.
        self.image = bytes(range(251)) * 20000 + b"the end"
        self.iso.write_bytes(self.image)
        self.assertGreater(len(self.image), decide.WRITE_CHUNK // 2)

    def test_offsets_past_4_gib_and_2_tib_land_exactly_where_asked(self):
        for offset in (4 * GIB - BLOCK, 4 * GIB, 5 * GIB + 3 * BLOCK, 2 * TIB - BLOCK, 2 * TIB, 3 * TIB + 17 * BLOCK):
            with self.subTest(offset=offset):
                disk = FakeDevices()
                disk.add("D")
                with disk:
                    decide.write_region(self.iso, "D", offset)
                self.assertEqual(disk.image_at("D", offset, len(self.image)), self.image)
                self.assertEqual(disk.blocks["D"].get(offset // BLOCK - 1), None, "nothing may be written before the offset")
                end = offset + decide.padded_size(len(self.image))
                self.assertEqual(disk.blocks["D"].get(end // BLOCK), None, "nothing may be written past the padded image")
                self.assertIn(("D", offset), disk.seeks)
                self.assertEqual(sum(count for _, _, count in disk.writes), decide.padded_size(len(self.image)))

    def test_every_write_starts_on_a_sector_and_covers_whole_sectors(self):
        disk = FakeDevices()
        disk.add("D")
        with disk:
            decide.write_region(self.iso, "D", 2 * TIB + BLOCK, zero_head=2048)
        self.assertTrue(disk.writes)
        for _, position, count in disk.writes:
            self.assertEqual((position % BLOCK, count % BLOCK), (0, 0))

    def test_the_hybrid_boot_sector_is_zeroed_at_a_huge_offset_too(self):
        disk = FakeDevices()
        disk.add("D")
        offset = 3 * TIB
        with disk:
            decide.write_region(self.iso, "D", offset, zero_head=decide.ISO_SYSTEM_AREA)
        got = disk.image_at("D", offset, len(self.image))
        self.assertEqual(got[:decide.ISO_SYSTEM_AREA], bytes(decide.ISO_SYSTEM_AREA))
        self.assertEqual(got[decide.ISO_SYSTEM_AREA:], self.image[decide.ISO_SYSTEM_AREA:])

    def test_a_device_that_seeks_somewhere_else_is_caught_before_a_byte_is_written(self):
        disk = FakeDevices(lie_about_seek=("D",))
        disk.add("D")
        with disk, self.assertRaises(decide.Invariant) as caught:
            decide.write_region(self.iso, "D", 5 * GIB)
        self.assertIn("seek", caught.exception.what)
        self.assertEqual(disk.writes, [])

    def test_a_misaligned_offset_is_refused_before_the_device_is_opened(self):
        disk = FakeDevices()
        disk.add("D")
        with disk:
            for bad in (1, 512, 4097, 5 * GIB + 512):
                with self.assertRaises(decide.Invariant):
                    decide.write_region(self.iso, "D", bad)
        self.assertEqual(disk.opened, [])

    def test_a_sparse_file_takes_the_same_path_when_the_filesystem_allows_it(self):
        for offset in (5 * GIB, 3 * TIB):
            with self.subTest(offset=offset):
                target = Path(self.tmp.name) / f"sparse-{offset}.img"
                try:
                    with open(target, "wb") as handle:
                        handle.truncate(offset + 4 * decide.MIB)
                    if os.stat(target).st_blocks * 512 > decide.MIB:
                        self.skipTest("this filesystem does not make sparse files; the fake-device test above covers the offsets")
                except OSError as exc:
                    self.skipTest(f"this filesystem cannot make a {offset}-byte file ({exc}); the fake-device test above covers the offsets")
                decide.write_region(self.iso, target, offset)
                with open(target, "rb") as handle:
                    handle.seek(offset)
                    self.assertEqual(handle.read(len(self.image)), self.image)
                    handle.seek(offset - BLOCK)
                    self.assertEqual(handle.read(BLOCK), bytes(BLOCK))
                target.unlink()


class FallbackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.iso = Path(self.tmp.name) / "image.iso"
        self.image = os.urandom(300000)
        self.iso.write_bytes(self.image)
        self.say = mock.patch.object(decide, "say")
        self.said = self.say.start()
        self.addCleanup(self.say.stop)

    def test_a_refused_disk_handle_is_retried_once_through_the_partition_at_offset_zero(self):
        for refusal in ({"refuse_open": ("DISK",)}, {"refuse_write": ("DISK",)}):
            with self.subTest(refusal=refusal):
                disks = FakeDevices(**refusal)
                disks.add("DISK")
                disks.add("PART")
                with disks:
                    size = decide.write_region(self.iso, "DISK", 6 * GIB, decide.ISO_SYSTEM_AREA, None, ("PART", 0))
                self.assertEqual(size, len(self.image))
                got = disks.image_at("PART", 0, len(self.image))
                self.assertEqual(got[decide.ISO_SYSTEM_AREA:], self.image[decide.ISO_SYSTEM_AREA:])
                self.assertEqual(got[:decide.ISO_SYSTEM_AREA], bytes(decide.ISO_SYSTEM_AREA))
                self.assertTrue(any("PART" in str(call) for call in self.said.call_args_list), "the person is told which device is used instead")

    def test_when_both_refuse_the_error_names_each_device_and_what_to_do(self):
        disks = FakeDevices(refuse_open=("DISK", "PART"))
        disks.add("DISK")
        disks.add("PART")
        with disks, self.assertRaises(decide.Invariant) as caught:
            decide.write_region(self.iso, "DISK", 6 * GIB, 0, None, ("PART", 0))
        error = caught.exception
        self.assertIn("would not let this program write", error.what)
        self.assertIn("DISK", error.context["devices"])
        self.assertIn("PART", error.context["devices"])
        self.assertIn("Access is denied", error.context["devices"])
        self.assertIn("administrator", error.fix)
        self.assertIn("antivirus", error.fix)

    def test_without_a_fallback_a_refusal_is_one_attempt_and_the_same_clear_error(self):
        disks = FakeDevices(refuse_write=("DISK",))
        disks.add("DISK")
        with disks, self.assertRaises(decide.Invariant) as caught:
            decide.write_region(self.iso, "DISK", 4096)
        self.assertIn("DISK", caught.exception.context["devices"])
        self.assertEqual(len([o for o in disks.opened if o[0] == "DISK"]), 1)

    def test_a_wrong_read_back_is_not_retried_it_is_a_failing_disk(self):
        disks = FakeDevices()
        disks.add("DISK")
        disks.add("PART")
        with disks:
            original = os.read  # the fake device's read

            def flipped(fd, count):
                data = original(fd, count)
                return bytes([data[0] ^ 1]) + data[1:]

            with mock.patch.object(os, "read", flipped), self.assertRaises(decide.Invariant) as caught:
                decide.write_region(self.iso, "DISK", 4096, 0, None, ("PART", 0))
        self.assertIn("does not hold the installer", caught.exception.what)
        self.assertNotIn(("PART", 0), disks.seeks, "the fallback must not run after a verified mismatch")

    def test_the_partition_device_name_and_its_test_redirect(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FLEET_WINDOWS_TARGET", None)
            self.assertEqual(decide.windows_partition_target(2, 5), "\\\\?\\GLOBALROOT\\Device\\Harddisk2\\Partition5")
            os.environ["FLEET_WINDOWS_TARGET"] = "/tmp/anything"
            self.assertIsNone(decide.windows_partition_target(2, 5), "a test redirect has no partition device")
        with self.assertRaises(decide.Invariant):
            decide.windows_partition_target(-1, 5)
        with self.assertRaises(decide.Invariant):
            decide.windows_partition_target("0; calc", 5)


if __name__ == "__main__":
    unittest.main()
