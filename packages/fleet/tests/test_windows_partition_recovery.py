"""Interrupted staging identifies only a new partition in its reserved extent."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
from test_windows_stage import StageCase  # noqa: E402

OLD_GUID = "{11111111-2222-3333-4444-555555555555}"
NEW_GUID = "{99999999-8888-7777-6666-555555555555}"
START = 1048576
SIZE = 8 * 1048576


def partition(number, guid, offset=START, size=SIZE):
    return {"Number": number, "Guid": guid, "Offset": offset, "Size": size}


class PartitionRecoveryTests(unittest.TestCase):
    def recover(self, parts, **journal):
        commands = []
        def ps(script, **kwargs):
            if "Parts = $found" in script:
                return json.dumps({"Parts": parts})
            commands.append(script)
            return ""
        data = {"disk": 0, "partition_size": SIZE, "partition_guids_before": [OLD_GUID],
                "partition_extent_start": START, "partition_extent_end": START + SIZE + decide.WINDOWS_MARGIN,
                **journal}
        with mock.patch.object(decide, "windows_ps", side_effect=ps):
            decide._recover_partition(data)
        return commands

    def test_crash_before_creation_preserves_an_existing_same_size_partition(self):
        self.assertEqual(self.recover([partition(7, OLD_GUID)]), [])

    def test_crash_before_creation_with_no_existing_linux_partition_is_a_noop(self):
        self.assertEqual(self.recover([], partition_guids_before=[]), [])

    def test_crash_after_creation_removes_only_the_new_identity_at_the_reserved_location(self):
        commands = self.recover([partition(7, OLD_GUID), partition(8, NEW_GUID)])
        self.assertEqual(commands, [decide.ps_remove_partition_script(0, 8)])

    def test_no_guid_recovery_refuses_a_new_partition_outside_the_reserved_extent(self):
        for changes in ({"offset": START + 4096}, {"size": SIZE - 4096}, {"size": SIZE + decide.WINDOWS_MARGIN + 4096}):
            with self.subTest(changes=changes), self.assertRaises(decide.Invariant):
                self.recover([partition(8, NEW_GUID, **changes)])

    def test_ambiguous_new_partitions_stop_without_deleting_either(self):
        with self.assertRaisesRegex(decide.Invariant, "more than one"):
            self.recover([partition(8, NEW_GUID), partition(9, "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}")])

    def test_legacy_journal_without_guid_or_snapshot_refuses_size_only_recovery(self):
        with self.assertRaisesRegex(decide.Invariant, "cannot be identified safely"):
            self.recover([partition(7, OLD_GUID)], partition_guids_before=None)

    def test_legacy_journal_with_a_guid_still_recovers_by_identity(self):
        commands = self.recover([partition(7, OLD_GUID), partition(8, NEW_GUID)],
                                partition_guid=NEW_GUID, partition_guids_before=None)
        self.assertEqual(commands, [decide.ps_remove_partition_script(0, 8)])

    def test_a_recorded_guid_cannot_identify_a_preexisting_partition(self):
        with self.assertRaisesRegex(decide.Invariant, "already present"):
            self.recover([partition(7, OLD_GUID)], partition_guid=OLD_GUID)

    def test_snapshot_identity_comparison_ignores_braces_and_case(self):
        self.assertEqual(self.recover([partition(7, OLD_GUID.lower().strip("{}"))]), [])

    def test_a_partition_with_no_identity_cannot_be_deleted(self):
        with self.assertRaisesRegex(decide.Invariant, "no valid identity"):
            self.recover([partition(7, None)])


class PartitionExtentTests(unittest.TestCase):
    def test_a_sector_aligned_system_end_uses_the_next_mib_without_overstating_free_space(self):
        raw = START + 512
        start, end = decide._partition_extent({"Offset": raw}, SIZE + decide.WINDOWS_MARGIN, SIZE)
        self.assertEqual(start, START + decide.MIB)
        self.assertEqual(end, raw + SIZE + decide.WINDOWS_MARGIN)

    def test_missing_invalid_or_empty_extent_stops_before_creation(self):
        for offset in (None, 0, -1, True, "1048576"):
            with self.subTest(offset=offset), self.assertRaises(decide.Invariant):
                decide._partition_extent({"Offset": offset}, SIZE + decide.WINDOWS_MARGIN, SIZE)

    def test_alignment_cannot_consume_the_space_needed_by_the_image(self):
        with self.assertRaises(decide.Invariant):
            decide._partition_extent({"Offset": START + 512}, SIZE, SIZE)


class PartitionJournalTests(StageCase):
    def interrupted(self, created):
        world = self.world()
        original = world.ps
        def power_cut(script, **kwargs):
            if "New-Partition" in script:
                if created:
                    original(script, **kwargs)
                raise SystemExit("simulated power loss")
            return original(script, **kwargs)
        # A real process death cannot execute its in-memory finally/undo work.
        with mock.patch.object(decide, "windows_ps", side_effect=power_cut), \
                mock.patch.object(decide.WindowsUndo, "run", return_value=[]), \
                mock.patch.object(decide.WindowsJournal, "clear"), self.assertRaises(SystemExit):
            self.stage(world, firmware=None)
        return world

    def test_snapshot_is_durable_before_new_partition_can_run(self):
        world = self.interrupted(created=False)
        journal = decide.WindowsJournal().load()
        self.assertEqual(journal["partition_guids_before"], [])
        self.assertEqual(journal["partition_extent_start"], START)
        self.assertNotIn("partition_guid", journal)
        decide.recover_windows_staging(None)
        self.assertTrue(world.clean())

    def test_created_partition_can_be_recovered_before_its_guid_was_recorded(self):
        world = self.interrupted(created=True)
        self.assertEqual(world.partitions, [5])
        self.assertNotIn("partition_guid", decide.WindowsJournal().load())
        decide.recover_windows_staging(None)
        self.assertTrue(world.clean())

    def test_a_created_partition_is_undone_when_its_command_result_is_lost(self):
        for response in (None, "not JSON"):
            with self.subTest(response=response):
                world = self.world()
                original = world.ps
                def ambiguous_creation(script, **kwargs):
                    result = original(script, **kwargs)
                    if "New-Partition" in script:
                        if response is None:
                            raise OSError("the partition was created but its result was lost")
                        return response
                    return result
                with mock.patch.object(decide, "windows_ps", side_effect=ambiguous_creation), \
                        self.assertRaises((OSError, decide.Invariant)):
                    self.stage(world, firmware=None)
                self.assertTrue(world.clean())
                self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())


if __name__ == "__main__":
    unittest.main()
