"""Reject unusable boot files before Windows staging can change anything."""
import sys
from pathlib import Path
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_windows_stage import StageCase  # noqa: E402
import decide  # noqa: E402
import iso_fixture  # noqa: E402


class WindowsBootValidationTests(StageCase):
    def assert_refused_without_changes(self, world, problem):
        with self.assertRaises(decide.Invariant) as caught:
            self.stage(world, firmware=None)
        self.assertIn(problem, caught.exception.context['problem'])
        self.assertTrue(world.clean())
        self.assertEqual(world.ops, [], 'no partition, boot or restart operation may start')
        self.assertIsNone(world.restart)
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_empty_kernel_and_initrd_are_refused_before_staging(self):
        for field, path in (('kernel', iso_fixture.KERNEL_PATH), ('initrd', iso_fixture.INITRD_PATH)):
            with self.subTest(field=field):
                world = self.world()
                self.iso.write_bytes(iso_fixture.build(iso_fixture.installer_tree(**{field: b''})))
                self.assert_refused_without_changes(world, 'unusable ' + path)

    def test_out_of_bounds_kernel_and_initrd_are_refused_before_staging(self):
        index = decide._iso_index
        for path in (iso_fixture.KERNEL_PATH, iso_fixture.INITRD_PATH):
            with self.subTest(path=path):
                world = self.world()

                def outside_image(handle):
                    files = index(handle)
                    key = decide._iso_key(files, path)
                    files[key] = (self.iso.stat().st_size // decide.SECTOR + 1, 16)
                    return files

                with mock.patch.object(decide, '_iso_index', side_effect=outside_image):
                    self.assert_refused_without_changes(world, 'short ' + path)

    def test_oversized_kernel_and_initrd_are_refused_without_reading_them(self):
        index = decide._iso_index
        for path in (iso_fixture.KERNEL_PATH, iso_fixture.INITRD_PATH):
            with self.subTest(path=path):
                world = self.world()

                def oversized_file(handle):
                    files = index(handle)
                    key = decide._iso_key(files, path)
                    files[key] = (files[key][0], 513 * 1024 * 1024)
                    return files

                with mock.patch.object(decide, '_iso_index', side_effect=oversized_file):
                    self.assert_refused_without_changes(world, 'unusable ' + path)

    def test_truncated_kernel_and_initrd_are_refused_before_staging(self):
        index = decide._iso_index
        for path in (iso_fixture.KERNEL_PATH, iso_fixture.INITRD_PATH):
            with self.subTest(path=path):
                world = self.world()

                def truncated_file(handle):
                    files = index(handle)
                    key = decide._iso_key(files, path)
                    extent = files[key][0]
                    available = self.iso.stat().st_size - extent * decide.SECTOR
                    files[key] = (extent, available + 1)
                    return files

                with mock.patch.object(decide, '_iso_index', side_effect=truncated_file):
                    self.assert_refused_without_changes(world, 'short ' + path)

    def test_the_intentionally_empty_boot_marker_still_allows_staging(self):
        world = self.world()
        tree = iso_fixture.installer_tree()
        tree['EFI']['nixos-installer-image'] = b''
        self.iso.write_bytes(iso_fixture.build(tree))
        self.assertEqual(self.stage(world, firmware=None), 0)
        self.assertEqual(world.restart, 'scheduled')


if __name__ == '__main__':
    unittest.main()
