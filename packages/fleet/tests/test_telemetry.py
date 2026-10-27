#!/usr/bin/env python3
"""Counter rates and untrusted job metadata, using an isolated proc/sys tree."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import agent
import telemetry


class Clock:
    def __init__(self):
        self.now = 1792890000
        self.tick = 10

    def time(self):
        return self.now

    def monotonic(self):
        return self.tick


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.paths = SimpleNamespace(proc=root / "proc", sys=root / "sys", state=root / "state",
            run=root / "run", etc=root / "etc/fleet", systemctl="fixture-systemctl",
            root_mount=str(root), nix_mount=str(root), boot_mount=str(root))
        for path in (self.paths.proc, self.paths.sys, self.paths.state, self.paths.run, self.paths.etc):
            path.mkdir(parents=True)
        self.clock = Clock()
        self.write("proc/sys/kernel/random/boot_id", "boot-a")
        self.write("proc/stat", "cpu 10 0 10 80 0 0 0 0 0 0\n")
        self.write("proc/meminfo", "SwapTotal: 1024 kB\nSwapFree: 768 kB\n")
        self.write("proc/net/dev", "header\nheader\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n")
        self.collector = telemetry.Collector(self.paths, self.command, self.clock, agent.redact)
        self.identity = {"role": "ci"}
        self.write("run/slot-count", "2")
        self.write("etc/fleet-slots", "slot-1\nslot-2\nslot-3\nslot-4\n")

    def write(self, path, value):
        target = Path(self.directory.name) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
        return target

    def command(self, argv, _timeout):
        return 0, "active\n" * (len(argv) - 2)

    def sample(self):
        return self.collector.collect(self.identity)

    def test_cpu_and_network_are_counter_deltas_and_reset_at_boot(self):
        first = self.sample()
        self.assertIsNone(first["cpuUsagePercent"])
        self.assertIsNone(first["network"][0]["receiveBytesPerSecond"])
        self.clock.tick += 2
        self.write("proc/stat", "cpu 20 0 20 160 0 0 0 0 0 0\n")
        self.write("proc/net/dev", "header\nheader\n eth0: 1200 0 0 0 0 0 0 0 2600 0 0 0 0 0 0 0\n")
        second = self.sample()
        self.assertEqual(second["cpuUsagePercent"], 20)
        self.assertEqual(second["network"][0]["receiveBytesPerSecond"], 100)
        self.assertEqual(second["network"][0]["transmitBytesPerSecond"], 300)
        self.write("proc/sys/kernel/random/boot_id", "boot-b")
        self.clock.tick += 2
        reset = self.sample()
        self.assertIsNone(reset["cpuUsagePercent"])
        self.assertIsNone(reset["network"][0]["receiveBytesPerSecond"])
        self.assertEqual(os.stat(self.paths.state / "telemetry-state.json").st_mode & 0o777, 0o600)

    def test_invalid_reset_counters_and_nonfinite_state_stay_unknown(self):
        self.sample()
        self.clock.tick += 2
        self.write("proc/stat", "cpu 1 0 1 1 0 0 0 0\n")
        self.assertIsNone(self.sample()["cpuUsagePercent"])
        self.write("state/telemetry-state.json", '{"boot":"boot-a","at":NaN,"cpu":[0,0]}')
        self.clock.tick += 2
        self.assertIsNone(self.sample()["cpuUsagePercent"])
        self.write("proc/stat", "cpu invalid 0 1 1\n")
        self.assertIsNone(self.sample()["cpuUsagePercent"])

    def test_hwmon_scope_units_and_powercap_counter_wrap(self):
        self.write("sys/class/hwmon/hwmon0/name", "coretemp")
        self.write("sys/class/hwmon/hwmon0/temp1_input", "54000")
        self.write("sys/class/hwmon/hwmon0/temp1_label", "Package id 0")
        self.write("sys/class/hwmon/hwmon0/power1_input", "45000000")
        self.write("sys/class/hwmon/hwmon0/power1_average", "42000000")
        self.write("sys/class/powercap/intel-rapl:0/name", "package-0")
        self.write("sys/class/powercap/intel-rapl:0/energy_uj", "900000000")
        self.write("sys/class/powercap/intel-rapl:0/max_energy_range_uj", "1000000000")
        first = self.sample()
        self.assertEqual(first["temperatures"], [{"name": "hwmon0/temp1/coretemp/Package id 0", "celsius": 54}])
        self.assertEqual(first["power"], [{"name": "hwmon0/power1/coretemp/power1", "watts": 42, "source": "hwmon"}])
        self.clock.tick += 2
        self.write("sys/class/powercap/intel-rapl:0/energy_uj", "100000000")
        self.assertIn({"name": "intel-rapl:0/package-0", "watts": 100, "source": "powercap"}, self.sample()["power"])
        self.clock.tick += 301
        self.assertFalse(any(p["source"] == "powercap" for p in self.sample()["power"]))

    def test_missing_sensors_and_failed_mounts_are_not_fabricated_zeroes(self):
        with mock.patch.object(telemetry.os, "statvfs", side_effect=OSError()):
            value = self.sample()
        self.assertEqual(value["temperatures"], [])
        self.assertEqual(value["power"], [])
        self.assertEqual(value["filesystems"], [])
        self.assertTrue(any("Temperature" in issue for issue in value["issues"]))
        self.assertTrue(any("Measured power" in issue for issue in value["issues"]))
        self.assertEqual(value["swap"], {"totalBytes": 1048576, "usedBytes": 262144})

    def test_faulted_sensors_and_absurd_power_are_excluded(self):
        self.write("sys/class/hwmon/hwmon0/temp1_input", "54000")
        self.write("sys/class/hwmon/hwmon0/temp1_fault", "1")
        self.write("sys/class/hwmon/hwmon0/power1_input", "1000000000001")
        value = self.sample()
        self.assertEqual(value["temperatures"], [])
        self.assertEqual(value["power"], [])
        self.assertTrue(any("hardware fault" in issue for issue in value["issues"]))

    def test_duplicate_firmware_labels_keep_distinct_channel_identities(self):
        self.write("sys/class/hwmon/hwmon0/name", "x" * 120)
        for channel in (1, 2):
            self.write(f"sys/class/hwmon/hwmon0/temp{channel}_input", "54000")
            self.write(f"sys/class/hwmon/hwmon0/temp{channel}_label", "duplicate" * 20)
            self.write(f"sys/class/hwmon/hwmon0/power{channel}_input", "1000000")
            self.write(f"sys/class/hwmon/hwmon0/power{channel}_label", "duplicate" * 20)
        value = self.sample()
        for key in ("temperatures", "power"):
            self.assertEqual(len(value[key]), 2)
            self.assertEqual(len({reading["name"] for reading in value[key]}), 2)
            self.assertTrue(all(len(reading["name"]) <= 120 for reading in value[key]))

    def test_unicode_firmware_labels_fit_server_string_and_request_limits(self):
        self.write("sys/class/hwmon/hwmon0/name", "sensor")
        self.write("sys/class/hwmon/hwmon0/temp1_input", "54000")
        self.write("sys/class/hwmon/hwmon0/temp1_label", "🔥" * 120)
        value = self.sample()
        name = value["temperatures"][0]["name"]
        self.assertLessEqual(len(name.encode("utf-8")), 120)
        self.assertLessEqual(len(name.encode("utf-16-le")) // 2, 120)

    def test_busy_marker_cannot_attribute_previous_completed_job_to_new_work(self):
        at = telemetry.iso(self.clock.now)
        self.write("run/slot-1/busy", "")
        self.write("run/slot-1/job.json", json.dumps({"repository": "owner/repo", "runId": "123", "jobName": "build",
            "startedAt": at, "finishedAt": at, "result": "completed"}))
        value = self.sample()
        self.assertEqual(value["runnerSlots"][0]["state"], "busy")
        self.assertIsNone(value["runnerSlots"][0]["runId"])
        self.assertTrue(any("Job identity is unavailable" in issue for issue in value["issues"]))

    def test_slots_keep_draining_jobs_and_ignore_unconfigured_markers(self):
        self.write("run/slot-4/busy", "")
        self.write("run/slot-64/busy", "")
        _, selected, busy = telemetry.configured_slots(self.paths)
        self.assertEqual(selected, ["slot-1", "slot-2", "slot-4"])
        self.assertEqual(busy, {"slot-4"})
        value = self.sample()
        self.assertEqual([slot["slot"] for slot in value["runnerSlots"]], selected)
        self.assertEqual(value["runnerSlots"][-1]["state"], "busy")

    def test_root_rejects_symlink_and_oversized_job_documents(self):
        sensitive = self.write("secret.json", json.dumps({"repository": "private/secret", "jobName": "do-not-send"}))
        directory = self.paths.run / "slot-1"
        directory.mkdir()
        (directory / "job.json").symlink_to(sensitive)
        value = self.sample()
        self.assertIsNone(value["runnerSlots"][0]["jobName"])
        self.assertNotIn("do-not-send", json.dumps(value))
        self.assertTrue(any("invalid for slot-1" in issue for issue in value["issues"]))
        (directory / "job.json").unlink()
        self.write("run/slot-1/job.json", " " * 8193)
        self.assertIsNone(self.sample()["runnerSlots"][0]["jobName"])

    def test_only_bounded_job_identity_and_static_lifecycle_logs_leave_node(self):
        at = telemetry.iso(self.clock.now)
        self.write("run/slot-1/job.json", json.dumps({"repository": "owner/repo", "runId": "123",
            "jobName": "build", "startedAt": at, "finishedAt": at, "result": "completed",
            "stdout": "password=hunter2", "GITHUB_TOKEN": "a-secret-token"}))
        value = self.sample()
        self.assertEqual(value["runnerSlots"][0]["runId"], "123")
        self.assertEqual(len(value["logs"]), 2)
        self.assertTrue(all(log["source"] == "runner:slot-1" for log in value["logs"]))
        self.assertNotIn("hunter2", json.dumps(value))
        self.assertNotIn("a-secret-token", json.dumps(value))
        self.assertNotIn("stdout", json.dumps(value))
        self.write("run/slot-1/job.json", json.dumps({"repository": "../..", "runId": "javascript:1", "jobName": "\x00secret", "startedAt": "9999-01-01T00:00:00Z"}))
        details = self.sample()["runnerSlots"][0]
        for key in ("repository", "runId", "jobName", "startedAt"):
            self.assertIsNone(details[key])

    def test_sensor_and_request_budgets_hold_on_large_hardware(self):
        for index in range(100):
            self.write(f"sys/class/hwmon/hwmon0/temp{index}_input", "50000")
            self.write(f"sys/class/hwmon/hwmon0/temp{index}_label", "x" * 120)
            self.write(f"sys/class/hwmon/hwmon0/power{index}_input", "1000000")
        self.write("run/slot-count", "64")
        self.write("etc/fleet-slots", "\n".join(f"slot-{index}" for index in range(1, 65)))
        at = telemetry.iso(self.clock.now)
        for index in range(1, 65):
            self.write(f"run/slot-{index}/job.json", json.dumps({"repository": "a" * 100 + "/" + "b" * 100,
                "runId": "1" * 20, "jobName": "x" * 120, "startedAt": at, "finishedAt": at, "result": "completed"}))
        value = self.sample()
        self.assertLessEqual(len(value["temperatures"]), 64)
        self.assertLessEqual(len(value["power"]), 32)
        self.assertLessEqual(len(value["logs"]), 40)
        self.assertLessEqual(len(json.dumps(value, separators=(",", ":")).encode()), 40000)
        self.assertLessEqual(len(value["issues"]), 16)

    def test_service_query_failure_blocks_false_readiness_without_losing_heartbeat(self):
        env = {"FLEET_AGENT_STATE": str(self.paths.state), "FLEET_RUN": str(self.paths.run),
            "FLEET_ETC": str(self.paths.etc), "FLEET_PROC": str(self.paths.proc), "FLEET_SYS": str(self.paths.sys),
            "FLEET_ROOT_MOUNT": self.directory.name, "FLEET_NIX_MOUNT": self.directory.name,
            "FLEET_BOOT_MOUNT": self.directory.name, "FLEET_SYSTEMCTL": "fixture-systemctl"}
        def command(argv, timeout):
            return (1, "") if "--failed" in argv else self.command(argv, timeout)
        worker = agent.Agent(agent.Paths(env), "https://fleet.example", clock=self.clock, run=command)
        identity = {"role": "ci", "id": "a" * 64, "hostname": "ci-aaaa", "capabilities": [], "arch": "x86_64"}
        with mock.patch.object(agent.node_readiness, "issues", return_value=[]):
            value = worker.heartbeat_body(identity, [])
        self.assertTrue(any("FLEET_SERVICE_STATUS_UNKNOWN" in issue for issue in value["readiness"]["issues"]))
        self.assertTrue(any("systemd diagnostics" in issue for issue in value["telemetry"]["issues"]))
        self.assertEqual(value["runners"], {"slots": 2, "busy": 0})
        self.assertLessEqual(len(json.dumps(value, separators=(",", ":")).encode()), 48 * 1024)

    def test_actual_api_accepts_sensor_channels_jobs_and_failed_nonservice_units(self):
        bun = shutil.which("bun")
        if not bun:
            if os.environ.get("CI"):
                self.fail("Bun is required for the real telemetry protocol validation")
            self.skipTest("Bun unavailable: real telemetry protocol validation not run")
        for channel in (1, 2):
            self.write(f"sys/class/hwmon/hwmon0/temp{channel}_input", "54000")
            self.write(f"sys/class/hwmon/hwmon0/temp{channel}_label", "same label")
        at = telemetry.iso(self.clock.now)
        self.write("run/slot-1/job.json", json.dumps({"repository": "owner/repo", "runId": "123", "jobName": "build",
            "startedAt": at, "finishedAt": at, "result": "completed"}))
        value = self.collector.collect(self.identity, ["fleet-sync.timer", "nix-some\\x2dpath.mount"])
        # The real server decoder is the contract, rather than a Python copy
        # that could agree with the sender while both diverge from production.
        validator = Path(__file__).resolve().parents[2] / "fleet-api/src/domain/telemetry-validation.ts"
        code = "const {readTelemetry}=await import(Bun.argv.at(-1)); const p={list:[]}; readTelemetry(p,JSON.parse(await Bun.stdin.text())); if(p.list.length) throw Error(JSON.stringify(p.list));"
        result = subprocess.run([bun, "-e", code, str(validator)], input=json.dumps(value),
            capture_output=True, text=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
