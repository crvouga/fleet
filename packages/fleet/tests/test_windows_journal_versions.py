"""New journals must stop old unsafe readers while known legacy identities recover."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_windows_stage import StageCase  # noqa: E402
import decide  # noqa: E402


class JournalVersionTests(unittest.TestCase):
    def test_recording_a_loaded_legacy_journal_upgrades_it_to_v2(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = decide.WindowsJournal(directory)
            journal.path.write_text(json.dumps({'version': 1, 'disk': 0}))
            self.assertEqual(journal.load()['version'], 1)
            journal.record(role='ci')
            self.assertEqual(json.loads(journal.path.read_text())['version'], 2)
            self.assertEqual(journal.load()['version'], 2)

    def test_an_old_v1_reader_refuses_a_new_journal(self):
        class LegacyJournal(decide.WindowsJournal):
            VERSION = 1

        with tempfile.TemporaryDirectory() as directory:
            current = decide.WindowsJournal(directory)
            current.record(disk=0)
            self.assertEqual(json.loads(current.path.read_text())['version'], 2)
            with self.assertRaises(decide.Invariant):
                LegacyJournal(directory).load()

    def test_newer_and_malformed_versions_are_not_coerced(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = decide.WindowsJournal(directory)
            for version in (3, 99, 0, -1, True, False, 1.0, 2.0, '1', '2', None):
                with self.subTest(version=repr(version)):
                    journal.path.write_text(json.dumps({'version': version}))
                    with self.assertRaises(decide.Invariant):
                        journal.load()


class LegacyRecoveryTests(StageCase):
    def test_known_partition_identity_in_a_v1_journal_still_recovers(self):
        world = self.world()
        self.stage(world, firmware=None)
        journal = self.state / decide.WINDOWS_JOURNAL_NAME
        data = json.loads(journal.read_text())
        data['version'] = 1
        for field in ('partition_guids_before', 'partition_extent_start', 'partition_extent_end'):
            data.pop(field, None)
        self.assertTrue(data['partition_guid'])
        journal.write_text(json.dumps(data))
        decide.recover_windows_staging(None)
        self.assertTrue(world.clean())
        self.assertFalse(journal.exists())

    def test_an_unidentified_v1_partition_is_preserved_with_its_journal(self):
        world = self.world()
        world.partitions = [7]
        world.partition_size = 4096
        journal = self.state / decide.WINDOWS_JOURNAL_NAME
        original = json.dumps({'version': 1, 'disk': 0, 'partition_size': world.partition_size})
        journal.write_text(original)
        with self.assertRaises(decide.Invariant):
            decide.recover_windows_staging(None)
        self.assertEqual(world.partitions, [7])
        self.assertNotIn('remove-partition', world.ops)
        self.assertEqual(journal.read_text(), original)


if __name__ == '__main__':
    unittest.main()
