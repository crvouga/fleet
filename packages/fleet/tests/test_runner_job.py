#!/usr/bin/env python3
"""Runner hook metadata never contains arbitrary environment or job output."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import runner_job


class RunnerJobTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "slot-1").mkdir()
        self.path = self.root / "slot-1/job.json"
        self.env = {"FLEET_RUN": str(self.root), "FLEET_SLOT": "slot-1", "GITHUB_REPOSITORY": "owner/repo",
                    "GITHUB_RUN_ID": "1234", "GITHUB_JOB": "build", "GITHUB_TOKEN": "do-not-send", "PASSWORD": "secret"}

    def test_start_completion_and_stop_capture_only_safe_identity(self):
        with mock.patch.object(runner_job, "timestamp", return_value="2026-10-25T01:00:00Z"):
            self.assertTrue(runner_job.record("started", self.env))
        started = json.loads(self.path.read_text())
        self.assertEqual(started, {"repository": "owner/repo", "runId": "1234", "runAttempt": None, "jobName": "build",
            "startedAt": "2026-10-25T01:00:00Z", "finishedAt": None, "result": None})
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        with mock.patch.object(runner_job, "timestamp", return_value="2026-10-25T02:00:00Z"):
            self.assertTrue(runner_job.record("completed", dict(self.env, GITHUB_JOB="untrusted-replacement")))
        completed = json.loads(self.path.read_text())
        self.assertEqual(completed["jobName"], "build")
        self.assertEqual(completed["finishedAt"], "2026-10-25T02:00:00Z")
        self.assertEqual(completed["result"], "completed")
        self.assertTrue(runner_job.record("stopped", self.env))
        self.assertEqual(json.loads(self.path.read_text()), completed)
        self.assertNotIn("do-not-send", self.path.read_text())

    def test_listener_stop_records_interruption_without_claiming_job_success(self):
        runner_job.record("started", self.env)
        runner_job.record("stopped", self.env)
        value = json.loads(self.path.read_text())
        self.assertEqual(value["result"], "interrupted")
        self.assertIsNotNone(value["finishedAt"])

    def test_invalid_slot_repository_and_environment_are_rejected(self):
        self.assertFalse(runner_job.record("started", dict(self.env, FLEET_SLOT="../../outside")))
        runner_job.record("started", dict(self.env, GITHUB_REPOSITORY="../..", GITHUB_RUN_ID="1;rm", GITHUB_JOB="\x00x"))
        value = json.loads(self.path.read_text())
        self.assertIsNone(value["repository"])
        self.assertIsNone(value["runId"])
        self.assertIsNone(value["jobName"])

    def test_io_failure_is_best_effort_and_never_blocks_runner(self):
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(runner_job, "record", return_value=False):
            self.assertEqual(runner_job.main(["started"]), 0)

    def test_deep_untrusted_json_and_unexpected_errors_never_fail_hook(self):
        self.path.write_text("[" * 1500 + "0" + "]" * 1500)
        self.assertTrue(runner_job.record("completed", self.env))
        self.assertEqual(json.loads(self.path.read_text())["result"], "completed")
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(runner_job, "record", side_effect=RuntimeError("password=secret")):
            with mock.patch("sys.stderr") as stderr:
                self.assertEqual(runner_job.main(["completed"]), 0)
                self.assertNotIn("password", str(stderr.write.call_args_list))


class DurableJobRecoveryTests(unittest.TestCase):
    """A job cut off by power loss or a stopped runner is reported once, never re-run, and its cache cleared."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.root = root
        for folder in ("run/slot-1", "state/slot-1", "cache/slot-1", "proc/sys/kernel/random", "recovery"):
            (root / folder).mkdir(parents=True)
        (root / "cache/slot-1/half-written").write_text("partial")
        self.boot("boot-a")
        self.env = {"FLEET_RUN": str(root / "run"), "FLEET_SLOT": "slot-1", "FLEET_JOB_STATE_ROOT": str(root / "state"),
                    "FLEET_PROC": str(root / "proc"), "CI_CACHE_DIR": str(root / "cache/slot-1"),
                    "FLEET_CACHE_ROOT": str(root / "cache"), "GITHUB_REPOSITORY": "owner/repo", "GITHUB_RUN_ID": "1234",
                    "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "build"}
        self.patch = mock.patch.dict(os.environ, {"FLEET_RECOVERY_STATE": str(root / "recovery"), "FLEET_PROC": str(root / "proc"),
                                                  "FLEET_JOB_STATE_ROOT": str(root / "state"), "FLEET_CACHE_ROOT": str(root / "cache"),
                                                  "FLEET_PSTORE": str(root / "no-pstore")})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        import recovery
        self.recovery = recovery

    def boot(self, identity):
        (self.root / "proc/sys/kernel/random/boot_id").write_text(identity + "\n")

    def test_power_loss_mid_job_is_reported_after_the_next_boot_and_the_cache_is_cleared(self):
        self.recovery.on_boot()
        runner_job.record("started", self.env)
        self.assertTrue((self.root / "state/slot-1/job.json").exists())
        self.boot("boot-b")  # the power came back
        self.recovery.on_boot()
        events = self.recovery.pending()
        kinds = [event["kind"] for event in events]
        self.assertEqual(sorted(kinds), ["job-interrupted", "unclean-shutdown"])
        job = next(event for event in events if event["kind"] == "job-interrupted")
        self.assertEqual(job["data"]["cause"], "reset")
        self.assertEqual((job["data"]["repository"], job["data"]["runId"], job["data"]["runAttempt"]), ("owner/repo", "1234", "2"))
        self.assertIn("not re-run automatically", job["message"])
        self.assertTrue(job["data"]["cacheCleared"])
        self.assertEqual(list((self.root / "cache/slot-1").iterdir()), [])
        self.assertFalse((self.root / "state/slot-1/job.json").exists())
        # A second boot reports nothing new: each fact is queued once under its key.
        self.recovery.acknowledge([event["key"] for event in events])
        self.recovery.on_shutdown()
        self.boot("boot-c")
        self.recovery.on_boot()
        self.assertEqual(self.recovery.pending(), [])
        self.assertEqual(self.recovery.last_boot()["previousClean"], True)

    def test_a_stopped_runner_keeps_its_interrupted_job_apart_from_the_next_job(self):
        self.recovery.on_boot()
        runner_job.record("started", self.env)
        runner_job.record("stopped", self.env)
        self.assertEqual(list((self.root / "cache/slot-1").iterdir()), [], "the stopped job's cache is cleared")
        runner_job.record("started", dict(self.env, GITHUB_RUN_ID="5678"))  # the slot's next job
        self.assertEqual(self.recovery.recover_jobs(), 1)
        event = self.recovery.pending()[0]
        self.assertEqual((event["data"]["runId"], event["data"]["cause"]), ("1234", "stopped"))
        self.assertEqual(json.loads((self.root / "state/slot-1/job.json").read_text())["runId"], "5678")

    def test_a_completed_job_leaves_nothing_to_recover(self):
        self.recovery.on_boot()
        runner_job.record("started", self.env)
        runner_job.record("completed", self.env)
        self.boot("boot-b")
        self.recovery.on_boot()
        self.assertEqual([event["kind"] for event in self.recovery.pending()], ["unclean-shutdown"])
        self.assertTrue((self.root / "cache/slot-1/half-written").exists())


if __name__ == "__main__":
    unittest.main()
