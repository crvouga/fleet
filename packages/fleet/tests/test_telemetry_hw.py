#!/usr/bin/env python3
"""GPU, disk, CPU frequency, throttling, pressure, connectivity and lifecycle collectors.

They run against a fixture /proc and /sys tree with fake command output. They
were NOT exercised on real GPU, SMART or NVMe hardware.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import agent
import telemetry
import telemetry_hw


class Clock:
    def __init__(self):
        self.now = 1792890000
        self.tick = 10

    def time(self):
        return self.now

    def monotonic(self):
        return self.tick


class HardwareTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.paths = SimpleNamespace(proc=root / "proc", sys=root / "sys", state=root / "state", run=root / "run",
            etc=root / "etc/fleet", dev=root / "dev", systemctl="fixture-systemctl",
            root_mount=str(root), nix_mount=str(root), boot_mount=str(root))
        for path in (self.paths.proc, self.paths.sys, self.paths.state, self.paths.run, self.paths.etc):
            path.mkdir(parents=True)
        self.clock = Clock()
        self.commands = []
        self.answers = {}
        self.write("proc/sys/kernel/random/boot_id", "boot-a")
        self.write("proc/stat", "cpu 10 0 10 80 0 0 0 0 0 0\n")
        self.write("proc/meminfo", "SwapTotal: 0 kB\nSwapFree: 0 kB\n")
        self.collector = telemetry.Collector(self.paths, self.command, self.clock, agent.redact)

    def write(self, path, value):
        target = Path(self.directory.name) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def command(self, argv, timeout):
        self.commands.append((list(argv), timeout))
        program = os.path.basename(argv[0])
        answer = self.answers.get(program)
        return answer(argv) if callable(answer) else answer if answer is not None else (127, "")

    def sample(self):
        return self.collector.collect({"role": "base"})

    def advance(self, seconds=2):
        self.clock.tick += seconds
        self.clock.now += seconds

    # GPU -------------------------------------------------------------------

    def test_no_gpu_is_unsupported_with_a_reason_not_empty_zeroes(self):
        gpus = self.sample()["gpus"]
        self.assertEqual(gpus["status"], "unsupported")
        self.assertEqual(gpus["devices"], [])
        self.assertIn("No GPU", gpus["reason"])

    def test_nvidia_smi_output_is_parsed_and_unsupported_cells_stay_null(self):
        self.answers["nvidia-smi"] = (0, "0, NVIDIA RTX 4090, 37, 1024, 24564, 61, 180.55\n"
                                         "1, NVIDIA T4, [N/A], [Not Supported], [N/A], 40, [N/A]\n")
        gpus = self.sample()["gpus"]
        self.assertEqual(gpus["status"], "measured")
        first, second = gpus["devices"]
        self.assertEqual((first["utilizationPercent"], first["temperatureCelsius"], first["powerWatts"]), (37, 61, 180.55))
        self.assertEqual((first["memoryUsedBytes"], first["memoryTotalBytes"]), (1024 * 1048576, 24564 * 1048576))
        self.assertIsNone(second["utilizationPercent"])
        self.assertIsNone(second["memoryUsedBytes"])
        self.assertIsNone(second["powerWatts"])
        self.assertEqual(second["temperatureCelsius"], 40)
        argv = [call for call in self.commands if call[0][0] == "nvidia-smi"][0][0]
        self.assertIn("--format=csv,noheader,nounits", argv)
        self.assertTrue(any(arg.startswith("--query-gpu=") for arg in argv))

    def test_nvidia_smi_failure_malformed_and_out_of_range_rows_never_invent_values(self):
        self.answers["nvidia-smi"] = (9, "Failed to initialize NVML")
        gpus = self.sample()["gpus"]
        self.assertEqual(gpus["status"], "unsupported")
        self.assertIn("exit 9", gpus["reason"])
        self.assertNotIn("NVML", json.dumps(gpus))
        self.answers["nvidia-smi"] = (0, "garbage\n0, GPU, 400, 5, 1, 999, -3\n")
        gpus = self.sample()["gpus"]
        row = gpus["devices"][0]
        self.assertEqual(len(gpus["devices"]), 1)
        self.assertIsNone(row["utilizationPercent"])
        self.assertIsNone(row["memoryUsedBytes"])  # used > total is contradictory
        self.assertIsNone(row["temperatureCelsius"])
        self.assertIsNone(row["powerWatts"])

    def test_amd_and_intel_sysfs_metrics_and_unsupported_intel(self):
        base = "sys/class/drm/card0/device"
        self.write(base + "/vendor", "0x1002\n")
        self.write(base + "/product_name", "Radeon Pro")
        self.write(base + "/gpu_busy_percent", "55\n")
        self.write(base + "/mem_info_vram_used", "1000\n")
        self.write(base + "/mem_info_vram_total", "4000\n")
        self.write(base + "/hwmon/hwmon3/temp1_input", "71000\n")
        self.write(base + "/hwmon/hwmon3/power1_average", "90000000\n")
        self.write("sys/class/drm/card1/device/vendor", "0x8086\n")
        self.write("sys/class/drm/card1-DP-1/device/vendor", "0x8086\n")  # connector, not a card
        self.write("sys/class/drm/card2/device/vendor", "0x10de\n")
        gpus = self.sample()["gpus"]
        self.assertEqual(gpus["status"], "measured")
        self.assertEqual(len(gpus["devices"]), 1)
        device = gpus["devices"][0]
        self.assertEqual((device["vendor"], device["utilizationPercent"], device["temperatureCelsius"], device["powerWatts"]),
                         ("amd", 55, 71, 90))
        self.assertEqual((device["memoryUsedBytes"], device["memoryTotalBytes"]), (1000, 4000))
        self.assertIn("INTEL", gpus["reason"])
        self.assertIn("nvidia-smi is not available", gpus["reason"])

    def test_drm_values_out_of_range_are_dropped(self):
        base = "sys/class/drm/card0/device"
        self.write(base + "/vendor", "0x1002")
        self.write(base + "/gpu_busy_percent", "400")
        self.write(base + "/mem_info_vram_used", "9")
        self.write(base + "/mem_info_vram_total", "4")
        self.assertEqual(self.sample()["gpus"]["status"], "unsupported")

    # Disk I/O --------------------------------------------------------------

    def diskstats(self, reads, sectors_read, writes, sectors_written, busy_ms, extra=""):
        self.write("proc/diskstats",
            f"   8       0 sda {reads} 0 {sectors_read} 5 {writes} 0 {sectors_written} 7 0 {busy_ms} 9\n"
            f"   8       1 sda1 {reads} 0 {sectors_read} 5 {writes} 0 {sectors_written} 7 0 {busy_ms} 9\n"
            f"   7       0 loop0 5 0 5 5 5 0 5 5 0 5 5\n   259 0 nvme0n1 1 0 1 1 1 0 1 1 0 1 1\n" + extra)
        self.write("sys/block/sda/dev", "8:0")
        self.write("sys/block/sda/sda1/dev", "8:1")

    def test_disk_io_counts_whole_disks_only_and_computes_rates(self):
        self.diskstats(100, 2000, 50, 1000, 500)
        first = self.sample()["diskIo"]
        self.assertEqual([device["name"] for device in first["devices"]], ["sda"])
        self.assertIsNone(first["devices"][0]["busyPercent"])
        self.assertIn("second counter sample", first["reason"])
        self.advance(2)
        self.diskstats(140, 2400, 70, 1600, 1500)
        second = self.sample()["diskIo"]["devices"][0]
        self.assertEqual(second["readBytesPerSecond"], 400 * 512 / 2)
        self.assertEqual(second["writeBytesPerSecond"], 600 * 512 / 2)
        self.assertEqual(second["iops"], 30)
        self.assertEqual(second["busyPercent"], 50)

    def test_disk_io_counter_reset_and_busy_cap(self):
        self.diskstats(100, 2000, 50, 1000, 500)
        self.sample()
        self.advance(2)
        self.diskstats(1, 1, 1, 1, 1)
        self.assertIsNone(self.sample()["diskIo"]["devices"][0]["iops"])
        self.advance(1)
        self.diskstats(2, 2, 2, 2, 100000)
        self.assertEqual(self.sample()["diskIo"]["devices"][0]["busyPercent"], 100)

    def test_disk_io_malformed_lines_and_no_disks_are_unsupported(self):
        self.write("proc/diskstats", "garbage\n8 0 sda x y z\n")
        self.assertEqual(self.sample()["diskIo"]["status"], "unsupported")
        self.assertIn("diskstats", self.sample()["diskIo"]["reason"])

    # Disk health -----------------------------------------------------------

    def nvme_smart(self, **overrides):
        log = {"critical_warning": 0, "temperature": 41, "available_spare": 100, "available_spare_threshold": 10,
               "percentage_used": 3, "media_errors": 0, "power_on_hours": 100}
        log.update(overrides)
        return json.dumps({"smart_status": {"passed": True}, "temperature": {"current": log["temperature"]},
                           "power_on_time": {"hours": 100}, "nvme_smart_health_information_log": log})

    def test_nvme_smart_ok_warning_failing_and_commands_are_read_only(self):
        self.write("sys/block/nvme0n1/dev", "259:0")
        self.answers["smartctl"] = (0, self.nvme_smart())
        health = self.sample()["diskHealth"]
        self.assertEqual(health["status"], "measured")
        self.assertEqual(health["devices"][0], {"name": "nvme0n1", "state": "ok", "source": "smartctl", "temperatureCelsius": 41,
                                                "wearPercent": 3, "powerOnHours": 100, "detail": None})
        argv = [call[0] for call in self.commands if call[0][0] == "smartctl"][0]
        self.assertEqual(argv[:6], ["smartctl", "-j", "-H", "-A", "-n", "standby"])
        self.assertFalse(any(flag in argv for flag in ("-s", "-t", "-X", "--set", "--test", "-o", "-S")))
        self.advance(400)
        self.answers["smartctl"] = (4, self.nvme_smart(critical_warning=4, percentage_used=95))
        warning = self.sample()["diskHealth"]["devices"][0]
        self.assertEqual(warning["state"], "warning")
        self.assertIn("critical warning flags 0x04", warning["detail"])
        self.assertEqual(warning["wearPercent"], 95)
        self.advance(400)
        self.answers["smartctl"] = (4, json.dumps({"smart_status": {"passed": False}}))
        self.assertEqual(self.sample()["diskHealth"]["devices"][0]["state"], "failing")

    def test_sata_attributes_reallocated_sectors_and_wear(self):
        self.write("sys/block/sda/dev", "8:0")
        table = [{"id": 5, "value": 100, "raw": {"value": 8}}, {"id": 231, "value": 70, "raw": {"value": 0}}]
        self.answers["smartctl"] = (0, json.dumps({"smart_status": {"passed": True}, "temperature": {"current": 35},
                                                   "ata_smart_attributes": {"table": table}}))
        device = self.sample()["diskHealth"]["devices"][0]
        self.assertEqual((device["state"], device["wearPercent"], device["temperatureCelsius"]), ("warning", 30, 35))
        self.assertIn("reallocated sectors", device["detail"])

    def test_smart_results_are_cached_for_five_minutes(self):
        self.write("sys/block/sda/dev", "8:0")
        self.answers["smartctl"] = (0, json.dumps({"smart_status": {"passed": True}}))
        self.sample()
        self.advance(30)
        self.sample()
        self.assertEqual(len([call for call in self.commands if call[0][0] == "smartctl"]), 1)
        self.advance(300)
        self.sample()
        self.assertEqual(len([call for call in self.commands if call[0][0] == "smartctl"]), 2)

    def test_missing_smartctl_uses_kernel_state_and_is_estimated_never_ok(self):
        self.write("sys/block/sda/dev", "8:0")
        self.write("sys/block/sda/device/state", "offline\n")
        self.write("sys/block/nvme0n1/device/state", "live\n")
        self.write("sys/block/nvme0n1/device/hwmon1/temp1_input", "43000\n")
        health = self.sample()["diskHealth"]
        self.assertEqual(health["status"], "estimated")
        self.assertIn("smartctl is not installed", health["reason"])
        states = {device["name"]: device for device in health["devices"]}
        self.assertEqual(states["sda"]["state"], "failing")
        self.assertEqual(states["nvme0n1"]["state"], "unknown")
        self.assertEqual(states["nvme0n1"]["temperatureCelsius"], 43)
        self.assertEqual(len([call for call in self.commands if call[0][0] == "smartctl"]), 1)

    def test_malformed_or_hostile_smartctl_output_is_unknown(self):
        self.write("sys/block/sda/dev", "8:0")
        for output in ("not json", "[1,2]", "null", json.dumps({"smart_status": "x", "temperature": 5, "nvme_smart_health_information_log": []}),
                       json.dumps({"ata_smart_attributes": {"table": [1, "x", {"id": 5, "raw": 7}]}})):
            self.advance(400)
            self.answers["smartctl"] = (0, output)
            device = self.sample()["diskHealth"]["devices"][0]
            self.assertIn(device["state"], ("unknown", "ok", "warning"))
            self.assertNotEqual(device["state"], "failing")
        self.assertEqual(self.sample()["diskHealth"]["status"] in ("measured", "estimated"), True)

    def test_no_disks_is_unsupported(self):
        health = self.sample()["diskHealth"]
        self.assertEqual(health["status"], "unsupported")
        self.assertTrue(health["reason"])

    # CPU frequency, throttling, pressure -----------------------------------

    def frequency(self, cpu, current, maximum=3000000, minimum=800000):
        base = f"sys/devices/system/cpu/cpu{cpu}/cpufreq/"
        self.write(base + "scaling_cur_freq", str(current))
        self.write(base + "cpuinfo_max_freq", str(maximum))
        self.write(base + "cpuinfo_min_freq", str(minimum))

    def test_cpu_frequency_is_measured_and_absent_is_unsupported(self):
        self.assertEqual(self.sample()["cpuFrequency"]["status"], "unsupported")
        self.assertIsNone(self.sample()["cpuFrequency"]["currentMHz"])
        self.frequency(0, 2000000)
        self.frequency(1, 3000000)
        value = self.sample()["cpuFrequency"]
        self.assertEqual((value["status"], value["currentMHz"], value["minMHz"], value["maxMHz"]), ("measured", 2500, 800, 3000))

    def test_thermal_throttle_counters_are_measured_deltas_with_a_hold_window(self):
        for cpu in (0, 1):
            self.write(f"sys/devices/system/cpu/cpu{cpu}/thermal_throttle/core_throttle_count", "0")
            self.write(f"sys/devices/system/cpu/cpu{cpu}/thermal_throttle/package_throttle_count", "5")
        first = self.sample()["throttling"]
        self.assertEqual((first["status"], first["throttled"], first["events"]), ("measured", None, None))
        self.advance(2)
        self.write("sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count", "3")
        second = self.sample()["throttling"]
        self.assertEqual((second["throttled"], second["events"], second["basis"]), (True, 3, "thermal_throttle"))
        self.advance(15)
        held = self.sample()["throttling"]
        self.assertEqual((held["throttled"], held["events"]), (True, 0))
        self.advance(400)
        self.assertEqual(self.sample()["throttling"]["throttled"], False)

    def test_throttle_counter_reset_is_unknown_not_negative(self):
        self.write("sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count", "50")
        self.sample()
        self.advance(2)
        self.write("sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count", "1")
        value = self.sample()["throttling"]
        self.assertIsNone(value["events"])
        self.assertIsNone(value["throttled"])

    def test_frequency_below_max_under_load_is_estimated_only(self):
        self.frequency(0, 1000000)
        self.sample()
        self.advance(2)
        self.write("proc/stat", "cpu 110 0 110 90 0 0 0 0 0 0\n")  # high CPU load
        value = self.sample()["throttling"]
        self.assertEqual((value["status"], value["basis"], value["throttled"]), ("estimated", "frequency", True))
        self.assertIn("inferred", value["reason"])
        self.advance(2)
        self.write("proc/stat", "cpu 110 0 110 1090 0 0 0 0 0 0\n")  # idle: a low clock is normal
        self.assertEqual(self.sample()["throttling"]["throttled"], False)

    def test_throttling_unsupported_without_counters_or_cpufreq(self):
        value = self.sample()["throttling"]
        self.assertEqual(value["status"], "unsupported")
        self.assertIsNone(value["throttled"])

    def test_pressure_reads_some_and_full_and_missing_is_unsupported(self):
        self.assertEqual(self.sample()["pressure"]["status"], "unsupported")
        self.write("proc/pressure/cpu", "some avg10=1.50 avg60=0.75 avg300=0.10 total=1\n")
        self.write("proc/pressure/memory", "some avg10=12.00 avg60=3.00 avg300=1.00 total=9\nfull avg10=5.25 avg60=1.00 avg300=0.00 total=2\n")
        self.write("proc/pressure/io", "some avg10=999.00 avg60=x avg300=0 total=1\n")
        value = self.sample()["pressure"]
        self.assertEqual(value["status"], "measured")
        self.assertEqual(value["cpu"]["someAvg10"], 1.5)
        self.assertIsNone(value["cpu"]["fullAvg10"])
        self.assertEqual((value["memory"]["someAvg10"], value["memory"]["fullAvg60"]), (12, 1))
        self.assertIsNone(value["io"])

    # Network, connectivity, lifecycle ---------------------------------------

    def test_network_error_and_drop_deltas_and_counter_reset(self):
        line = "header\nheader\n eth0: {rx} 10 {rxe} {rxd} 0 0 0 0 {tx} 10 {txe} {txd} 0 0 0 0\n"
        self.write("proc/net/dev", line.format(rx=1000, tx=2000, rxe=1, rxd=2, txe=3, txd=4))
        first = self.sample()["network"][0]
        self.assertIsNone(first["receiveErrors"])
        self.advance(2)
        self.write("proc/net/dev", line.format(rx=1200, tx=2400, rxe=4, rxd=2, txe=3, txd=10))
        second = self.sample()["network"][0]
        self.assertEqual((second["receiveErrors"], second["receiveDropped"], second["transmitErrors"], second["transmitDropped"]), (3, 0, 0, 6))
        self.assertEqual(second["receiveBytesPerSecond"], 100)
        self.advance(2)
        self.write("proc/net/dev", line.format(rx=1300, tx=2500, rxe=0, rxd=0, txe=0, txd=0))
        third = self.sample()["network"][0]
        self.assertIsNone(third["receiveErrors"])
        self.assertEqual(third["receiveBytesPerSecond"], 50)

    def test_network_lines_without_error_columns_leave_error_counts_unknown(self):
        self.write("proc/net/dev", "h\nh\n eth0: 1000 0 0 0 0 0 0 0 2000\n")
        self.sample()
        self.advance(2)
        self.write("proc/net/dev", "h\nh\n eth0: 1200 0 0 0 0 0 0 0 2200\n")
        value = self.sample()["network"][0]
        self.assertEqual(value["receiveBytesPerSecond"], 100)
        self.assertIsNone(value["transmitErrors"])

    def test_connectivity_is_unsupported_until_a_round_trip_is_measured(self):
        self.assertEqual(self.sample()["connectivity"]["status"], "unsupported")
        self.collector.note_heartbeat(42.567, 0)
        value = self.sample()["connectivity"]
        self.assertEqual((value["status"], value["controllerLatencyMs"], value["consecutiveFailures"]), ("measured", 42.6, 0))
        self.collector.note_heartbeat(float("nan"), 3)
        value = self.sample()["connectivity"]
        self.assertIsNone(value["controllerLatencyMs"])
        self.assertEqual(value["consecutiveFailures"], 3)

    def test_uptime_and_restart_count_survive_a_new_boot(self):
        self.write("proc/uptime", "123.45 99.0\n")
        first = self.sample()["lifecycle"]
        self.assertEqual((first["uptimeSeconds"], first["restartCount"]), (123, 0))
        self.assertTrue(first["trackedSince"].endswith("Z"))
        self.advance(2)
        self.assertEqual(self.sample()["lifecycle"]["restartCount"], 0)
        self.write("proc/sys/kernel/random/boot_id", "boot-b")
        self.advance(2)
        self.assertEqual(self.sample()["lifecycle"]["restartCount"], 1)
        self.assertIsNone(self.sample()["cpuUsagePercent"])  # boot-scoped counters still reset
        self.write("proc/sys/kernel/random/boot_id", "boot-c")
        self.assertEqual(self.sample()["lifecycle"]["restartCount"], 2)
        self.write("proc/uptime", "garbage")
        self.assertIsNone(self.sample()["lifecycle"]["uptimeSeconds"])

    def test_corrupt_state_file_restarts_the_count_instead_of_failing(self):
        self.write("state/telemetry-state.json", '{"boot":"x","lifecycle":{"restarts":-5,"since":"nope"}}')
        value = self.sample()["lifecycle"]
        self.assertEqual(value["restartCount"], 0)

    def test_agent_reports_the_previous_heartbeat_round_trip_and_failures(self):
        clock = Clock()
        calls = []

        def http(method, url, headers, data, timeout):
            calls.append(json.loads(data))
            clock.tick += 0.25  # the controller took 250 ms to answer
            return 200, b'{"status": "approved"}'

        env = {"FLEET_AGENT_STATE": str(self.paths.state), "FLEET_RUN": str(self.paths.run),
            "FLEET_ETC": str(self.paths.etc), "FLEET_PROC": str(self.paths.proc), "FLEET_SYS": str(self.paths.sys),
            "FLEET_ROOT_MOUNT": self.directory.name, "FLEET_NIX_MOUNT": self.directory.name,
            "FLEET_BOOT_MOUNT": self.directory.name, "FLEET_SYSTEMCTL": "fixture-systemctl"}
        worker = agent.Agent(agent.Paths(env), "https://fleet.example", http=http, clock=clock,
            run=lambda argv, timeout: (0, "active\n" * (len(argv) - 2)))
        worker.secret = "s" * 64
        worker.failures = 2
        identity = {"role": "base", "id": "a" * 64, "hostname": "h", "capabilities": [], "arch": "x86_64"}
        worker.send_heartbeat(identity)
        first = calls[0]["telemetry"]["connectivity"]
        self.assertEqual((first["status"], first["consecutiveFailures"]), ("measured", 2))
        self.assertIsNone(first["controllerLatencyMs"])  # nothing was measured before this heartbeat
        worker.failures = 0
        clock.tick += 15
        worker.send_heartbeat(identity)
        second = calls[1]["telemetry"]["connectivity"]
        self.assertEqual(second["controllerLatencyMs"], 250)
        self.assertEqual(second["consecutiveFailures"], 0)

    # Robustness -------------------------------------------------------------

    def test_a_crashing_family_degrades_to_unsupported_without_losing_the_sample(self):
        original = telemetry_hw.pressure
        telemetry_hw.pressure = lambda c: 1 / 0
        self.addCleanup(setattr, telemetry_hw, "pressure", original)
        value = self.sample()
        self.assertEqual(value["pressure"]["status"], "unsupported")
        self.assertIn("failed unexpectedly", value["pressure"]["reason"])
        self.assertIn("cpuUsagePercent", value)

    def test_every_family_has_a_provenance_and_unsupported_always_has_a_reason(self):
        value = self.sample()
        for key in ("gpus", "diskIo", "diskHealth", "cpuFrequency", "throttling", "pressure", "connectivity"):
            self.assertIn(value[key]["status"], ("measured", "estimated", "unsupported"), key)
            if value[key]["status"] == "unsupported":
                self.assertTrue(value[key]["reason"], key)
        self.assertLessEqual(len(json.dumps(value, separators=(",", ":")).encode()), 40000)

    def test_hardware_budgets_hold_on_large_machines(self):
        for index in range(40):
            self.write(f"sys/block/sd{chr(97 + index % 26)}{chr(97 + index // 26)}/dev", "8:0")
            self.write(f"sys/class/drm/card{index}/device/vendor", "0x1002")
            self.write(f"sys/class/drm/card{index}/device/gpu_busy_percent", "5")
        self.answers["smartctl"] = (0, self.nvme_smart())
        value = self.sample()
        self.assertLessEqual(len(value["gpus"]["devices"]), telemetry_hw.MAX_GPUS)
        self.assertLessEqual(len(value["diskHealth"]["devices"]), telemetry_hw.MAX_HEALTH)
        self.assertLessEqual(len([call for call in self.commands if call[0][0] == "smartctl"]), telemetry_hw.MAX_HEALTH)

    @unittest.skipUnless(shutil.which("bun"), "Bun unavailable: real controller validation not run")
    def test_actual_controller_validator_accepts_every_family(self):
        self.answers["nvidia-smi"] = (0, "0, GPU, 10, 1, 2, 50, 30\n")
        self.write("sys/block/sda/dev", "8:0")
        self.write("proc/pressure/cpu", "some avg10=1.00 avg60=2.00 avg300=0.00 total=1\n")
        self.write("proc/uptime", "5.0 5.0\n")
        self.diskstats(1, 1, 1, 1, 1)
        self.frequency(0, 1000000)
        self.collector.note_heartbeat(12.5, 0)
        self.answers["smartctl"] = (0, self.nvme_smart())
        self.sample()
        self.advance(2)
        value = self.sample()
        validator = Path(__file__).resolve().parents[2] / "fleet-controller/src/domain/telemetry-validation.ts"
        code = ("const {readTelemetry}=await import(Bun.argv.at(-1)); const p={list:[]};"
                "const t=readTelemetry(p,JSON.parse(await Bun.stdin.text())); if(p.list.length) throw Error(JSON.stringify(p.list));"
                "if(!t.gpus||!t.diskIo||!t.diskHealth||!t.cpuFrequency||!t.throttling||!t.pressure||!t.connectivity||!t.lifecycle) throw Error('family dropped');")
        result = subprocess.run([shutil.which("bun"), "-e", code, str(validator)], input=json.dumps(value),
            capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
