"""Hardware health families for the heartbeat: GPU, disk I/O and health, CPU frequency, throttling, pressure.

Every family carries a provenance label and never a made-up value:

  measured     read from a kernel counter or a tool's own report
  estimated    inferred (for example throttling from a CPU frequency below its maximum)
  unsupported  this hardware or image cannot provide it; `reason` says why

A missing sensor is `unsupported` with a reason, an unknown value inside a
supported family is None, and nothing is ever reported as zero for lack of data.
Everything here only reads: /proc, /sys, `nvidia-smi --query-gpu` and
`smartctl -j -H -A -n standby`. It never writes to a device, starts a self-test
or wakes a sleeping disk. Paths and the command runner come from the Collector,
so tests use a fixture tree and fake command output.
"""
import csv
import json
import math
import re
from pathlib import Path

MEASURED, ESTIMATED, UNSUPPORTED = "measured", "estimated", "unsupported"
MAX_GPUS, MAX_DISKS, MAX_HEALTH, MAX_CPUS = 8, 16, 8, 256
THROTTLE_HOLD_SECONDS = 300
SECTOR_BYTES = 512
WHOLE_DISK = re.compile(r"(?:sd[a-z]{1,3}|hd[a-z]|vd[a-z]{1,3}|xvd[a-z]{1,3}|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)")
DECIMAL = re.compile(r"-?[0-9]{1,15}(?:\.[0-9]{1,6})?")
NVIDIA_PROGRAMS = ("nvidia-smi", "/run/current-system/sw/bin/nvidia-smi")
NVIDIA_QUERY = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
VENDORS = {"0x1002": "amd", "0x8086": "intel", "0x10de": "nvidia"}
SYSFS_STATES = {"offline": ("failing", "dead"), "dead": ("failing", "dead"), "blocked": ("warning", "blocked"),
                "connecting": ("warning", "connecting"), "resetting": ("warning", "resetting"),
                "deleting": ("warning", "deleting")}


def family(status, reason=None, **data):
    return dict({"status": status, "reason": reason[:500] if reason else None}, **data)


def unsupported(reason, **data):
    return family(UNSUPPORTED, reason, **data)


def read_text(path, limit=4096):
    try:
        with Path(path).open(encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except (OSError, ValueError):
        return ""


def integer(path):
    value = read_text(path, 64).strip()
    return int(value) if re.fullmatch(r"-?[0-9]{1,18}", value) else None


def decimal(text, low, high):
    """A finite number inside [low, high]; '[N/A]', 'nan', unit suffixes and out-of-range values are None."""
    text = str(text).strip()
    if not DECIMAL.fullmatch(text):
        return None
    value = float(text)
    return round(value, 3) if math.isfinite(value) and low <= value <= high else None


def whole_disks(paths):
    try:
        names = sorted(entry.name for entry in (paths.sys / "block").iterdir())
    except OSError:
        return []
    return [name for name in names if WHOLE_DISK.fullmatch(name)]


def first_hwmon(directory, name):
    """The first readable hwmon file `name` below a device directory (hwmon/hwmonN or hwmonN), or None."""
    for chip in sorted(directory.glob("hwmon/hwmon[0-9]*"))[:8] + sorted(directory.glob("hwmon[0-9]*"))[:8]:
        value = integer(chip / name)
        if value is not None:
            return value
    return None


# GPU --------------------------------------------------------------------------


def nvidia_devices(c):
    """(devices, problem). problem None means nvidia-smi is absent or answered; a failure is reported once."""
    problem = None
    for program in NVIDIA_PROGRAMS:
        code, output = c.command([program, f"--query-gpu={NVIDIA_QUERY}", "--format=csv,noheader,nounits"], 8)
        if code == 127:
            continue
        if code != 0:
            return [], f"nvidia-smi failed (exit {code}); NVIDIA GPU metrics are unavailable."
        devices = []
        for row in csv.reader(output.splitlines()[:MAX_GPUS]):
            device = nvidia_row([cell.strip() for cell in row], c.label)
            if device:
                devices.append(device)
            else:
                problem = "nvidia-smi returned a row that could not be understood and was skipped."
        return devices, problem
    return [], None


def nvidia_row(cells, label):
    if len(cells) != 7 or not re.fullmatch(r"[0-9]{1,3}", cells[0]):
        return None
    used, total = decimal(cells[3], 0, 1e9), decimal(cells[4], 0, 1e9)
    if used is None or total is None or used > total:
        used = total = None
    return {"name": label(f"nvidia{cells[0]}/{cells[1]}"), "vendor": "nvidia",
            "utilizationPercent": decimal(cells[2], 0, 100),
            "memoryUsedBytes": None if used is None else int(used * 1048576),
            "memoryTotalBytes": None if total is None else int(total * 1048576),
            "temperatureCelsius": decimal(cells[5], -100, 250), "powerWatts": decimal(cells[6], 0, 10000)}


def drm_device(card, vendor, label):
    device = card / "device"
    memory_used, memory_total = integer(device / "mem_info_vram_used"), integer(device / "mem_info_vram_total")
    if memory_used is None or memory_total is None or not 0 <= memory_used <= memory_total <= 2**53:
        memory_used = memory_total = None
    busy = integer(device / "gpu_busy_percent")
    temperature = first_hwmon(device, "temp1_input")
    power = first_hwmon(device, "power1_average")
    if power is None:
        power = first_hwmon(device, "power1_input")
    reading = {"utilizationPercent": busy if busy is not None and 0 <= busy <= 100 else None,
               "memoryUsedBytes": memory_used, "memoryTotalBytes": memory_total,
               "temperatureCelsius": temperature / 1000 if temperature is not None and -100000 <= temperature <= 250000 else None,
               "powerWatts": power / 1_000_000 if power is not None and 0 <= power <= 10_000_000_000 else None}
    if all(value is None for value in reading.values()):
        return None
    product = read_text(device / "product_name", 120).strip() or vendor
    return dict({"name": label(f"{card.name}/{product}"), "vendor": vendor}, **reading)


def drm_devices(c, nvidia_covered):
    devices, notes = [], []
    cards = [card for card in sorted((c.paths.sys / "class/drm").glob("card[0-9]*")) if re.fullmatch(r"card[0-9]+", card.name)]
    for card in cards[:MAX_GPUS]:
        vendor = VENDORS.get(read_text(card / "device/vendor", 16).strip().lower())
        if vendor is None:
            continue
        if vendor == "nvidia":
            if not nvidia_covered:
                notes.append("An NVIDIA GPU is present but nvidia-smi is not available, so its metrics are unsupported.")
            continue
        device = drm_device(card, vendor, c.label)
        if device:
            devices.append(device)
        else:
            notes.append(f"A {vendor.upper()} GPU is present but its driver exposes no utilization, memory, temperature or power in sysfs.")
    return devices, notes


def gpus(c):
    nvidia, problem = nvidia_devices(c)
    other, notes = drm_devices(c, bool(nvidia))
    devices = (nvidia + other)[:MAX_GPUS]
    notes = ([problem] if problem else []) + notes
    if devices:
        return family(MEASURED, " ".join(notes[:2]) or None, devices=devices)
    return unsupported(" ".join(notes[:2]) or "No GPU with readable metrics was detected.", devices=[])


# Disk I/O ---------------------------------------------------------------------


def disk_counters(c):
    result = {}
    for line in read_text(c.paths.proc / "diskstats", 65536).splitlines():
        parts = line.split()
        if len(parts) < 14 or not WHOLE_DISK.fullmatch(parts[2]) or not (c.paths.sys / "block" / parts[2]).exists():
            continue
        if not all(re.fullmatch(r"[0-9]{1,16}", parts[index]) for index in (3, 5, 7, 9, 12)):
            continue
        result[parts[2]] = [int(parts[index]) for index in (3, 5, 7, 9, 12)]
        if len(result) == MAX_DISKS:
            break
    return result


def disk_rates(now, before, elapsed):
    if not elapsed or not isinstance(before, list) or len(before) != 5 or not all(type(v) is int for v in before):
        return None
    if any(a < b for a, b in zip(now, before)):
        return None  # the counters were reset or wrapped: unknown, not negative
    reads, sectors_read, writes, sectors_written, busy_ms = (a - b for a, b in zip(now, before))
    return {"readBytesPerSecond": round(sectors_read * SECTOR_BYTES / elapsed, 3),
            "writeBytesPerSecond": round(sectors_written * SECTOR_BYTES / elapsed, 3),
            "iops": round((reads + writes) / elapsed, 3),
            "busyPercent": round(min(100.0, busy_ms / (elapsed * 10)), 2)}


def disk_io(c):
    counters = disk_counters(c)
    if not counters:
        return unsupported("No whole-disk I/O counters were found in /proc/diskstats.", devices=[])
    c.current["diskio"] = counters
    old = c.previous.get("diskio") if isinstance(c.previous.get("diskio"), dict) else {}
    empty = {"readBytesPerSecond": None, "writeBytesPerSecond": None, "iops": None, "busyPercent": None}
    devices = [dict({"name": name}, **(disk_rates(now, old.get(name), c.elapsed) or empty)) for name, now in counters.items()]
    known = any(device["busyPercent"] is not None for device in devices)
    return family(MEASURED, None if known else "Disk rates need a second counter sample (first sample, restart or counter reset).", devices=devices)


# Disk health --------------------------------------------------------------------


def smart_document(text):
    try:
        document = json.loads(text)
    except (ValueError, RecursionError):
        return None
    return document if isinstance(document, dict) else None


def smart_numbers(document):
    """(temperature, wear, hours, warnings) from an NVMe or ATA smartctl document; each may be None/empty."""
    nvme = document.get("nvme_smart_health_information_log")
    nvme = nvme if isinstance(nvme, dict) else {}
    table = (document.get("ata_smart_attributes") or {}).get("table") if isinstance(document.get("ata_smart_attributes"), dict) else None
    ata = {row.get("id"): row for row in table if isinstance(row, dict)} if isinstance(table, list) else {}
    warnings = []
    wear = nvme.get("percentage_used") if type(nvme.get("percentage_used")) is int and 0 <= nvme.get("percentage_used") <= 255 else None
    for attribute in (177, 231, 233):
        value = (ata.get(attribute) or {}).get("value")
        if wear is None and type(value) is int and 0 <= value <= 100:
            wear = 100 - value
    if type(nvme.get("critical_warning")) is int and nvme["critical_warning"] != 0:
        warnings.append(f"critical warning flags 0x{nvme['critical_warning'] & 0xFF:02x}")
    if type(nvme.get("media_errors")) is int and nvme["media_errors"] > 0:
        warnings.append("media errors reported")
    spare, floor = nvme.get("available_spare"), nvme.get("available_spare_threshold")
    if type(spare) is int and type(floor) is int and spare < floor:
        warnings.append("available spare below threshold")
    for attribute, text in ((5, "reallocated sectors"), (197, "pending sectors"), (198, "uncorrectable sectors")):
        raw = ((ata.get(attribute) or {}).get("raw") or {}).get("value") if isinstance(ata.get(attribute), dict) and isinstance((ata.get(attribute) or {}).get("raw"), dict) else None
        if type(raw) is int and raw > 0:
            warnings.append(text)
    if wear is not None and wear >= 90:
        warnings.append(f"{wear}% of rated endurance used")
    temperature = (document.get("temperature") or {}).get("current") if isinstance(document.get("temperature"), dict) else None
    if not (type(temperature) is int and -100 <= temperature <= 250):
        temperature = nvme.get("temperature") if type(nvme.get("temperature")) is int and -100 <= nvme["temperature"] <= 250 else None
    hours = (document.get("power_on_time") or {}).get("hours") if isinstance(document.get("power_on_time"), dict) else None
    return temperature, wear, hours if type(hours) is int and 0 <= hours <= 10_000_000 else None, warnings


def smart_device(name, document):
    status = document.get("smart_status")
    passed = status.get("passed") if isinstance(status, dict) else None
    temperature, wear, hours, warnings = smart_numbers(document)
    if passed is False:
        state, detail = "failing", "SMART overall health assessment reports failure."
    elif passed is True:
        state = "warning" if warnings else "ok"
        detail = "; ".join(warnings) or None
    else:
        state, detail = "unknown", "smartctl returned no health assessment (device asleep, unsupported or access denied)."
    return {"name": name, "state": state, "source": "smartctl", "temperatureCelsius": temperature,
            "wearPercent": wear, "powerOnHours": hours, "detail": detail[:200] if detail else None}


def sysfs_device(c, name):
    device = c.paths.sys / "block" / name / "device"
    state = read_text(device / "state", 32).strip().lower()
    mapped = SYSFS_STATES.get(state)
    temperature = first_hwmon(device, "temp1_input")
    return {"name": name, "state": mapped[0] if mapped else "unknown", "source": "sysfs",
            "temperatureCelsius": temperature / 1000 if temperature is not None and -100000 <= temperature <= 250000 else None,
            "wearPercent": None, "powerOnHours": None,
            "detail": f"Kernel device state: {mapped[1]}." if mapped else None}


def disk_health(c):
    names = whole_disks(c.paths)[:MAX_HEALTH]
    if not names:
        return unsupported("No whole-disk block devices were found.", devices=[])
    deadline = c.clock.monotonic() + 20
    dev = getattr(c.paths, "dev", Path("/dev"))
    devices, missing = [], False
    for name in names:
        document = None
        if not missing and c.clock.monotonic() < deadline:
            code, output = c.command(["smartctl", "-j", "-H", "-A", "-n", "standby", str(dev / name)], 8)
            missing = code == 127
            document = None if missing else smart_document(output)
        devices.append(smart_device(name, document) if document is not None else sysfs_device(c, name))
    if missing:
        return family(ESTIMATED, "smartctl is not installed; only the kernel's device state is available and SMART health is unknown.", devices=devices)
    return family(MEASURED, None, devices=devices)


# CPU frequency and throttling ---------------------------------------------------


def cpu_dirs(paths):
    root = paths.sys / "devices/system/cpu"
    try:
        found = sorted((entry for entry in root.iterdir() if re.fullmatch(r"cpu[0-9]+", entry.name)),
                       key=lambda entry: int(entry.name[3:]))
    except OSError:
        return []
    return found[:MAX_CPUS]


def cpu_frequency(c):
    current, minimum, maximum = [], [], []
    for cpu in cpu_dirs(c.paths):
        for target, names in ((current, ("scaling_cur_freq",)), (minimum, ("cpuinfo_min_freq", "scaling_min_freq")),
                              (maximum, ("cpuinfo_max_freq", "scaling_max_freq"))):
            for name in names:
                value = integer(cpu / "cpufreq" / name)
                if value is not None and 0 < value <= 20_000_000:
                    target.append(value / 1000)
                    break
    if not current:
        return unsupported("cpufreq is not exposed (virtual machine or a driver without frequency scaling).",
                           currentMHz=None, minMHz=None, maxMHz=None)
    return family(MEASURED, None, currentMHz=round(sum(current) / len(current), 1),
                  minMHz=min(minimum) if minimum else None, maxMHz=max(maximum) if maximum else None)


def throttle_counters(c):
    cores, packages = [], []
    for cpu in cpu_dirs(c.paths):
        core = integer(cpu / "thermal_throttle/core_throttle_count")
        package = integer(cpu / "thermal_throttle/package_throttle_count")
        if core is not None and core >= 0:
            cores.append(core)
        if package is not None and package >= 0:
            packages.append(package)
    return (sum(cores), max(packages) if packages else 0) if cores or packages else None


def measured_throttling(c, counters):
    now = c.clock.monotonic()
    before = c.previous.get("throttle") if isinstance(c.previous.get("throttle"), dict) else {}
    old = [before.get("core"), before.get("package")]
    last = before.get("last") if type(before.get("last")) in (int, float) and math.isfinite(before.get("last")) else None
    events = None
    if all(type(v) is int for v in old) and counters[0] >= old[0] and counters[1] >= old[1]:
        events = counters[0] - old[0] + counters[1] - old[1]
        if events:
            last = now
    c.current["throttle"] = {"core": counters[0], "package": counters[1], "last": last}
    held = last is not None and 0 <= now - last < THROTTLE_HOLD_SECONDS
    if events is None and not held:
        return family(MEASURED, "Throttle events need a second counter sample (first sample, restart or counter reset).",
                      throttled=None, events=None, basis="thermal_throttle")
    return family(MEASURED, "Counts thermal throttling only; power-limit throttling is not visible here.",
                  throttled=bool(events) or held, events=events, basis="thermal_throttle")


def throttling(c, cpu_percent, frequency):
    counters = throttle_counters(c)
    if counters is not None:
        return measured_throttling(c, counters)
    current, maximum = frequency.get("currentMHz"), frequency.get("maxMHz")
    if frequency["status"] != MEASURED or current is None or not maximum:
        return unsupported("No thermal-throttle counters or CPU frequency scaling are exposed.",
                           throttled=None, events=None, basis=None)
    reason = "No throttle counters: inferred from a CPU frequency below its maximum under load, which can also be a power-saving governor."
    if cpu_percent is None:
        return family(ESTIMATED, reason + " Waiting for a CPU utilization sample.", throttled=None, events=None, basis="frequency")
    return family(ESTIMATED, reason, throttled=cpu_percent >= 80 and current < 0.7 * maximum, events=None, basis="frequency")


# Memory, CPU and I/O pressure ---------------------------------------------------

PRESSURE_LINE = re.compile(r"(some|full) avg10=([0-9]{1,3}(?:\.[0-9]{1,2})?) avg60=([0-9]{1,3}(?:\.[0-9]{1,2})?)")


def pressure_file(path):
    result = {"someAvg10": None, "someAvg60": None, "fullAvg10": None, "fullAvg60": None}
    for line in read_text(path, 1024).splitlines():
        found = PRESSURE_LINE.match(line)
        if not found:
            continue
        for suffix, text in (("10", found.group(2)), ("60", found.group(3))):
            result[f"{found.group(1)}Avg{suffix}"] = decimal(text, 0, 100)
    return result if any(value is not None for value in result.values()) else None


def pressure(c):
    values = {name: pressure_file(c.paths.proc / "pressure" / name) for name in ("cpu", "memory", "io")}
    if all(value is None for value in values.values()):
        return unsupported("Pressure stall information (PSI) is not available in this kernel.", cpu=None, memory=None, io=None)
    return family(MEASURED, None, **values)


# Connectivity and lifecycle -------------------------------------------------------


def connectivity(c):
    latency, failures = c.round_trip_ms, c.consecutive_failures
    if not (type(latency) in (int, float) and math.isfinite(latency) and 0 <= latency <= 3_600_000):
        latency = None
    if type(failures) is not int or not 0 <= failures <= 1_000_000:
        failures = None
    if latency is None and failures is None:
        return unsupported("No heartbeat round trip has been measured yet.", controllerLatencyMs=None, consecutiveFailures=None)
    return family(MEASURED, "Latency is the previous heartbeat round trip to the controller." if latency is not None else
                  "No heartbeat has completed yet; latency is unknown.",
                  controllerLatencyMs=None if latency is None else round(latency, 1), consecutiveFailures=failures)


def lifecycle(c):
    uptime = read_text(c.paths.proc / "uptime", 64).split()
    seconds = decimal(uptime[0], 0, 10**9) if uptime else None
    return {"uptimeSeconds": None if seconds is None else int(seconds), "restartCount": c.restarts, "trackedSince": c.tracked_since}
