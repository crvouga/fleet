"""A failed boot mechanism cannot be abandoned under the installer's disk rollback."""
import json
import unittest
from unittest import mock

from test_windows_stage import StageCase, ENTRY
from test_windows_firmware import FakeFirmware
import decide


class UndoRetryTests(unittest.TestCase):
    def test_only_failed_actions_remain_and_retry_in_the_original_order(self):
        undo = decide.WindowsUndo()
        calls = []
        fail = {'newest', 'oldest'}

        def action(name):
            calls.append(name)
            if name in fail:
                raise OSError('fixture cleanup failure')

        for name in ('oldest', 'middle', 'newest'):
            undo.add(name, lambda name=name: action(name))
        with mock.patch.object(decide, 'say'), mock.patch.object(decide, 'log'):
            self.assertEqual(undo.run(), ['newest', 'oldest'])
            fail.clear()
            self.assertEqual(undo.run(), [])
            self.assertEqual(undo.run(), [])
        self.assertEqual(calls, ['newest', 'middle', 'oldest', 'newest', 'oldest'])

    def test_an_unchanged_firmware_variable_does_not_need_another_refused_write(self):
        original = (b'original boot order', 7)
        firmware = FakeFirmware({'BootOrder': original}, fail={('write', 'BootOrder')})
        decide.restore_firmware_variable(firmware, 'BootOrder', original)
        self.assertEqual(firmware.vars['BootOrder'], original)

    def test_a_silently_ignored_firmware_restoration_is_not_success(self):
        original = (b'original boot order', 7)
        firmware = FakeFirmware({'BootOrder': (b'changed boot order', 7)}, lose={'BootOrder'})
        with self.assertRaises(decide.Invariant):
            decide.restore_firmware_variable(firmware, 'BootOrder', original)
        self.assertNotEqual(firmware.vars['BootOrder'], original)

    def test_a_silently_ignored_firmware_deletion_is_not_success(self):
        firmware = FakeFirmware({'BootNext': (b'\x02\x00', 7)})
        with mock.patch.object(firmware, 'delete'), self.assertRaises(decide.Invariant):
            decide.restore_firmware_variable(firmware, 'BootNext', None)
        self.assertIn('BootNext', firmware.vars)


class BootCleanupTests(StageCase):
    def assert_backing_resources_kept(self, world):
        self.assertEqual(world.partitions, [5])
        self.assertTrue((world.esp / 'EFI/fleet/grubx64.efi').is_file())
        self.assertTrue((self.state / decide.WINDOWS_JOURNAL_NAME).is_file())
        self.assertNotIn('shutdown', world.ops)
        self.assertNotIn('remove-partition', world.ops)

    def test_failed_bcd_cleanup_stops_before_native_boot_or_restart(self):
        firmware = FakeFirmware(self.firmware_vars)
        world = self.world()
        world.hide_sequence = True
        world.fail_at = {'bcd:sequence-clear', 'bcd:displayorder-remove', 'bcd:delete'}
        with self.assertRaises(decide.Invariant) as caught:
            self.stage(world, firmware)
        self.assertIn('could not be taken back', caught.exception.what)
        self.assertEqual(world.entries, {ENTRY})
        self.assertEqual(world.sequence, ENTRY)
        self.assertEqual(firmware.vars, self.firmware_vars)
        self.assert_backing_resources_kept(world)
        journal = json.loads((self.state / decide.WINDOWS_JOURNAL_NAME).read_text())
        self.assertEqual(journal['bcd_entry'], ENTRY)

        world.hide_sequence = False
        world.fail_at.clear()
        decide.recover_windows_staging(firmware)
        self.assertTrue(world.clean())
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_failed_native_cleanup_stops_even_with_verified_bcd_fallback(self):
        class WrongReadback(FakeFirmware):
            def read(self, name):
                value = super().read(name)
                return (b'wrong boot entry', value[1]) if name == 'Boot0002' and value is not None else value

        firmware = WrongReadback(self.firmware_vars, fail={('delete', 'Boot0002')})
        world = self.world()
        with self.assertRaises(decide.Invariant) as caught:
            self.stage(world, firmware)
        self.assertIn('could not be taken back', caught.exception.what)
        self.assertIn('Boot0002', firmware.vars)
        self.assertEqual(world.entries, set(), 'the independent BCD cleanup still runs')
        self.assert_backing_resources_kept(world)

        firmware.fail.clear()
        with mock.patch.object(firmware, 'read', side_effect=lambda name: firmware.vars.get(name)):
            decide.recover_windows_staging(firmware)
        self.assertTrue(world.clean())
        self.assertEqual(firmware.vars, self.firmware_vars)
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_outer_rollback_retries_transient_failed_cleanup_without_handoff(self):
        firmware = FakeFirmware(self.firmware_vars)
        world = self.world()
        world.hide_sequence = True
        original = world.bcd
        deletions = []

        def bcd(*args):
            if args == ('/delete', ENTRY):
                deletions.append(args)
                if len(deletions) == 1:
                    raise OSError('temporary fixture refusal')
            return original(*args)

        with mock.patch.object(decide, 'bcd', side_effect=bcd), self.assertRaises(decide.Invariant):
            self.stage(world, firmware)
        self.assertEqual(len(deletions), 2)
        self.assertTrue(world.clean())
        self.assertEqual(firmware.vars, self.firmware_vars)
        self.assertNotIn('shutdown', world.ops)
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_bcd_entry_is_cleaned_if_recording_its_identity_fails(self):
        firmware = FakeFirmware(self.firmware_vars)
        world = self.world()
        original = decide.WindowsJournal.record

        def record(journal, **values):
            if 'bcd_entry' in values:
                raise OSError('fixture journal write refusal')
            return original(journal, **values)

        with mock.patch.object(decide.WindowsJournal, 'record', new=record):
            self.assertEqual(self.stage(world, firmware), 0)
        self.assertEqual(world.entries, set())
        self.assertEqual(world.restart, 'scheduled')
        self.assertIn('BootNext', firmware.vars)

    def test_interrupted_recovery_verifies_each_native_boot_mutation(self):
        for variable in ('BootNext', 'BootOrder', 'Boot0002'):
            with self.subTest(variable=variable):
                firmware = FakeFirmware(self.firmware_vars)
                world = self.world()
                self.assertEqual(self.stage(world, firmware), 0)
                original_write, original_delete = firmware.write, firmware.delete

                def write(name, data, attributes=7):
                    if name != variable:
                        original_write(name, data, attributes)

                def delete(name):
                    if name != variable:
                        original_delete(name)

                with mock.patch.object(firmware, 'write', side_effect=write), \
                        mock.patch.object(firmware, 'delete', side_effect=delete), self.assertRaises(decide.Invariant):
                    decide.recover_windows_staging(firmware)
                self.assertEqual(world.partitions, [5])
                self.assertTrue((world.esp / 'EFI/fleet/grubx64.efi').is_file())
                self.assertTrue((self.state / decide.WINDOWS_JOURNAL_NAME).is_file())
                self.assertEqual(world.restart, 'aborted')

                decide.recover_windows_staging(firmware)
                self.assertTrue(world.clean())
                self.assertEqual(firmware.vars, self.firmware_vars)
                self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_interrupted_recovery_verifies_bcd_sequence_and_entry_removal(self):
        for ignored in (('/deletevalue', '{fwbootmgr}', 'bootsequence'), ('/delete', ENTRY)):
            with self.subTest(ignored=ignored):
                firmware = FakeFirmware(self.firmware_vars)
                world = self.world()
                self.assertEqual(self.stage(world, firmware), 0)
                original = world.bcd

                def bcd(*args):
                    return '' if args == ignored else original(*args)

                with mock.patch.object(decide, 'bcd', side_effect=bcd), self.assertRaises(decide.Invariant):
                    decide.recover_windows_staging(firmware)
                self.assertEqual(world.partitions, [5])
                self.assertTrue((world.esp / 'EFI/fleet/grubx64.efi').is_file())
                self.assertTrue((self.state / decide.WINDOWS_JOURNAL_NAME).is_file())

                decide.recover_windows_staging(firmware)
                self.assertTrue(world.clean())
                self.assertEqual(firmware.vars, self.firmware_vars)
                self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_an_unreadable_bcd_enumeration_cannot_prove_cleanup_completed(self):
        firmware = FakeFirmware(self.firmware_vars)
        world = self.world()
        self.assertEqual(self.stage(world, firmware), 0)
        world.fail_at = {'bcd:enum-all'}
        with self.assertRaises(decide.Invariant):
            decide.recover_windows_staging(firmware)
        self.assertEqual(world.partitions, [5])
        self.assertTrue((self.state / decide.WINDOWS_JOURNAL_NAME).is_file())
        world.fail_at.clear()
        decide.recover_windows_staging(firmware)
        self.assertTrue(world.clean())

    def test_ordinary_rollback_rejects_a_silently_ignored_bcd_deletion(self):
        world = self.world()
        world.fail_at = {'shutdown'}
        original = world.bcd

        def bcd(*args):
            return '' if args == ('/delete', ENTRY) else original(*args)

        with mock.patch.object(decide, 'bcd', side_effect=bcd), self.assertRaises(decide.Invariant):
            self.stage(world, firmware=None)
        self.assertEqual(world.entries, {ENTRY})
        self.assertEqual(world.partitions, [5])
        self.assertTrue((world.esp / 'EFI/fleet/grubx64.efi').is_file())
        self.assertTrue((self.state / decide.WINDOWS_JOURNAL_NAME).is_file())


if __name__ == '__main__':
    unittest.main()
