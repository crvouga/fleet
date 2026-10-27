"""The ESP drive letter disappears on unmount; late rollback must remount it."""
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_windows_stage import StageCase  # noqa: E402
import decide  # noqa: E402


class EspRollbackTests(StageCase):
    def disappearing_letter(self, world, refuse_recovery_mount=False):
        """Keep the backing files, but make their old drive-letter path disappear."""
        backing = world.root / 'unmounted-esp'
        original = world.ps
        mounts = []

        def ps(script, **kwargs):
            if '/S' in script and 'mountvol' in script:
                mounts.append(script)
                if refuse_recovery_mount and len(mounts) > 1:
                    raise OSError('fixture recovery mount refusal')
                result = original(script, **kwargs)
                if backing.exists():
                    backing.rename(world.esp)
                return result
            result = original(script, **kwargs)
            if '/D' in script and 'mountvol' in script:
                world.esp.rename(backing)
            return result

        return ps, backing, mounts

    def original_config(self, world):
        config = world.esp / 'EFI/BOOT/grub.cfg'
        config.parent.mkdir(parents=True)
        original = b'# owner boot config\r\nset timeout=17\r\n'
        config.write_bytes(original)
        return original

    def test_shutdown_failure_remounts_and_restores_config_and_removes_wifi(self):
        world = self.world()
        original = self.original_config(world)
        world.fail_at = {'shutdown'}
        ps, backing, mounts = self.disappearing_letter(world)
        wifi = {'ssid': 'Fixture Wi-Fi', 'password': 'fixture-wifi-password'}
        with mock.patch.object(decide, 'windows_ps', side_effect=ps), self.assertRaises(decide.Invariant):
            self.stage(world, firmware=None, wifi=wifi)
        self.assertEqual(len(mounts), 2, 'rollback must reacquire the ESP after shutdown scheduling fails')
        self.assertFalse(world.esp.exists(), 'the temporary drive letter is removed again')
        self.assertEqual((backing / 'EFI/BOOT/grub.cfg').read_bytes(), original)
        self.assertFalse((backing / 'EFI/fleet').exists(), 'loader and Wi-Fi credentials are removed together')
        self.assertTrue(world.clean())
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_shutdown_failure_removes_new_config_when_no_owner_config_existed(self):
        world = self.world()
        world.fail_at = {'shutdown'}
        ps, backing, _ = self.disappearing_letter(world)
        with mock.patch.object(decide, 'windows_ps', side_effect=ps), self.assertRaises(decide.Invariant):
            self.stage(world, firmware=None)
        self.assertFalse((backing / 'EFI/BOOT/grub.cfg').exists())
        self.assertFalse((backing / 'EFI/fleet').exists())
        self.assertTrue(world.clean())
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_a_failed_remount_keeps_the_journal_for_a_later_recovery(self):
        world = self.world()
        original = self.original_config(world)
        world.fail_at = {'shutdown'}
        ps, backing, _ = self.disappearing_letter(world, refuse_recovery_mount=True)
        with mock.patch.object(decide, 'windows_ps', side_effect=ps), self.assertRaises(decide.Invariant) as caught:
            self.stage(world, firmware=None)
        self.assertIn('could not be taken back', caught.exception.what)
        self.assertTrue((backing / 'EFI/fleet/grubx64.efi').exists())
        journal = self.state / decide.WINDOWS_JOURNAL_NAME
        self.assertTrue(journal.exists())

        ps, _, _ = self.disappearing_letter(world)
        with mock.patch.object(decide, 'windows_ps', side_effect=ps):
            decide.recover_windows_staging(None)
        self.assertEqual((backing / 'EFI/BOOT/grub.cfg').read_bytes(), original)
        self.assertFalse((backing / 'EFI/fleet').exists())
        self.assertTrue(world.clean())
        self.assertFalse(journal.exists())

    def test_mount_only_failure_preserves_files_that_were_never_changed(self):
        world = self.world()
        original = self.original_config(world)
        loader = world.esp / 'EFI/fleet/grubx64.efi'
        loader.parent.mkdir(parents=True)
        loader.write_bytes(b'previous loader')
        world.free = 0
        ps, backing, _ = self.disappearing_letter(world)
        with mock.patch.object(decide, 'windows_ps', side_effect=ps), self.assertRaises(decide.Invariant):
            self.stage(world, firmware=None)
        self.assertEqual((backing / 'EFI/BOOT/grub.cfg').read_bytes(), original)
        self.assertEqual((backing / 'EFI/fleet/grubx64.efi').read_bytes(), b'previous loader')
        self.assertTrue(world.clean())
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())


if __name__ == '__main__':
    unittest.main()
