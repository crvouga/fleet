"""Bounded Linux observations. Unsupported sensors stay unknown, never fabricated zeroes.

Counter-derived rates use a monotonic, boot-scoped previous sample. Sensor
names retain the hardware scope: CPU/package watts are not wall-plug watts.
Only static lifecycle/service diagnostics leave this module, never job output.
"""
import json
import math
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path

import fleetconf
import runner_job

MAX_BYTES = 9_007_199_254_740_991
MAX_STATE = 65536


def read(path, limit=8192):
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return ""


def number(path):
    value = read(path, 100).strip()
    return int(value) if re.fullmatch(r"[0-9]{1,20}", value) else None


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def valid_time(value, now):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value):
        return None
    try:
        at = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        return value if 0 <= at <= now + 300 else None
    except ValueError:
        return None


def configured_slots(paths):
    text = read(paths.run / "slot-count", 32).strip()
    count = int(text) if text.isdigit() and 0 <= int(text) <= 64 else None
    allowed = {line.strip() for line in read(paths.etc.parent / "fleet-slots").splitlines()
               if runner_job.SLOT.fullmatch(line.strip())}
    if not allowed:
        try:
            conf = dict(line.split("=", 1) for line in read(paths.etc / "node.conf").splitlines() if "=" in line)
            maximum = int(conf.get("slot_max", "0"))
            allowed = {f"slot-{n}" for n in range(1, maximum + 1)} if 1 <= maximum <= 64 else set()
        except ValueError:
            allowed = set()
    if not allowed and count is not None:
        allowed = {f"slot-{n}" for n in range(1, count + 1)}
    active = {f"slot-{n}" for n in range(1, (count or 0) + 1)} & allowed
    busy = {slot for slot in allowed if (paths.run / slot / "busy").is_file()}
    # A capacity decrease must not hide jobs still draining in an older slot.
    selected = active | busy
    return count, sorted(selected, key=lambda slot: int(slot[5:])), busy


class Collector:
    def __init__(self, paths, command, clock, redact):
        self.paths, self.command, self.clock, self.redact = paths, command, clock, redact
        self.previous = {}
        self.current = {}
        self.issues = []

    def issue(self, message):
        if message not in self.issues and len(self.issues) < 16:
            self.issues.append(message[:500])

    def label(self, value):
        value = self.redact(re.sub(r"[\x00-\x1f\x7f]", " ", str(value))).strip()
        # Byte bounding also respects the server's UTF-16 string limit when
        # firmware provides non-ASCII labels or supplementary characters.
        return value.encode("utf-8", "replace")[:120].decode("utf-8", "ignore")

    def unique(self, readings):
        result, seen = [], set()
        for reading in readings:
            name = reading["name"]
            if name in seen:
                self.issue("Duplicate hardware sensor names were omitted; sensor identity could not be distinguished.")
                continue
            seen.add(name)
            result.append(reading)
        return result

    def baseline(self):
        try:
            value = json.loads(read(self.paths.state / "telemetry-state.json", MAX_STATE))
            if isinstance(value, dict):
                self.previous = value
        except (ValueError, RecursionError):
            pass
        boot = read(self.paths.proc / "sys/kernel/random/boot_id", 128).strip()
        now = self.clock.monotonic()
        self.current = {"boot": boot, "at": now, "power": {}, "network": {}}
        before = self.previous.get("at")
        same_boot = boot and self.previous.get("boot") == boot
        self.elapsed = now - before if same_boot and type(before) in (int, float) and math.isfinite(before) else None
        if self.elapsed is None or not 0 < self.elapsed <= 7200:
            self.previous = {}
            self.elapsed = None

    def cpu(self):
        first = read(self.paths.proc / "stat").splitlines()
        fields = first[0].split() if first else []
        if len(fields) < 5 or fields[0] != "cpu" or not all(value.isdigit() for value in fields[1:9]):
            self.issue("CPU utilization is unavailable: the kernel CPU counters could not be read.")
            return None
        counters = list(map(int, fields[1:9]))
        total = sum(counters)
        idle = counters[3] + (counters[4] if len(counters) > 4 else 0)
        self.current["cpu"] = [total, idle]
        previous = self.previous.get("cpu")
        if not isinstance(previous, list) or len(previous) != 2 or not all(type(v) is int for v in previous):
            self.issue("CPU utilization is warming up; a second counter sample is required.")
            return None
        elapsed, idle_elapsed = total - previous[0], idle - previous[1]
        if elapsed <= 0 or not 0 <= idle_elapsed <= elapsed:
            self.issue("CPU counters reset; utilization will resume after a valid sample.")
            return None
        return round(100 * (elapsed - idle_elapsed) / elapsed, 2)

    def filesystems(self):
        result = []
        mounts = [("/", getattr(self.paths, "root_mount", "/")), ("/nix", self.paths.nix_mount), ("/boot", self.paths.boot_mount)]
        for mount, path in mounts:
            try:
                info = os.statvfs(path)
                total = info.f_blocks * info.f_frsize
                used = (info.f_blocks - info.f_bfree) * info.f_frsize
                available = max(0, info.f_bavail * info.f_frsize)
                if not 0 <= used <= total <= MAX_BYTES or not 0 <= available <= total - used:
                    raise ValueError()
                result.append({"mount": mount, "totalBytes": total, "usedBytes": used, "availableBytes": available})
            except (OSError, ValueError):
                self.issue(f"Filesystem capacity is unavailable for {mount}.")
        return result

    def swap(self):
        memory = {}
        for line in read(self.paths.proc / "meminfo").splitlines():
            parts = line.replace(":", " ").split()
            if len(parts) >= 2 and parts[1].isdigit():
                memory[parts[0]] = int(parts[1]) * 1024
        total, free = memory.get("SwapTotal"), memory.get("SwapFree")
        if total is None or free is None or not 0 <= free <= total <= MAX_BYTES:
            self.issue("Swap utilization is unavailable: kernel memory counters could not be read.")
            return None
        return {"totalBytes": total, "usedBytes": total - free}

    def sensors(self):
        temperatures, power = [], []
        for chip in sorted((self.paths.sys / "class/hwmon").glob("hwmon*"))[:64]:
            driver = read(chip / "name", 120).strip() or chip.name
            for path in sorted(chip.glob("temp[0-9]*_input"))[:64]:
                prefix = path.name.removesuffix("_input")
                if number(chip / f"{prefix}_fault") not in (None, 0) or number(chip / f"{prefix}_enable") == 0:
                    self.issue("A temperature sensor is disabled or reports a hardware fault.")
                    continue
                raw = read(path, 100).strip()
                if not re.fullmatch(r"-?[0-9]{1,9}", raw) or not -100000 <= int(raw) <= 250000:
                    self.issue("A temperature sensor returned an unreadable or out-of-range value.")
                    continue
                label = read(chip / path.name.replace("_input", "_label"), 120).strip() or path.stem
                if len(temperatures) < 64:
                    temperatures.append({"name": self.label(f"{chip.name}/{prefix}/{driver}/{label}"), "celsius": int(raw) / 1000})
            paths = {re.sub(r"_(?:input|average)$", "", path.name): path for path in sorted(chip.glob("power[0-9]*_input"))[:32]}
            paths.update({re.sub(r"_average$", "", path.name): path for path in sorted(chip.glob("power[0-9]*_average"))[:32]})
            for prefix, path in paths.items():
                raw = number(path)
                if raw is None or not 0 <= raw <= 1_000_000_000_000:
                    self.issue("A measured power sensor returned an unreadable or out-of-range value.")
                    continue
                label = read(chip / f"{prefix}_label", 120).strip() or prefix
                if len(power) < 32:
                    power.append({"name": self.label(f"{chip.name}/{prefix}/{driver}/{label}"), "watts": raw / 1_000_000, "source": "hwmon"})
        if not temperatures:
            self.issue("Temperature sensors are unavailable or unsupported on this hardware.")
        power.extend(self.powercap(maximum=32 - len(power)))
        if not power:
            self.issue("Measured power is unavailable; supported sensors or a second energy sample are required. CPU/package power is not whole-machine wall power.")
        return self.unique(temperatures), self.unique(power)

    def powercap(self, maximum):
        result, seen = [], set()
        pending = [(self.paths.sys / "class/powercap", 0)]
        while pending and len(seen) < 128 and len(result) < maximum:
            directory, depth = pending.pop(0)
            try:
                resolved = directory.resolve()
                if resolved in seen:
                    continue
                seen.add(resolved)
                energy = number(directory / "energy_uj")
                if depth < 3:
                    pending.extend((child, depth + 1) for child in sorted(directory.iterdir())[:64] if child.is_dir())
                if energy is None:
                    continue
            except OSError:
                continue
            if energy is None:
                continue
            key = str(directory.relative_to(self.paths.sys))
            limit = number(directory / "max_energy_range_uj")
            self.current["power"][key] = energy
            previous = self.previous.get("power", {}).get(key) if isinstance(self.previous.get("power"), dict) else None
            if self.elapsed is None or self.elapsed > 300 or type(previous) is not int or limit is None or not 0 <= energy <= limit or not 0 <= previous <= limit:
                continue
            delta = energy - previous if energy >= previous else energy + limit - previous
            watts = delta / (self.elapsed * 1_000_000)
            if math.isfinite(watts) and 0 <= watts <= 1_000_000:
                label = read(directory / "name", 120).strip() or directory.name
                result.append({"name": self.label(f"{directory.name}/{label}"), "watts": round(watts, 3), "source": "powercap"})
        return result

    def network(self):
        result = []
        names = set()
        old = self.previous.get("network", {})
        old = old if isinstance(old, dict) else {}
        for line in read(self.paths.proc / "net/dev", 32768).splitlines()[2:]:
            if ":" not in line:
                continue
            name, raw = line.split(":", 1)
            name, fields = name.strip(), raw.split()
            if name == "lo" or not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,120}", name) or len(fields) < 9:
                continue
            if name in names:
                self.issue("Duplicate network interface counters were omitted.")
                continue
            names.add(name)
            try:
                received, transmitted = int(fields[0]), int(fields[8])
                if not 0 <= received <= MAX_BYTES or not 0 <= transmitted <= MAX_BYTES:
                    continue
            except ValueError:
                continue
            before = old.get(name)
            rx = tx = None
            if self.elapsed and isinstance(before, list) and len(before) == 2 and all(type(v) is int for v in before):
                if received >= before[0] and transmitted >= before[1]:
                    rx = round((received - before[0]) / self.elapsed, 3)
                    tx = round((transmitted - before[1]) / self.elapsed, 3)
            self.current["network"][name] = [received, transmitted]
            result.append({"name": name, "receivedBytes": received, "transmittedBytes": transmitted,
                           "receiveBytesPerSecond": rx, "transmitBytesPerSecond": tx})
            if len(result) == 32:
                break
        if not result:
            self.issue("Network interface counters are unavailable.")
        return result

    def job(self, slot):
        """Root reads runner-owned metadata: no symlinks, devices, unbounded JSON or arbitrary keys."""
        try:
            flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(self.paths.run / slot / "job.json", flags)
            with os.fdopen(fd, encoding="utf-8") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
                    raise ValueError()
                value = json.loads(handle.read(8193))
            if not isinstance(value, dict):
                raise ValueError()
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, RecursionError):
            self.issue(f"Job identity metadata is unavailable or invalid for {slot}.")
            return {}
        now = self.clock.time()
        repository = value.get("repository")
        if not isinstance(repository, str) or len(repository) > 120 or not runner_job.REPOSITORY.fullmatch(repository) or any(part in (".", "..") for part in repository.split("/")):
            repository = None
        run_id, job = value.get("runId"), value.get("jobName")
        started, finished = valid_time(value.get("startedAt"), now), valid_time(value.get("finishedAt"), now)
        if started and finished and finished < started:
            finished = None
        result = value.get("result")
        return {"repository": repository, "runId": run_id if isinstance(run_id, str) and runner_job.RUN_ID.fullmatch(run_id) else None,
                "jobName": self.label(job) if isinstance(job, str) and runner_job.JOB_NAME.fullmatch(job) else None,
                "startedAt": started, "finishedAt": finished, "result": result if result in ("completed", "interrupted") else None}

    def runner_slots(self, identity):
        if identity["role"] != "ci":
            return [], []
        count, slots, busy = configured_slots(self.paths)
        if count is None:
            self.issue("Runner capacity has not been determined.")
            return [], []
        if not slots:
            return [], []
        code, output = self.command([self.paths.systemctl, "is-active", *[f"github-runner-{slot}.service" for slot in slots]], 5)
        states = output.splitlines()
        if code not in (0, 3, 4) or len(states) != len(slots) or any(state not in ("active", "inactive", "failed", "activating", "deactivating", "unknown") for state in states):
            self.issue("Runner service status could not be verified.")
            states = ["unknown"] * len(slots)
        result, logs = [], []
        for slot, state in zip(slots, states):
            details = self.job(slot)
            # The busy marker and best-effort metadata are separate writes.
            # Never attribute a new job to a previous completed run in that gap.
            active_details = {} if slot in busy and details.get("finishedAt") else details
            if slot in busy and not active_details.get("startedAt"):
                self.issue(f"Job identity is unavailable for busy runner {slot}.")
            result.append(dict({"slot": slot, "state": "busy" if slot in busy else "idle" if state == "active" else "offline",
                                "repository": None, "runId": None, "jobName": None, "startedAt": None, "finishedAt": None, "result": None}, **active_details))
            if details.get("startedAt"):
                logs.append({"at": details["startedAt"], "source": "runner:" + slot, "level": "info", "message": f"Runner {slot} started a job."})
            if details.get("finishedAt"):
                interrupted = details.get("result") == "interrupted"
                logs.append({"at": details["finishedAt"], "source": "runner:" + slot, "level": "warn" if interrupted else "info",
                             "message": f"Runner {slot} stopped before its completion hook." if interrupted else f"Runner {slot} completed its job hook; consult GitHub for the result."})
        return result, sorted(logs, key=lambda value: value["at"])[-40:]

    def collect(self, identity, failed_units=(), services_unknown=False):
        self.issues = []
        self.baseline()
        temperatures, power = self.sensors()
        slots, logs = self.runner_slots(identity)
        now = iso(self.clock.time())
        for unit in list(failed_units)[:10]:
            logs.append({"at": now, "source": "systemd", "level": "error", "message": f"Service {unit} is failed."})
        if services_unknown:
            self.issue("Failed-service status is unknown: systemd diagnostics could not be queried.")
        value = {"sampledAt": now, "cpuUsagePercent": self.cpu(), "filesystems": self.filesystems(), "temperatures": temperatures,
                 "power": power, "swap": self.swap(), "network": self.network(), "runnerSlots": slots, "logs": logs[-40:], "issues": self.issues}
        try:
            fleetconf.write_atomic(str(self.paths.state / "telemetry-state.json"), json.dumps(self.current, separators=(",", ":")), 0o600)
        except OSError:
            self.issue("Telemetry counter state could not be saved; derived rates may stay unknown.")
        # Keep well below the API's 64 KiB body limit even on sensor-rich hosts.
        while len(json.dumps(value, separators=(",", ":")).encode()) > 40000:
            for key in ("logs", "runnerSlots", "temperatures", "network", "power"):
                if value[key]:
                    value[key].pop()
                    break
            else:
                break
            self.issue("Telemetry was bounded to fit the heartbeat request budget.")
        return value
