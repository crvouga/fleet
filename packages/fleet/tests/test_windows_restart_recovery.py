"""A timed restart must be cancelled before recovery changes boot or disk state."""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_windows_stage import StageCase
import decide


class CancelRestartTests(unittest.TestCase):
    def test_cancelled_or_already_absent_restart_is_safe(self):
        for code in (0, 1116):
            with self.subTest(code=code), mock.patch.object(decide, "run_logged", return_value=SimpleNamespace(returncode=code)) as run:
                decide.cancel_windows_restart()
                self.assertEqual(run.call_args.args[0][-1], "/a")
                self.assertLessEqual(run.call_args.kwargs["timeout"], 10)

    def test_other_statuses_do_not_trust_localized_success_text(self):
        for code in (1, 5, 92, 1115):
            result = SimpleNamespace(returncode=code, stdout="No shutdown was in progress (1116)", stderr="")
            with self.subTest(code=code), mock.patch.object(decide, "run_logged", return_value=result):
                with self.assertRaises(decide.Invariant) as caught:
                    decide.cancel_windows_restart()
                self.assertIn("could not be confirmed cancelled", caught.exception.what)
                self.assertIn("shutdown /a", caught.exception.fix)

    def test_unavailable_or_hung_shutdown_does_not_allow_recovery(self):
        for error in (OSError("access denied"), subprocess.TimeoutExpired(["shutdown", "/a"], 10)):
            with self.subTest(error=type(error).__name__), mock.patch.object(decide, "run_logged", side_effect=error):
                with self.assertRaises(decide.Invariant):
                    decide.cancel_windows_restart()


class RestartPrerequisiteTests(StageCase):
    def snapshot(self, world):
        return (world.c_size, list(world.partitions), set(world.entries), list(world.order), world.sequence,
                {name: (world.esp / name).read_bytes() for name in world.esp_files()})

    def test_failed_abort_preserves_entire_staged_install_and_journal(self):
        for outcome in (5, OSError("access denied"), subprocess.TimeoutExpired(["shutdown", "/a"], 10)):
            with self.subTest(outcome=str(outcome)):
                world = self.world()
                self.stage(world, firmware=None)
                before = self.snapshot(world)
                journal = self.state / decide.WINDOWS_JOURNAL_NAME
                record = journal.read_bytes()
                original = world.run_logged

                def refused(command, **kwargs):
                    if "/a" in command:
                        if isinstance(outcome, Exception):
                            raise outcome
                        return SimpleNamespace(returncode=outcome)
                    return original(command, **kwargs)

                with mock.patch.object(decide, "run_logged", side_effect=refused):
                    with self.assertRaises(decide.Invariant):
                        decide.recover_windows_staging(None)
                self.assertEqual(self.snapshot(world), before)
                self.assertEqual(journal.read_bytes(), record)
                self.assertEqual(world.restart, "scheduled")
                # A later successful cancellation can finish the same recovery.
                decide.recover_windows_staging(None)
                self.assertTrue(world.clean())
                self.assertFalse(journal.exists())

    def test_restart_already_cancelled_allows_recovery(self):
        world = self.world()
        self.stage(world, firmware=None)
        world.restart = "aborted"
        original = world.run_logged

        def already_cancelled(command, **kwargs):
            return SimpleNamespace(returncode=1116) if "/a" in command else original(command, **kwargs)

        with mock.patch.object(decide, "run_logged", side_effect=already_cancelled):
            decide.recover_windows_staging(None)
        self.assertTrue(world.clean())
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())

    def test_incomplete_volume_restoration_keeps_journal_for_a_later_retry(self):
        world = self.world()
        self.stage(world, firmware=None)
        world.facts['SizeMax'] -= 1
        with self.assertRaises(decide.Invariant) as caught:
            decide.recover_windows_staging(None)
        self.assertIn('give C:', caught.exception.context['failed'])
        journal = self.state / decide.WINDOWS_JOURNAL_NAME
        self.assertTrue(journal.exists())
        self.assertLess(world.c_size, world.facts['Size'])
        world.facts['SizeMax'] = world.facts['Size']
        decide.recover_windows_staging(None)
        self.assertTrue(world.clean())
        self.assertFalse(journal.exists())

    def test_outer_rollback_keeps_backing_resources_when_abort_is_refused(self):
        world = self.world()
        original_log, original_run = decide.log, world.run_logged

        def interrupted(message, level="INFO"):
            if "the restart is scheduled for" in message:
                raise KeyboardInterrupt()
            return original_log(message, level)

        def refused(command, **kwargs):
            return SimpleNamespace(returncode=5) if "/a" in command else original_run(command, **kwargs)

        with mock.patch.object(decide, "run_logged", side_effect=refused), mock.patch.object(decide, "log", side_effect=interrupted):
            with self.assertRaises(decide.Invariant) as caught:
                self.stage(world, firmware=None)
        self.assertIsInstance(caught.exception.__cause__, KeyboardInterrupt)
        self.assertEqual(world.restart, "scheduled")
        self.assertEqual(len(world.partitions), 1)
        self.assertTrue((world.esp / "EFI/fleet/grubx64.efi").exists())
        self.assertNotIn("bcd:delete", world.ops)
        journal = self.state / decide.WINDOWS_JOURNAL_NAME
        self.assertTrue(json.loads(journal.read_text())["restart_scheduled"])
        decide.recover_windows_staging(None)
        self.assertTrue(world.clean())

    def test_ambiguous_schedule_failure_cancels_before_any_cleanup(self):
        world = self.world()
        original = world.run_logged

        def ambiguous(command, **kwargs):
            result = original(command, **kwargs)
            if "/r" in command:
                self.assertTrue(json.loads((self.state / decide.WINDOWS_JOURNAL_NAME).read_text())["restart_scheduled"])
                raise OSError("lost the launch result after shutdown started")
            return result

        with mock.patch.object(decide, "run_logged", side_effect=ambiguous):
            with self.assertRaises(OSError):
                self.stage(world, firmware=None)
        self.assertEqual(world.restart, "aborted")
        self.assertLess(world.ops.index("shutdown-abort"), world.ops.index("bcd:delete"))
        self.assertTrue(world.clean())
        self.assertFalse((self.state / decide.WINDOWS_JOURNAL_NAME).exists())


if __name__ == "__main__":
    unittest.main()
