#!/usr/bin/env python3
"""Decisions for adding or removing one fleet node.

The downloadable entry is this program. It does not clone a repository,
install Nix, or call GitHub's expiring Actions artifact API. Disk writes,
reboots, and runner calls go through replaceable commands.
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import platform
import re
import select
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

# The active roles in roles.json. This file is bundled into fleet-node.sh and
# runs with no checkout, so it keeps a copy: scripts/fleet_roles.py sync
# rewrites the next line and its check fails while the copy is stale.
ROLES = ("ci", "devbox")
# The roles as prose for prompts: "ci or devbox", "a, b, or c".
ROLE_CHOICES = ROLES[0] if len(ROLES) == 1 else ", ".join(ROLES[:-1]) + ("," if len(ROLES) > 2 else "") + " or " + ROLES[-1]
# Only this role registers GitHub runners, so only it withdraws them on removal.
RUNNER_ROLE = "ci"
TRAN_RANK = {"nvme": 0, "sata": 1, "ata": 1, "sas": 2, "scsi": 2, "virtio": 3}
BUS_NAME = {
    "nvme": "NVMe",
    "sata": "SATA",
    "ata": "SATA",
    "sas": "SAS",
    "scsi": "SCSI",
    "virtio": "virtio",
    "usb": "USB",
}
# The release asset does not expire. The Fleet workflow's fleet-installer
# artifact still lasts 14 days; this program does not download that copy.
RELEASE_ISO = "https://github.com/crvouga/fleet/releases/download/fleet-installer/fleet-installer.iso"
DEVICE_RE = re.compile(r"^/dev/[A-Za-z0-9._/:-]+$")
WINDOWS_RE = re.compile(r"^\\\\\.\\PHYSICALDRIVE[0-9]+$")
TB = 1000 ** 4
GB = 1000 ** 3
SECTOR = 2048
# The shell initrd can mount these and honor findiso=. NTFS and APFS cannot.
SAFE_ISO_FS = frozenset({"ext2", "ext3", "ext4", "btrfs", "xfs", "vfat"})
# Win32_DiskDrive.BusType is a uint16. [string] on the live value is the digit.
WINDOWS_BUS = {
    "17": "nvme",
    "11": "sata",
    "7": "usb",
    "10": "sas",
    "3": "ata",
    "2": "ata",
    "1": "scsi",
}


# Every run writes a timestamped log. Secrets are redacted before they reach
# the screen or the file, so the log can be pasted anywhere.
LOG = {"path": None}
# Set by the wizard's helper before a handoff: {"attempt": ..., "wizard": ...}.
HANDOFF = {}
LOG_KEEP = 20
SECRET_RE = re.compile(
    r"AGE-SECRET-KEY-\S+"
    r"|\bhv[sbr]\.[A-Za-z0-9._-]+"
    r"|(?i:x-vault-token:)\s*\S+"
    r"|(?i:fleet\.enroll=|FLEET_ENROLL_TOKEN=)\S+"
    r"|--token(?:=|\s+)\S+"
    r"|\bgh[opsur]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}"
    r"|\b[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)[A-Z0-9_]*=\S+"
)


def redact(text):
    return SECRET_RE.sub("[redacted]", str(text))


def _stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(message, level="INFO"):
    path = LOG["path"]
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as handle:
            for line in redact(message).splitlines() or [""]:
                handle.write(f"{_stamp()} {level} {line}\n")
    except OSError:
        pass


def start_log(argv):
    """Open this run's log. Falls back to the temp directory when the state
    directory is not writable. A missing log never stops the run."""
    stamp = _stamp().replace(":", "").replace("-", "")
    for base in (state_dir() / "logs", Path(tempfile.gettempdir()) / "fleet-node-logs"):
        try:
            base.mkdir(parents=True, exist_ok=True)
            path = base / f"fleet-node-{stamp}-{os.getpid()}.log"
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
        except OSError:
            continue
        LOG["path"] = str(path)
        for old in sorted(base.glob("fleet-node-*.log"))[:-LOG_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass
        break
    LOG["command"] = argv[0] if argv and re.fullmatch(r"[a-z-]{1,20}", argv[0]) else "install"
    log(f"fleet-node {' '.join(argv)}")
    log(f"os={current_os()} arch={machine_arch()} python={platform.python_version()} euid={effective_uid()} cwd={os.getcwd()}")
    knobs = sorted(f"{k}={v}" for k, v in os.environ.items() if k.startswith("FLEET_"))
    log("env " + " ".join(knobs) if knobs else "env (no FLEET_ variables)")


class Invariant(Exception):
    """A fact this program relies on is false, so continuing could corrupt a
    disk or a state file. Raised, never swallowed: only main() catches it, logs
    it, and stops with exit code 71 and the fix."""

    def __init__(self, what, fix, context):
        super().__init__(what)
        self.what = what
        self.fix = fix
        self.context = context


def invariant(condition, what, fix="Run `fleet-node doctor` and read the log; do not retry blindly.", **context):
    """Always-on assertion (unlike `assert`, `python -O` cannot remove it). It
    states a fact, names the thing that broke, carries the values that make the
    failure diagnosable, and says what to do about it."""
    if condition:
        return
    raise Invariant(what, fix, {key: redact(repr(value)) for key, value in sorted(context.items())})


def say(message):
    print(redact(message), file=sys.stderr)
    log(message)
    if str(message).startswith("Next:"):
        LOG["next"] = redact(str(message))[len("Next:"):].strip()
    sink = LOG.get("sink")
    if sink:
        sink(redact(message))


def fail(message, code=1):
    say(message)
    if LOG["path"]:
        print(f"Log: {LOG['path']}", file=sys.stderr)
        # A refusal or failure always ends with a way to tell someone. Not logged:
        # the wizard has its own Report on GitHub button for the same run.
        print(report_link(message, LOG.get("command") or "install"), file=sys.stderr)
    return code


def run_logged(command, **kwargs):
    """subprocess.run that records the command, its exit code, and the tail of
    anything it printed."""
    log("run " + " ".join(str(part) for part in command))
    started = datetime.datetime.now()
    completed = subprocess.run(command, check=False, **kwargs)
    seconds = (datetime.datetime.now() - started).total_seconds()
    log(f"exit {completed.returncode} after {seconds:.1f}s")
    for stream in (completed.stdout, completed.stderr):
        if isinstance(stream, str) and stream.strip():
            log("output " + stream.strip()[-800:])
    return completed


def flag(value):
    if value is True:
        return True
    if value in (False, None, "", 0, "0"):
        return False
    if isinstance(value, str) and value.strip().lower() in ("false", "no"):
        return False
    try:
        return int(value) != 0
    except (TypeError, ValueError):
        return bool(value)


def size_label(size):
    try:
        number = int(size)
    except (TypeError, ValueError):
        return "0 bytes"
    if number >= TB:
        whole, rem = divmod(number, TB)
        return f"{whole}.{rem // (TB // 10)} TB"
    if number >= GB:
        whole, rem = divmod(number, GB)
        return f"{whole}.{rem // (GB // 10)} GB"
    return f"{number} bytes"


def plain_name(disk):
    model = (disk.get("model") or "disk").strip() or "disk"
    size = size_label(disk.get("size") or 0)
    if disk.get("usb") or disk.get("rm"):
        return f"USB disk, {size}, {model}"
    bus = BUS_NAME.get(disk.get("tran") or "", "disk")
    return f"internal {bus}, {size}, {model}"


def disk_id(disk):
    serial = re.sub(r"\s+", "", str(disk.get("serial") or "")).lower()
    if serial:
        basis = serial
    else:
        basis = "|".join([
            str(disk.get("model") or ""),
            str(disk.get("size") or ""),
            str(disk.get("tran") or ""),
        ])
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


def device_ok(path):
    return bool(DEVICE_RE.fullmatch(path or "") or WINDOWS_RE.fullmatch(path or ""))


def mounted_tree(device):
    points = device.get("mountpoints") or []
    if any(point for point in points):
        return True
    return any(mounted_tree(child) for child in device.get("children") or [])


def parse_lsblk(raw):
    data = json.loads(raw)
    disks = []
    for device in data.get("blockdevices") or []:
        if device.get("type") != "disk":
            continue
        tran = str(device.get("tran") or "").lower()
        usb = tran == "usb"
        disks.append({
            "path": str(device.get("path") or ""),
            "tran": tran,
            "rm": flag(device.get("rm")),
            "hotplug": flag(device.get("hotplug")) or usb,
            "usb": usb,
            "internal": tran in TRAN_RANK and not usb,
            "mounted": mounted_tree(device),
            "whole": True,
            "size": device.get("size") or 0,
            "model": str(device.get("model") or "").strip(),
            "serial": str(device.get("serial") or "").strip(),
        })
    return disks


def _info_map(text):
    fields = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip().lower()] = value.strip()
    return fields


def _yes(fields, key):
    return fields.get(key, "").lower().startswith("y")


def _removable_phrase(value):
    """diskutil prints Yes/No in fixtures and Fixed/Removable on a live Mac."""
    text = str(value or "").strip().lower()
    return text in {"yes", "true", "removable"} or text.startswith("y")


def _mounted_phrase(value):
    """Yes is mounted. No and 'Not applicable (no file system)' are not."""
    text = str(value or "").strip().lower()
    if not text or text.startswith("n"):
        return False
    return text.startswith("y") or text == "mounted" or text == "true"


def parse_diskutil_info(text):
    fields = _info_map(text)
    protocol_l = fields.get("protocol", "").lower()
    location = fields.get("device location", "").lower()
    virtual = _yes(fields, "virtual")
    internal = _yes(fields, "internal") or location == "internal"
    removable = _removable_phrase(fields.get("removable media", ""))
    # Apple silicon diskutil names the internal SSD "Apple Fabric", not PCI-Express.
    usb = "usb" in protocol_l or (removable and not internal)
    hotplug = usb or _yes(fields, "hotplug") or location in ("external", "hotplug")
    if "nvme" in protocol_l or "pci" in protocol_l or "apple fabric" in protocol_l:
        tran = "nvme"
    elif "sata" in protocol_l or "ata" in protocol_l:
        tran = "sata"
    elif usb:
        tran = "usb"
    elif "sas" in protocol_l:
        tran = "sas"
    elif "scsi" in protocol_l or "virtio" in protocol_l:
        tran = "scsi"
    else:
        tran = "other"
    size = 0
    match = re.search(r"\((\d+) Bytes\)", fields.get("disk size", ""))
    if match:
        size = int(match.group(1))
    path = fields.get("device node", "")
    return {
        "path": path,
        "tran": tran,
        "rm": removable or usb,
        "hotplug": hotplug,
        "usb": usb,
        "internal": internal and not usb and not virtual,
        "mounted": _mounted_phrase(fields.get("mounted", "")),
        "whole": _yes(fields, "whole") or not fields.get("whole"),
        "size": size,
        "model": fields.get("device / media name", "").strip(),
        "serial": fields.get("serial number", "").strip(),
        "virtual": virtual,
    }


def _windows_mounted(device):
    """Mounted means a logical volume is attached. A boolean is not the query."""
    volumes = device.get("Volumes", None)
    if volumes is None:
        volumes = device.get("volumes")
    if isinstance(volumes, str):
        return bool(volumes.strip())
    if isinstance(volumes, (list, tuple)):
        return any(str(item or "").strip() for item in volumes)
    return False


def parse_windows(raw):
    data = json.loads(raw)
    if isinstance(data, dict):
        data = [data]
    disks = []
    for device in data:
        interface = str(device.get("InterfaceType") or "")
        bus_value = device.get("BusType")
        if bus_value is None or str(bus_value).strip() == "":
            bus = interface.strip()
        else:
            bus = str(bus_value).strip()
        media = str(device.get("MediaType") or "")
        pnp = str(device.get("PNPDeviceID") or "")
        bus_l = bus.lower()
        coded = WINDOWS_BUS.get(bus_l)
        usb = coded == "usb" or "usb" in bus_l or "usb" in pnp.lower() or "removable" in media.lower()
        if coded and coded != "usb":
            tran = coded
        elif "nvme" in bus_l:
            tran = "nvme"
        elif "sata" in bus_l or "ata" in bus_l or "ide" in bus_l:
            tran = "sata"
        elif "sas" in bus_l:
            tran = "sas"
        elif usb:
            tran = "usb"
        elif "scsi" in bus_l:
            tran = "scsi"
        else:
            tran = "other"
        path = str(device.get("DeviceID") or "")
        disks.append({
            "path": path,
            "tran": tran,
            "rm": usb or "removable" in media.lower(),
            "hotplug": usb or flag(device.get("Hotplug")),
            "usb": usb,
            "internal": not usb and tran in TRAN_RANK and "removable" not in media.lower(),
            "mounted": _windows_mounted(device),
            "whole": True,
            "size": device.get("Size") or 0,
            "model": str(device.get("Model") or "").strip(),
            "serial": str(device.get("SerialNumber") or "").strip(),
        })
    return disks


def _run(command):
    completed = subprocess.run(command, check=False, capture_output=True, text=True, errors="replace", stdin=subprocess.DEVNULL)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(detail or f"{command[0]} failed")
    return completed.stdout


def collect(os_name):
    # Test seam with no shell stubs, so it works on every OS: a JSON list of
    # disks in the parsed shape. It replaces the OS query entirely.
    canned = os.environ.get("FLEET_DISKS_FILE")
    if canned:
        return json.loads(Path(canned).read_text(encoding="utf-8"))
    if os_name == "Linux":
        tool = os.environ.get("FLEET_LSBLK", "lsblk")
        raw = _run([
            tool, "--json", "--bytes", "--paths", "--output",
            "PATH,TYPE,TRAN,RM,HOTPLUG,SIZE,MODEL,SERIAL,MOUNTPOINTS",
        ])
        return parse_lsblk(raw)
    if os_name == "Darwin":
        tool = os.environ.get("FLEET_DISKUTIL", "diskutil")
        listing = _run([tool, "list"])
        nodes = re.findall(r"^(/dev/disk[0-9]+)\b", listing, re.M)
        disks = []
        for node in nodes:
            info = _run([tool, "info", node])
            parsed = parse_diskutil_info(info)
            if parsed.get("virtual"):
                continue
            if not parsed["path"]:
                parsed["path"] = node
            disks.append(parsed)
        return disks
    if os_name == "Windows":
        tool = powershell_tool()
        script = ps_disks_script()
        raw = _run([tool, "-NoProfile", "-Command", script])
        return parse_windows(raw)
    raise RuntimeError(f"unsupported operating system {os_name}")


def install_block(disk):
    if not disk.get("whole"):
        return "partition"
    if not device_ok(disk.get("path") or ""):
        return "path"
    if disk.get("usb") or disk.get("tran") == "usb":
        return "usb"
    if disk.get("rm"):
        return "removable"
    if disk.get("hotplug"):
        return "hotplug"
    # A mounted internal disk is not a reason to refuse. On Linux and Windows
    # the disk holding the running system is always mounted, and converting a
    # running machine is the point. The installer reboots into RAM before it
    # touches the disk. USB, removable and hotplug disks are refused above.
    if disk.get("tran") not in TRAN_RANK or not disk.get("internal"):
        return "external"
    return None


def media_block(disk):
    if not disk.get("whole"):
        return "partition"
    if not device_ok(disk.get("path") or ""):
        return "path"
    if disk.get("internal") and not disk.get("usb") and not disk.get("rm"):
        return "internal"
    if disk.get("mounted"):
        return "mounted"
    if not (disk.get("usb") or disk.get("rm")):
        return "not-removable"
    return None


def plan_disks(disks, action):
    block = install_block if action == "install" else media_block
    eligible = []
    reasons = []
    for disk in disks:
        reason = block(disk)
        if reason is None:
            eligible.append(disk)
        else:
            reasons.append(reason)
    if len(eligible) == 1:
        chosen = eligible[0]
        invariant(block(chosen) is None, "plan_disks chose a disk its own rules refuse", disk=chosen)
        return {
            "ok": True,
            "plain": plain_name(chosen),
            "disk_id": disk_id(chosen),
            "path": chosen["path"],
            "disk": chosen,
        }
    if len(eligible) > 1:
        if action == "install":
            message = "Next: more than one internal disk was found. Disconnect the extra disk and run this program again. Nothing was written."
        else:
            message = "Next: more than one USB disk was found. Unplug the extra one and run this program again. Nothing was written."
        return {"ok": False, "next": message, "code": 2}
    if action == "install":
        if "hotplug" in reasons:
            message = "Next: the only disk is hotplug. Use the fixed internal disk and run this program again. Nothing was written."
        elif "removable" in reasons or "usb" in reasons:
            message = "Next: this program will not install a role onto a USB or removable disk. Connect the internal disk and run this program again. Nothing was written."
        elif "external" in reasons:
            message = "Next: no fixed internal disk was found. Connect that disk and run this program again. Nothing was written."
        else:
            message = "Next: no internal disk can be erased. Connect the internal disk and run this program again. Nothing was written."
    elif "internal" in reasons:
        message = "Next: refusing to write the installer onto an internal disk. Plug in one USB disk and run this program again. Nothing was written."
    elif "mounted" in reasons:
        message = "Next: the USB disk is mounted. Unmount it and run this program again. Nothing was written."
    else:
        message = "Next: no USB disk was found. Plug in one USB disk and run this program again. Nothing was written."
    return {"ok": False, "next": message, "code": 2}


def role_error(role):
    if role == "ci-gpu":
        return f"Next: ci-gpu is not on the shared installer. Choose {ROLE_CHOICES}. Nothing was written."
    if role not in ROLES:
        return f"Next: the role must be {ROLE_CHOICES}. Nothing was written."
    return None


def confirm(role, plain, answer, timed_out):
    if timed_out:
        return "Next: no answer arrived in time. Nothing was written. Run this program again and stay at the keyboard."
    if answer.strip() == "":
        return "Next: the confirmation was empty. Nothing was written. Run this program again and type the line this program shows."
    expected = f"{role}: {plain}"
    if answer.strip() != expected:
        return "Next: the confirmation did not match. Nothing was written. Run this program again and type the line exactly."
    return None


def removal_plan(busy, credential, withdrawn, role):
    """Never stop a running job. stop_job is always false."""
    if busy:
        if not credential:
            return {
                "action": "refuse",
                "code": 1,
                "stop_job": False,
                "power_off": False,
                "next": "Next: a job is running and this machine has no credential to withdraw itself. Leave the machine on.",
            }
        return {
            "action": "hold",
            "code": 0,
            "stop_job": False,
            "power_off": False,
            "next": "Next: a job is still running. This machine was not stopped. Leave it on and run this program again when the job has finished.",
        }
    if withdrawn:
        return {"action": "noop", "code": 0, "stop_job": False, "power_off": True, "next": ""}
    if role in ROLES and role != RUNNER_ROLE:
        return {"action": "retire", "code": 0, "stop_job": False, "power_off": True, "next": ""}
    if not credential:
        return {
            "action": "refuse",
            "code": 1,
            "stop_job": False,
            "power_off": False,
            "next": "Next: no credential is on this machine, so this program did not withdraw it. Restore the runner key that is already kept on this machine, then run this program again.",
        }
    return {"action": "withdraw", "code": 0, "stop_job": False, "power_off": True, "next": ""}


def _host_is_windows():
    """Win32 CPython has no os.uname. Classify before calling it."""
    if os.name == "nt":
        return True
    platform = str(getattr(sys, "platform", "")).lower()
    return platform.startswith(("win", "cygwin", "msys", "mingw"))


def current_os():
    override = os.environ.get("FLEET_OS")
    if override:
        if override in ("Windows", "MINGW", "MSYS", "CYGWIN"):
            return "Windows"
        if override == "Darwin":
            return "Darwin"
        if override == "Linux":
            return "Linux"
        return override
    if _host_is_windows():
        return "Windows"
    uname = getattr(os, "uname", None)
    if uname is None:
        return "unknown"
    try:
        name = uname().sysname
    except AttributeError:
        return "unknown"
    if name.startswith(("MINGW", "MSYS", "CYGWIN")):
        return "Windows"
    return name


def state_dir():
    chosen = os.environ.get("FLEET_STATE")
    if chosen:
        return Path(chosen)
    nix = Path("/nix/fleet-state")
    if nix.is_dir():
        return nix
    return Path.home() / ".fleet"


def read_kv(path):
    data = {}
    file = Path(path)
    if not file.is_file():
        return data
    for line in file.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key == "target":
            data.setdefault("targets", []).append(value)
        else:
            data[key] = value
    return data


def marker_text(path):
    file = Path(path)
    if not file.is_file():
        return {}
    return read_kv(file)


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)
    invariant(path.read_text(encoding="utf-8") == text, "a state file does not read back as written", file=str(path))


MARKER_STATUS = {"installed": ("role", "status"), "withdrawn": ("status",)}


def checked_marker(directory, name):
    """Read a state marker, or {} when there is none. A marker that exists but
    is malformed is corruption: it decides whether a disk is wiped, so it is
    never guessed at."""
    path = Path(directory) / name
    if not path.is_file():
        return {}
    marker = marker_text(path)
    fix = f"Look at {path}. If this machine is meant to be reinstalled or rejoined, delete that file and run this program again."
    invariant(marker.get("status") == name, f"state marker {name} is malformed", fix, file=str(path), found=marker)
    for key in MARKER_STATUS[name]:
        invariant(key in marker, f"state marker {name} lacks {key}", fix, file=str(path), found=marker)
    if name == "withdrawn" and marker.get("role") == "unknown":
        # Older `fleet-remove` runs wrote this when node.conf named no role. The marker only
        # says the runner is withdrawn; an unknown role is no corruption, so it is not refused.
        log(f"state marker {name} names role=unknown (written by an older version); reading it without a role", "WARN")
        marker = {key: value for key, value in marker.items() if key != "role"}
    if "role" in marker:
        invariant(marker["role"] in ROLES, f"state marker {name} names an unknown role", fix, file=str(path), role=marker["role"])
    return marker


def installed_for(role, directory):
    invariant(role in ROLES, "installed_for was asked about a role that does not exist", role=role)
    marker = checked_marker(directory, "installed")
    # A withdrawn runner can be recovered by a full reinstall, including back
    # into CI after a failed boot handoff. Its old marker is not a healthy node.
    withdrawn = checked_marker(directory, "withdrawn")
    return bool(marker) and marker["role"] == role and not withdrawn


def _read_line_timed(seconds):
    """Wait without select. Win32 raises OSError on console stdin."""
    holder = {}

    def _read():
        try:
            holder["line"] = sys.stdin.readline()
        except Exception as exc:
            holder["error"] = exc

    worker = threading.Thread(target=_read, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        return "", True
    if "error" in holder:
        raise holder["error"]
    line = holder.get("line", "")
    if line == "":
        return "", False
    return line.rstrip("\n"), False


def read_answer(timeout):
    try:
        seconds = int(timeout)
    except (TypeError, ValueError):
        seconds = 120
    if seconds < 1:
        seconds = 1
    # FLEET_STDIN_WAIT=windows exercises this branch on hosts that are not Windows.
    if os.name == "nt" or os.environ.get("FLEET_STDIN_WAIT") == "windows":
        return _read_line_timed(seconds)
    try:
        ready, _, _ = select.select([sys.stdin], [], [], seconds)
    except OSError:
        return _read_line_timed(seconds)
    if not ready:
        return "", True
    line = sys.stdin.readline()
    if line == "":
        return "", False
    return line.rstrip("\n"), False


def installer_urls():
    iso = os.environ.get("FLEET_INSTALLER_URL") or RELEASE_ISO
    checksum = os.environ.get("FLEET_INSTALLER_SHA256_URL") or (iso + ".sha256")
    return iso, checksum


def curl_to(url, dest, keep=True):
    """Download url to dest. With keep=False only the download happens (an installer is
    gigabytes; nothing here may hold it in memory)."""
    tool = os.environ.get("FLEET_CURL", "curl")
    completed = run_logged(
        [tool, "-fsSL", "--retry", "3", "-o", str(dest), url],
        capture_output=True,
        text=True,
        errors="replace",
        stdin=subprocess.DEVNULL,
    )
    if completed.returncode != 0:
        reason = (completed.stderr or "").strip().splitlines()
        raise RuntimeError(reason[-1] if reason else f"curl exited {completed.returncode}")
    return Path(dest).read_bytes() if keep else None


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installer_parts(url):
    """Read the bounded multipart manifest; asset names cannot leave this release."""
    with urllib.request.urlopen(url + ".parts.json", timeout=30) as reply:
        raw = reply.read(65537)
    invariant(len(raw) <= 65536, "the installer parts manifest is too large")
    try:
        document = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError("the installer parts manifest is not JSON") from exc
    invariant(isinstance(document, dict) and document.get("version") == 1,
              "the installer parts manifest has an unsupported format", NEWER_RELEASE_FIX,
              version=document.get("version") if isinstance(document, dict) else None)
    parts = document.get("parts")
    invariant(isinstance(parts, list) and 0 < len(parts) <= 128,
              "the installer parts manifest has an invalid part count")
    for index, part in enumerate(parts):
        invariant(isinstance(part, dict), "an installer part is not an object")
        invariant(part.get("name") == f"fleet-installer.iso.part-{index:03d}",
                  "an installer part has an unexpected name", part=index)
        invariant(type(part.get("size")) is int and 0 < part["size"] < 2 * 1024 ** 3,
                  "an installer part has an invalid size", part=index)
        invariant(isinstance(part.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", part["sha256"]),
                  "an installer part has an invalid checksum", part=index)
    invariant(type(document.get("size")) is int and document["size"] == sum(p["size"] for p in parts),
              "the installer parts do not add up to the image size")
    invariant(isinstance(document.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", document["sha256"]),
              "the installer parts manifest has an invalid image checksum")
    return document


def stream_installer_parts(url, out, progress=None, check_cancel=None):
    """Assemble into the caller's partial file, keeping just one block in memory."""
    document = installer_parts(url)
    digest = hashlib.sha256()
    written = 0
    for part in document["parts"]:
        if check_cancel:
            check_cancel()
        part_digest = hashlib.sha256()
        size = 0
        asset = urllib.parse.urljoin(url, part["name"])
        try:
            reply = urllib.request.urlopen(asset, timeout=30)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:  # publication deletes and re-uploads parts
                raise ReleaseChanging(f"installer part {part['name']} is missing; the release is probably being published") from exc
            raise
        with reply:
            while True:
                if check_cancel:
                    check_cancel()
                block = reply.read(4 * 1024 ** 2)
                if not block:
                    break
                size += len(block)
                if size > part["size"]:
                    raise ReleaseChanging(f"installer part {part['name']} is larger than its manifest says; the release is probably being published")
                out.write(block)
                part_digest.update(block)
                digest.update(block)
                written += len(block)
                if progress:
                    progress(written, document["size"])
        if size != part["size"] or part_digest.hexdigest() != part["sha256"]:
            # During publication new parts sit beside the old manifest for minutes. The
            # caller waits and starts again; a part that stays wrong ends that wait.
            raise ReleaseChanging(f"installer part {part['name']} does not match its manifest; the release is probably being published")
    invariant(digest.hexdigest() == document["sha256"], "the assembled installer does not match its checksum")
    return written, digest.hexdigest()


ISO_MAGIC_OFFSET = 32769  # "CD001" at sector 16 of an ISO9660 volume


def looks_like_iso(blob):
    return len(blob) >= ISO_MAGIC_OFFSET + 5 and blob[ISO_MAGIC_OFFSET:ISO_MAGIC_OFFSET + 5] == b"CD001"


def fetch_installer(dest):
    """Copy the durable installer to dest. Leave dest untouched on failure. The image is
    downloaded straight into dest's own folder (one copy on disk, not two) and is only
    streamed, never read into memory."""
    dest = Path(dest)
    iso_url, sum_url = installer_urls()
    dest.parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="fleet-fetch-"))
    staged = dest.with_suffix(dest.suffix + ".partial")
    try:
        sum_path = scratch / "sum"
        try:
            try:
                curl_to(iso_url, staged, keep=False)
            except (OSError, RuntimeError) as direct_error:
                for attempt in range(3):
                    try:
                        with open(staged, "wb") as out:
                            stream_installer_parts(iso_url, out)
                        break
                    except (OSError, RuntimeError) as multipart_error:
                        if attempt == 2:
                            raise RuntimeError(f"{direct_error}; multipart release: {multipart_error}") from multipart_error
                        wait = 30 if isinstance(multipart_error, ReleaseChanging) else 2 * (attempt + 1)
                        say(f"The download was interrupted ({multipart_error}). Trying again in {wait} seconds ({attempt + 2}/3).")
                        time.sleep(wait)
        except Invariant as broken:
            say(f"Why: {broken.what}")
            return fail(f"Next: {broken.fix}")
        except (OSError, RuntimeError) as exc:
            say(f"Why: {exc}")
            return fail("Next: the installer could not be downloaded. Check the network and run this program again. Nothing was written.")
        with open(staged, "rb") as handle:
            head = handle.read(ISO_MAGIC_OFFSET + 5)
        if not head or b"artifact has expired" in head.lower():
            return fail("Next: the installer download is missing or expired. Nothing was written. Run this program again after the durable installer is published.")
        try:
            checksum_body = curl_to(sum_url, sum_path)
        except (OSError, RuntimeError) as exc:
            say(f"Why: {exc}")
            return fail("Next: the installer checksum could not be downloaded. Nothing was written. Run this program again.")
        expected = checksum_body.decode("utf-8", "replace").split()
        if not expected or not re.fullmatch(r"[0-9a-fA-F]{64}", expected[0]):
            return fail("Next: the installer checksum was not valid. Nothing was written. Run this program again.")
        actual = file_sha256(staged)
        if actual.lower() != expected[0].lower():
            return fail("Next: the installer download did not match its checksum. Nothing was written. Run this program again.")
        invariant(looks_like_iso(head), "the installer download matches its checksum but is not an ISO9660 image",
                  "The release asset is wrong. Re-run the Fleet workflow so it publishes a real fleet-installer.iso.",
                  size=staged.stat().st_size, head=head[:16])
        if dest.is_file() and dest.stat().st_size == staged.stat().st_size and file_sha256(dest) == actual:
            return 0
        size = staged.stat().st_size
        os.replace(staged, dest)  # the bytes were hashed on disk above; a rename cannot change them
        invariant(dest.stat().st_size == size, "the installer on disk is the wrong size", "Free space or use another drive, then run this program again.", file=str(dest), want=size)
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        try:
            staged.unlink()
        except OSError:
            pass


def os_boot_tool(os_name):
    if os_name == "Darwin":
        return os.environ.get("FLEET_DARWIN_BOOT", "kexec")
    if os_name == "Windows":
        return os.environ.get("FLEET_WINDOWS_BOOT", "kexec")
    return os.environ.get("FLEET_KEXEC", "kexec")


def _le32(buf, offset):
    return int.from_bytes(buf[offset:offset + 4], "little")


def _susp_entries(blob):
    offset = 0
    while offset + 4 <= len(blob):
        length = blob[offset + 2]
        if length < 4 or offset + length > len(blob):
            break
        yield blob[offset:offset + 2], blob[offset:offset + length]
        offset += length


def _rock_ridge_name(system_use, handle):
    """Prefer the Rock Ridge name. A bad continuation falls back to the ISO name."""
    try:
        pending = system_use
        parts = []
        for _ in range(8):
            if not pending:
                break
            nxt = None
            for sig, entry in _susp_entries(pending):
                if sig == b"NM" and len(entry) >= 5 and not (entry[4] & 0x06):
                    parts.append(entry[5:])
                elif sig == b"CE" and len(entry) >= 28:
                    loc = _le32(entry, 4)
                    off = _le32(entry, 12)
                    length = _le32(entry, 20)
                    handle.seek(loc * SECTOR + off)
                    nxt = handle.read(length)
            pending = nxt
        if not parts:
            return None
        name = b"".join(parts).decode("utf-8", "strict")
    except (OSError, UnicodeError, ValueError):
        return None
    if not name or name in (".", "..") or "/" in name or "\x00" in name:
        return None
    return name


def _iso_name(ident):
    if ident == b"\x00":
        return "."
    if ident == b"\x01":
        return ".."
    text = ident.split(b";", 1)[0].decode("utf-8", "replace").rstrip(".")
    if not text or "/" in text or "\x00" in text:
        return None
    return text


def _record_name(record, handle):
    name_len = record[32]
    if 33 + name_len > len(record):
        return None
    su_off = 33 + name_len
    if su_off % 2:
        su_off += 1
    rock = _rock_ridge_name(record[su_off:], handle)
    if rock:
        return rock
    return _iso_name(record[33:33 + name_len])


def _directory_records(handle, extent, size):
    handle.seek(extent * SECTOR)
    data = handle.read(size)
    offset = 0
    while offset + 1 < len(data):
        if data[offset] == 0:
            offset = ((offset // SECTOR) + 1) * SECTOR
            continue
        length = data[offset]
        if length < 34 or offset + length > len(data):
            break
        yield data[offset:offset + length]
        offset += length


def _iso_index(handle):
    handle.seek(16 * SECTOR)
    pvd = handle.read(SECTOR)
    if len(pvd) < 190 or pvd[0] != 1 or pvd[1:6] != b"CD001":
        raise ValueError("not an ISO9660 installer")
    root_len = pvd[156]
    if root_len < 34 or 156 + root_len > len(pvd):
        raise ValueError("installer volume has no root directory")
    files = {}

    def walk(record, prefix):
        for child in _directory_records(handle, _le32(record, 2), _le32(record, 10)):
            name = _record_name(child, handle)
            if not name or name in (".", ".."):
                continue
            path = f"{prefix}/{name}" if prefix else name
            if child[25] & 0x02:
                walk(child, path)
            else:
                files[path] = (_le32(child, 2), _le32(child, 10))

    walk(pvd[156:156 + root_len], "")
    return files


def _iso_path(path):
    # ISO paths are POSIX on every host. NixOS prepends /boot/ to an absolute
    # store path, so its boot menus legitimately contain /boot//nix/store/...
    return re.sub(r"/+", "/", path)


def _iso_key(files, path):
    key = _iso_path(path).lstrip("/")
    if key not in files:
        folded = {name.lower(): name for name in files}
        key = folded.get(key.lower())
    return key


def _iso_bytes(handle, files, path):
    key = _iso_key(files, path)
    if key is None:
        raise ValueError(f"missing {path}")
    extent, size = files[key]
    if size <= 0 or size > 512 * 1024 * 1024:
        raise ValueError(f"unusable {path}")
    handle.seek(extent * SECTOR)
    body = handle.read(size)
    if len(body) != size:
        raise ValueError(f"short {path}")
    return body


def _boot_blocks(text):
    blocks = []
    current = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        head, _, rest = line.partition(" ")
        head = head.upper()
        if head == "LABEL":
            if current.get("linux") and current.get("initrd"):
                blocks.append(current)
            current = {"label": rest.strip()}
        elif head == "LINUX" and rest.strip():
            current["linux"] = _iso_path(rest.strip())
        elif head == "INITRD" and rest.strip():
            current["initrd"] = _iso_path(rest.strip())
        elif head == "APPEND":
            current["append"] = rest.strip()
    if current.get("linux") and current.get("initrd"):
        blocks.append(current)
    return blocks


def _choose_block(blocks, role):
    want = f"fleet.role={role}"
    matches = [block for block in blocks if want in block.get("append", "").split()]
    if not matches:
        raise ValueError(f"no {role} boot entry")
    preferred = "boot" if role == "ci" else f"boot-{role}"
    for block in matches:
        if block.get("label") == preferred:
            return block
    return sorted(matches, key=lambda block: (len(block.get("label", "")), block.get("label", "")))[0]


def iso_filesystem(path):
    override = os.environ.get("FLEET_ISO_FS")
    if override is not None and override.strip() != "":
        return override.strip().lower()
    tool = os.environ.get("FLEET_FINDMNT", "findmnt")
    if shutil.which(tool) is None and not os.path.isfile(tool):
        return ""
    completed = subprocess.run(
        [tool, "-n", "-o", "FSTYPE", "-T", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        return ""
    return completed.stdout.strip().splitlines()[0].strip().lower()


def extract_boot(iso_path, role):
    """Pull the role's kernel and initrd out of the installer ISO."""
    iso_path = Path(iso_path)
    with iso_path.open("rb") as handle:
        files = _iso_index(handle)
        config = _iso_bytes(handle, files, "isolinux/isolinux.cfg").decode("utf-8", "replace")
        block = _choose_block(_boot_blocks(config), role)
        kernel = _iso_bytes(handle, files, block["linux"])
        initrd = _iso_bytes(handle, files, block["initrd"])
    directory = iso_path.parent / "boot-files"
    directory.mkdir(parents=True, exist_ok=True)
    invariant(kernel and initrd, "the installer ISO holds an empty kernel or initrd", iso=str(iso_path), kernel=len(kernel), initrd=len(initrd))
    kernel_path = directory / "kernel"
    initrd_path = directory / "initrd"
    kernel_path.write_bytes(kernel)
    initrd_path.write_bytes(initrd)
    return str(kernel_path), str(initrd_path), block.get("append", "")


def _boot_command(append, role, iso_path, token=None, vault=None, ssh_key=None, findiso=True, origin=None, wifi=None):
    tokens = append.split()
    if any(any(char.isspace() for char in token) for token in tokens):
        raise ValueError("boot command is not one line")
    extras = ["copytoram"]
    if findiso:
        iso_abs = str(Path(iso_path).resolve())
        if iso_abs == "" or any(char.isspace() for char in iso_abs):
            raise ValueError("installer path is not a single word")
        extras.append(f"findiso={iso_abs}")
    role_token = f"fleet.role={role}"
    if vault and any(char.isspace() for char in vault):
        raise ValueError("vault address is not a single word")
    kept = [t for t in tokens if t not in extras and t != role_token and not t.startswith(
        ("fleet.enroll=", "fleet.vault=", "fleet.ssh=", "fleet.from=", "fleet.wifi=", "fleet.attempt=", "fleet.wizard=", "findiso="))]
    enroll = [f"fleet.enroll={token}"] if token else []
    where = [f"fleet.vault={vault}"] if token and vault else []
    invariant(role in ROLES, "refusing to build a boot command for an unknown role", role=role)
    access = ["fleet.ssh=" + base64.urlsafe_b64encode(validate_ssh_key(ssh_key).encode()).decode()] if ssh_key else []
    # The live installer's screens name the system it returns to (scripts/live_console.py).
    invariant(origin in (None, "windows", "linux"), "refusing an unknown handoff origin", origin=origin)
    came = [f"fleet.from={origin}"] if origin else []
    # Which wizard attempt and build sent this boot, for the installer screen's
    # report. Public identifiers only; anything malformed is left out.
    tags = [f"fleet.{name}={value}" for name, value, pattern in (
        ("attempt", HANDOFF.get("attempt"), r"[0-9a-f]{16}"), ("wizard", HANDOFF.get("wizard"), r"[A-Za-z0-9._-]{1,40}"))
        if origin and isinstance(value, str) and re.fullmatch(pattern, value)]
    # Whether Wi-Fi settings rode along (never the settings themselves). The live
    # installer tells "none were sent" from "sent but lost" on its screen and report.
    carried = [] if wifi is None else ["fleet.wifi=" + ("sent" if wifi else "none")]
    command = " ".join([*kept, *extras, *enroll, *where, *access, *came, *tags, *carried, role_token])
    invariant(len(command.encode()) < 4096, "the installer boot command is too long", "Use an Ed25519 public key.", bytes=len(command.encode()))
    # The installer reads the LAST fleet.role=, so ours must be last.
    invariant(command.endswith(role_token) and command.rsplit("fleet.role=", 1)[1] == role,
              "the boot command must end with the chosen fleet.role=", command=command)
    invariant("\n" not in command and "\r" not in command, "the boot command spans lines", command=command)
    return command


def wifi_module():
    try:
        import fleet_wifi
        return fleet_wifi
    except ImportError:
        directory = Path(__file__).resolve().parent.parent / "wizard"
        sys.path.insert(0, str(directory))
        import fleet_wifi
        return fleet_wifi


def wifi_profile(os_name, supplied=None):
    module = wifi_module()
    try:
        return module.discover(os_name, supplied)
    except module.WifiError as exc:
        invariant(False, str(exc), "Enter the Wi-Fi settings in the wizard before installing. Nothing was erased.")


def stage_reboot(os_name, role, iso, token=None, vault=None, wifi=None):
    """Load the ISO's own kernel. The shell initrd finds the file and copies it to RAM."""
    tool = os_boot_tool(os_name)
    flash = "Next: this computer cannot reboot into the installer. Nothing was written. Plug in one USB disk and run this program again with the word flash."
    if shutil.which(tool) is None and not os.path.isfile(tool):
        say(flash)
        return 1
    if iso_filesystem(iso) not in SAFE_ISO_FS:
        say(flash)
        return 1
    try:
        kernel, initrd, append = extract_boot(iso, role)
        cmdline = _boot_command(append, role, iso, token, vault, devbox_key() if role == "devbox" else None, origin="linux", wifi=wifi is not None)
    except (OSError, ValueError):
        say("Next: the installer image could not be read. Nothing was written. Plug in one USB disk and run this program again with the word flash.")
        return 1
    for staged_file in (kernel, initrd, iso):
        invariant(os.path.isfile(staged_file) and os.path.getsize(staged_file) > 0, "a file the installer needs is missing or empty before reboot", file=str(staged_file))
    private_initrd = None
    try:
        if wifi is not None:
            private_initrd = Path(initrd).with_name("initrd-wifi")
            wifi_module().write_private(private_initrd, Path(initrd).read_bytes() + wifi_module().initrd(wifi))
            initrd = str(private_initrd)
        load = run_logged([tool, "--load", kernel, f"--initrd={initrd}", f"--command-line={cmdline}"])
        if load.returncode != 0:
            say(flash)
            return load.returncode or 1
        log("rebooting into the installer")
        execute = run_logged([tool, "-e"])
        if execute.returncode != 0:
            # The loaded kernel carries the enrollment token; a later kexec reboot must not use it.
            run_logged([tool, "-u"])
            say(flash)
            return execute.returncode or 1
        return 0
    finally:
        if private_initrd is not None:
            private_initrd.unlink(missing_ok=True)


# ---- Windows: convert this computer in place -------------------------------------
# Windows cannot kexec. Instead the installer image is written raw into a new
# partition carved out of C:, GRUB (taken from that same image) is placed on the
# EFI system partition with a config that boots the image's own kernel for the
# chosen role, and the firmware is told to boot it once. On reboot the installer
# erases the whole disk (Windows, the new partition and all) and installs NixOS.
# Everything before the reboot can be undone, and is, if a step fails.

LINUX_DATA_GUID = "{0fc63daf-8483-4772-8e79-3d69d8477de4}"
ESP_GUID = "{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}"
# Windows dynamic disks keep their layout in an LDM database; Get-Partition and
# Resize-Partition do not work on them.
LDM_GUIDS = ("{5808c8aa-7e8f-42e0-85d2-e1e90434cfb3}", "{af9b60a0-1431-4f62-bc68-3311714a69ad}")
MIB = 1024 * 1024
WINDOWS_MARGIN = 64 * MIB
ESTIMATED_ISO = 8 * 1024 ** 3  # used for the early check when the release size is not known yet
ISO_SYSTEM_AREA = 16 * 2048  # the hybrid MBR; blank here so the partition holds one signature only
WRITE_CHUNK = 4 * MIB
WRITE_SECTOR = 4096
# The initrd copies the whole image into RAM (copytoram) and the installer then
# needs working memory of its own.
RAM_HEADROOM = 2 * 1024 ** 3
LOADER_SLACK = MIB  # free space the EFI system partition must keep after the boot files
GUID_RE = re.compile(r"\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}")
BOOT_LOADER_PARTS = ("EFI", "fleet", "grubx64.efi")
BOOT_LOADER_FIRMWARE_PATH = "\\" + "\\".join(BOOT_LOADER_PARTS)
BOOT_DESCRIPTION = "Fleet installer"
INSTALLER_IMAGE_MARKER = "EFI/nixos-installer-image"
NEWER_RELEASE_FIX = ("This Fleet installer does not understand the published release; it is probably older than the release. "
                     "Download the latest Fleet installer from the fleet-installer release page and run it. Nothing was erased.")
WINDOWS_JOURNAL_NAME = "windows-staging.json"
WINDOWS_RECOVERY_FIX = ("Some changes from the conversion are still on this computer. Follow 'Remove everything by hand' in docs/windows.md "
                        "to remove them, then run the installer again. Until then, do not choose the Fleet installer in the boot menu.")
WINDOWS_RESTART_RECOVERY_FIX = ("Windows may still restart into the installer. Stop the scheduled restart from an administrator window with `shutdown /a`, "
                                "then run the installer again. Keep the staged boot files and installer partition until the restart is confirmed cancelled.")
# What windows_findings last learned, so the plan printed by doctor and --plan
# does not need a second (slow) storage query.
WINDOWS = {"facts": None, "iso_size": None}


# ---- PowerShell text ------------------------------------------------------------
# Every script this program sends to Windows PowerShell is built by a small pure
# function below, so a test can hand the exact text to the real PowerShell
# parser (tests/test_powershell.py). Rules that keep them correct under
# `powershell -Command`: one line, single-quoted strings only (no double quote
# ever reaches the Windows command line), values come through ps_literal /
# ps_number, and nothing depends on the language of the Windows installation
# (only property names and JSON are read back).

PS_LITERAL_RE = re.compile(r"^[A-Za-z0-9 ._:\\{}/-]*$")


def ps_literal(value):
    """A PowerShell single-quoted string. Nothing inside it is interpreted."""
    text = str(value)
    invariant(PS_LITERAL_RE.match(text) is not None, "refusing to put an unexpected character into a PowerShell script", value=text[:60])
    return "'" + text + "'"


def ps_number(value):
    invariant(isinstance(value, int) and not isinstance(value, bool) and value >= 0, "a PowerShell script was given something that is not a count", value=value)
    return str(value)


def ps_letter(value):
    invariant(isinstance(value, str) and re.fullmatch(r"[A-Za-z]", value) is not None, "a drive letter must be one letter", value=value)
    return value.upper()


def ps_facts_script():
    """One read-only query. Nothing here changes the machine."""
    esp, ldm_a, ldm_b = ps_literal(ESP_GUID), ps_literal(LDM_GUIDS[0]), ps_literal(LDM_GUIDS[1])
    return (
        "$letter = $env:SystemDrive.Substring(0, 1); "
        "$c = Get-Partition -DriveLetter $letter; "
        "$limit = Get-PartitionSupportedSize -DriveLetter $letter; "
        "$disk = Get-Disk -Number $c.DiskNumber; "
        "$parts = @(Get-Partition -DiskNumber $c.DiskNumber); "
        f"$esps = @($parts | Where-Object {{ $_.GptType -eq {esp} }} | ForEach-Object {{ [PSCustomObject]@{{ Number = [int]$_.PartitionNumber; Size = [int64]$_.Size }} }}); "
        f"$dynamic = (@($parts | Where-Object {{ $_.GptType -eq {ldm_a} -or $_.GptType -eq {ldm_b} }}).Count -gt 0); "
        f"$linux = @($parts | Where-Object {{ $_.GptType -eq {ps_literal(LINUX_DATA_GUID)} }} | ForEach-Object {{ [PSCustomObject]@{{ Number = [int]$_.PartitionNumber; Size = [int64]$_.Size }} }}); "
        "$secure = $null; try { $secure = [bool](Confirm-SecureBootUEFI) } catch { }; "
        "$memory = $null; try { $memory = [int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory } catch { }; "
        "$battery = $false; try { $b = @(Get-CimInstance Win32_Battery); $battery = ($b.Count -gt 0 -and $b[0].BatteryStatus -eq 1) } catch { }; "
        "$bitlocker = $null; try { $bitlocker = [string](Get-BitLockerVolume -MountPoint ($letter + ':')).ProtectionStatus } catch { }; "
        "[PSCustomObject]@{ Letter = $letter; DiskNumber = [int]$c.DiskNumber; PartitionNumber = [int]$c.PartitionNumber; "
        "Size = [int64]$c.Size; SizeMin = [int64]$limit.SizeMin; SizeMax = [int64]$limit.SizeMax; "
        "Style = [string]$disk.PartitionStyle; BusType = [string]$disk.BusType; LogicalSectorSize = [int]$disk.LogicalSectorSize; "
        "Esps = $esps; LinuxParts = $linux; Dynamic = $dynamic; SecureBoot = $secure; Memory = $memory; OnBattery = $battery; "
        "BitLocker = $bitlocker } | ConvertTo-Json -Compress -Depth 4"
    )


def ps_shrink_script(letter, size):
    return f"Resize-Partition -DriveLetter {ps_letter(letter)} -Size {ps_number(size)}"


def ps_restore_script(letter, size):
    """Give the volume back its original size. Safe to run when nothing was shrunk."""
    drive, wanted = ps_letter(letter), ps_number(size)
    return (
        f"$c = Get-Partition -DriveLetter {drive}; "
        f"if ([uint64]$c.Size -lt [uint64]{wanted}) {{ "
        f"$m = Get-PartitionSupportedSize -DriveLetter {drive}; "
        f"$s = [uint64]{wanted}; if ($s -gt [uint64]$m.SizeMax) {{ throw 'the original system partition size cannot be restored yet' }}; "
        f"Resize-Partition -DriveLetter {drive} -Size $s; "
        f"$restored = Get-Partition -DriveLetter {drive}; "
        "if ([uint64]$restored.Size -ne $s) { throw 'the system partition did not return to its original size' } }"
    )


def ps_new_partition_script(disk, size, offset=None):
    number = ps_number(disk)
    position = f" -Offset {ps_number(offset)}" if offset is not None else ""
    return (
        f"try {{ Update-Disk -Number {number} }} catch {{ }}; "
        f"$p = New-Partition -DiskNumber {number} -Size {ps_number(size)}{position} -GptType {ps_literal(LINUX_DATA_GUID)}; "
        f"$p = Get-Partition -DiskNumber {number} -PartitionNumber $p.PartitionNumber; "
        "[PSCustomObject]@{ Number = [int]$p.PartitionNumber; Offset = [int64]$p.Offset; Size = [int64]$p.Size; Guid = [string]$p.Guid } | ConvertTo-Json -Compress"
    )


def ps_remove_partition_script(disk, number):
    return f"Remove-Partition -DiskNumber {ps_number(disk)} -PartitionNumber {ps_number(number)} -Confirm:$false"


def ps_mount_esp_script():
    """Mount the EFI system partition Windows booted from on a free drive letter; print its root and letter.
    One that already has a letter (left mounted by a run that stopped) is reused, never mounted twice."""
    return (
        "$sys = Get-Partition -DriveLetter $env:SystemDrive.Substring(0, 1); "
        f"$held = @(Get-Partition -DiskNumber $sys.DiskNumber | Where-Object {{ $_.GptType -eq {ps_literal(ESP_GUID)} -and [int]$_.DriveLetter -ge 65 }}); "
        "if ($held.Count -gt 0) { $l = [string]$held[0].DriveLetter; [PSCustomObject]@{ Root = ($l + ':\\'); Letter = $l; Reused = $true } | ConvertTo-Json -Compress; return }; "
        "$letter = $null; "
        "foreach ($candidate in 'Z','Y','X','W','V','U','T','S','R','Q','P') { if (-not (Test-Path ($candidate + ':\\'))) { $letter = $candidate; break } }; "
        "if (-not $letter) { throw 'no free drive letter for the EFI system partition' }; "
        "& mountvol ($letter + ':') /S | Out-Null; "
        "if ($LASTEXITCODE -ne 0) { throw 'mountvol could not mount the EFI system partition' }; "
        "[PSCustomObject]@{ Root = ($letter + ':\\'); Letter = [string]$letter } | ConvertTo-Json -Compress"
    )


def ps_unmount_script(letter):
    return f"& mountvol {ps_literal(ps_letter(letter) + ':')} /D | Out-Null; if ($LASTEXITCODE -ne 0) {{ throw 'mountvol could not unmount the EFI system partition' }}"


def ps_linux_partitions_script(disk, letter=None):
    """The Linux data partitions on a disk: where an unfinished run may have left the installer."""
    extent = ""
    offset = ""
    if letter is not None:
        extent = (f"$c = Get-Partition -DriveLetter {ps_letter(letter)}; "
                  f"if ([int]$c.DiskNumber -ne {ps_number(disk)}) {{ throw 'the system partition changed disks' }}; ")
        offset = "; Offset = [int64]($c.Offset + $c.Size)"
    return (
        extent +
        f"$found = @(Get-Partition -DiskNumber {ps_number(disk)} | Where-Object {{ $_.GptType -eq {ps_literal(LINUX_DATA_GUID)} }} | "
        "ForEach-Object { [PSCustomObject]@{ Number = [int]$_.PartitionNumber; Offset = [int64]$_.Offset; Size = [int64]$_.Size; Guid = [string]$_.Guid } }); "
        f"[PSCustomObject]@{{ Parts = $found{offset} }} | ConvertTo-Json -Compress -Depth 4"
    )


def ps_partition_by_letter_script(letter):
    """Where the mounted EFI system partition really is: the firmware needs its GUID, start and size."""
    return (
        f"$p = Get-Partition -DriveLetter {ps_letter(letter)}; $d = Get-Disk -Number $p.DiskNumber; "
        "[PSCustomObject]@{ DiskNumber = [int]$p.DiskNumber; Number = [int]$p.PartitionNumber; Offset = [int64]$p.Offset; Size = [int64]$p.Size; "
        "Guid = [string]$p.Guid; GptType = [string]$p.GptType; LogicalSectorSize = [int]$d.LogicalSectorSize } | ConvertTo-Json -Compress"
    )


def ps_memory_script():
    return "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"


def ps_disks_script():
    """The disk listing the planner chooses from (see collect)."""
    return (
        "$ErrorActionPreference = 'Stop'; "
        "try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }; "
        "$rows = Get-CimInstance Win32_DiskDrive | ForEach-Object { "
        "$parts = @($_ | Get-CimAssociatedInstance -ResultClassName Win32_DiskPartition); "
        "$letters = @(); "
        "foreach ($part in $parts) { "
        "$vols = @($part | Get-CimAssociatedInstance -ResultClassName Win32_LogicalDisk); "
        "foreach ($vol in $vols) { if ($vol.DeviceID) { $letters += [string]$vol.DeviceID } } "
        "}; "
        "[PSCustomObject]@{ DeviceID=$_.DeviceID; Model=$_.Model; Size=[int64]$_.Size; "
        "InterfaceType=[string]$_.InterfaceType; BusType=[string]$_.BusType; "
        "MediaType=[string]$_.MediaType; PNPDeviceID=$_.PNPDeviceID; "
        "SerialNumber=$_.SerialNumber; Volumes=$letters } }; "
        "$rows | ConvertTo-Json -Compress -Depth 4"
    )


def all_powershell_scripts():
    """Every script this program can send, for the parser test."""
    return {
        "facts": ps_facts_script(),
        "shrink": ps_shrink_script("C", 123456789),
        "restore": ps_restore_script("C", 123456789),
        "new-partition": ps_new_partition_script(0, 987654321),
        "new-partition-at-offset": ps_new_partition_script(0, 987654321, 1048576),
        "remove-partition": ps_remove_partition_script(0, 5),
        "mount-esp": ps_mount_esp_script(),
        "unmount-esp": ps_unmount_script("Z"),
        "partition-by-letter": ps_partition_by_letter_script("Z"),
        "linux-partitions": ps_linux_partitions_script(0),
        "linux-partitions-plan": ps_linux_partitions_script(0, "C"),
        "memory": ps_memory_script(),
        "disks": ps_disks_script(),
    }


PS_PREAMBLE = "$ErrorActionPreference = 'Stop'; "


def powershell_tool():
    return os.environ.get("FLEET_POWERSHELL") or shutil.which("powershell.exe") or "powershell"


def powershell_environment():
    """A copy of the environment for Windows PowerShell. PSModulePath is dropped:
    when this program was started from PowerShell 7 it points 5.1 at modules it
    cannot load, and the Storage cmdlets disappear."""
    return {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}


def windows_ps(script, timeout=900):
    invariant('"' not in script and "\n" not in script, "a PowerShell script would not survive the Windows command line", script=script[:80])
    try:
        done = run_logged([powershell_tool(), "-NoProfile", "-NonInteractive", "-Command", PS_PREAMBLE + script],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
                          timeout=timeout, env=powershell_environment())
    except subprocess.TimeoutExpired:
        invariant(False, "a Windows disk command did not finish", "Nothing that cannot be undone was changed. Close other programs, restart Windows, and run this program again.",
                  command=script.strip()[:120], seconds=timeout)
    invariant(done.returncode == 0, "a Windows disk command failed",
              "Nothing that cannot be undone was changed. Read the log, fix what it names, and run this program again.",
              command=script.strip().splitlines()[0][:120], code=done.returncode, error=(done.stderr or done.stdout or "").strip()[-300:])
    return done.stdout


def json_from_output(raw):
    """The JSON object a script printed. Windows may add warning lines around it."""
    for line in reversed(str(raw).strip().splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    invariant(False, "Windows printed something other than the expected answer", "Nothing that cannot be undone was changed. Read the log and run this program again.", output=str(raw).strip()[-200:])


def parse_windows_facts(raw):
    facts = json_from_output(raw)
    invariant(isinstance(facts, dict) and "DiskNumber" in facts, "Windows described its system disk in an unexpected way", output=str(raw)[-200:])
    esps = facts.get("Esps")
    if isinstance(esps, dict):
        esps = [esps]
    facts["Esps"] = [item for item in (esps or []) if isinstance(item, dict)]
    if "EspNumber" not in facts:
        facts["EspNumber"] = facts["Esps"][0]["Number"] if facts["Esps"] else None
    return facts


def windows_facts(fresh=False):
    """One read-only query: the system disk, how far C: can shrink, the EFI system partitions."""
    if WINDOWS["facts"] is not None and not fresh:
        return dict(WINDOWS["facts"])
    facts = parse_windows_facts(windows_ps(ps_facts_script()))
    # Synthetic PowerShell answers may supply Firmware. The real query leaves
    # it to the documented API: PEFirmwareType is a Windows PE registry value,
    # and its absence on installed Windows does not mean legacy BIOS.
    if "Firmware" not in facts:
        facts["Firmware"] = windows_firmware_type()
    WINDOWS["facts"] = facts
    return dict(facts)


def windows_firmware_type(kernel=None):
    """Read the current boot mode with GetFirmwareType; None means unknown.
    This API needs no elevation and never writes firmware variables."""
    import ctypes
    try:
        if kernel is None:
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        query = kernel.GetFirmwareType
        query.argtypes = [ctypes.POINTER(ctypes.c_uint32)]
        query.restype = ctypes.c_int
        value = ctypes.c_uint32()
        if query(ctypes.byref(value)):
            return value.value if value.value in (1, 2) else None
        code = getattr(ctypes, "get_last_error", lambda: 0)()
        log(f"GetFirmwareType failed with Windows error {code}", "WARN")
    except (AttributeError, OSError) as exc:
        log(f"GetFirmwareType is not available: {exc}", "WARN")
    return None


def windows_admin():
    """True or False when Windows can say whether this process is elevated, None when it cannot."""
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError, ImportError):
        return None


def padded_size(size):
    return (size + WRITE_SECTOR - 1) // WRITE_SECTOR * WRITE_SECTOR


def windows_need(iso_size):
    return (padded_size(iso_size) + WINDOWS_MARGIN + MIB - 1) // MIB * MIB


def installer_on_drive(path, letter):
    """Does the downloaded installer sit on this drive? Unknown counts as yes: the safe answer."""
    drive = os.path.splitdrive(os.path.abspath(str(path)))[0]
    return not drive or drive[:1].upper() == str(letter).upper()


def memory_finding(memory, size):
    """The installer image is copied whole into RAM, and the installer needs room besides. Below that it cannot start."""
    if memory is None or not size:
        return None
    need = size + RAM_HEADROOM
    have = memory / 1024 ** 3
    if memory < need:
        return finding("memory", "fail", f"{have:.1f} GiB RAM; the installer is copied into RAM and needs {need / 1024 ** 3:.1f} GiB ({size / 1024 ** 3:.1f} GiB image + 2 GiB)",
                       f"Add RAM until the computer has at least {need // 1024 ** 3 + 1} GiB. An install USB cannot help: it boots the same image into RAM too. Or choose a computer with more memory.")
    return finding("memory", "ok", f"{have:.1f} GiB RAM, the installer needs {need / 1024 ** 3:.1f} GiB")


def windows_findings(iso_size, disk_path=None, strict=True, iso_path=None):
    """Everything about this Windows installation that decides whether it can convert itself.
    strict=False is the wizard's review, which is not elevated: Windows may refuse its
    storage queries there, and the elevated helper repeats this check with strict=True.
    iso_path is where the installer is (or will be) downloaded: a copy that is not there yet
    will sit on C: and take space away from the shrink."""
    found = []
    bcdedit = os.environ.get("FLEET_BCDEDIT", "bcdedit")
    if shutil.which(bcdedit) or os.path.isfile(bcdedit):
        found.append(finding("boot-tool", "ok", "bcdedit"))
    else:
        found.append(finding("boot-tool", "fail", "bcdedit is not available", "Run this program from an administrator account on Windows, or make an install USB with the word flash."))
        return found
    try:
        facts = windows_facts()
    except (Invariant, OSError, ValueError) as exc:
        if not strict:
            found.append(finding("windows", "info", "the disk, firmware and Secure Boot checks run once you accept the administrator prompt"))
            return found
        found.append(finding("windows", "fail", f"Windows could not describe its system disk ({getattr(exc, 'what', exc)})",
                             "Run this program as administrator. If it repeats, make an install USB with the word flash."))
        return found
    WINDOWS["iso_size"] = iso_size
    if facts.get("Firmware") == 2:
        found.append(finding("firmware", "ok", "booted in UEFI mode"))
    elif facts.get("Firmware") == 1:
        found.append(finding("firmware", "fail", "Windows is booted in legacy BIOS mode",
                             "Convert the disk to GPT and enable UEFI in the firmware settings, or make an install USB with the word flash."))
    else:
        found.append(finding("firmware", "fail", "Windows boot mode could not be determined",
                             "Open System Information (msinfo32) and check BIOS Mode. Restart Windows and run the installer again; if it repeats, copy the diagnostic report. No disk conversion is recommended until the boot mode is known."))
    secure = facts.get("SecureBoot")
    if secure is True:
        found.append(finding("secure-boot", "fail", "Secure Boot is on and the installer is not signed",
                             "Turn Secure Boot off once: run `shutdown /r /fw`, open the Boot or Security page, set Secure Boot to Disabled, save, start Windows, and run this program again."))
    elif secure is None:
        found.append(finding("secure-boot", "warn", "Secure Boot state could not be read", "If the installer does not start, turn Secure Boot off in the firmware settings."))
    else:
        found.append(finding("secure-boot", "ok", "off"))
    if facts.get("Style") == "GPT":
        found.append(finding("partition-style", "ok", "GPT"))
    else:
        found.append(finding("partition-style", "fail", f"the system disk uses {facts.get('Style')} partitions", "Only GPT/UEFI disks convert in place. Make an install USB with the word flash."))
    if facts.get("Dynamic"):
        found.append(finding("dynamic-disk", "fail", "the system disk is a Windows dynamic disk", "Dynamic disks cannot be resized in place. Make an install USB with the word flash."))
    sector = facts.get("LogicalSectorSize")
    if sector is not None and sector not in (512, 4096):
        found.append(finding("sector-size", "fail", f"the system disk uses {sector}-byte sectors", "Only 512-byte and 4096-byte sectors are supported. Make an install USB with the word flash."))
    if str(facts.get("BusType") or "").upper() == "RAID":
        found.append(finding("disk-controller", "warn", "the system disk is behind a RAID or Intel RST/VMD controller",
                             "Linux cannot see disks in that mode. In the firmware settings set the storage mode to AHCI (this can stop Windows from starting), or make an install USB with the word flash."))
    if disk_path is not None:
        wanted = f"\\\\.\\PHYSICALDRIVE{facts.get('DiskNumber')}"
        if disk_path.upper() == wanted.upper():
            found.append(finding("system-disk", "ok", "the disk that would be erased holds Windows"))
        else:
            found.append(finding("system-disk", "fail", f"Windows runs from disk {facts.get('DiskNumber')}, not {disk_path}",
                                 "Disconnect the other internal disks, or make an install USB with the word flash."))
    if facts.get("EspNumber") is None:
        found.append(finding("efi-partition", "fail", "no EFI system partition on the system disk", "Make an install USB with the word flash."))
    else:
        found.append(finding("efi-partition", "ok", f"partition {facts['EspNumber']}"))
    journal = WindowsJournal().peek()
    if journal is not None:
        found.append(finding("earlier-run", "info", "an earlier conversion did not finish; it is taken back automatically before this one starts"))
    else:
        leftovers = [item for item in (facts.get("LinuxParts") or []) if isinstance(item, dict)]
        if leftovers:
            sizes = ", ".join(f"partition {item.get('Number')} ({int(item.get('Size') or 0) // MIB} MiB)" for item in leftovers)
            found.append(finding("leftover-partition", "warn", f"the system disk already has Linux data partitions: {sizes}",
                                 "If an earlier Fleet installer left them, delete them in Disk Management and extend C: (docs/windows.md), "
                                 "so only one copy of the installer is on this disk."))
    size = iso_size or ESTIMATED_ISO
    need = windows_need(size)
    # The download lands on C: unless it goes elsewhere, and a file that is there counts as used space:
    # Windows cannot shrink below it. Ask for the room the copy will take as well, before it is downloaded.
    copy = padded_size(size) if iso_path is not None and not os.path.isfile(iso_path) and installer_on_drive(iso_path, facts["Letter"]) else 0
    shrinkable = int(facts.get("Size") or 0) - int(facts.get("SizeMin") or 0)
    letter = facts["Letter"]
    if journal is not None and str(journal.get("letter")) == str(letter):
        # Taking back the earlier run gives this space back first.
        shrinkable += max(0, int(journal.get("original_size") or 0) - int(facts.get("Size") or 0))
    if shrinkable >= need + copy:
        found.append(finding("shrink", "ok", f"{letter}: can give up {shrinkable // 1024 ** 3} GiB, the installer needs {(need + copy) // MIB} MiB"))
    else:
        extra = f" (including {copy // MIB} MiB for the download, which sits on {letter}: until it is written)" if copy else ""
        found.append(finding("shrink", "fail", f"{letter}: can only shrink by {max(shrinkable, 0) // MIB} MiB, the installer needs {(need + copy) // MIB} MiB{extra}",
                             f"Free space on {letter}: (empty the Recycle Bin, remove large files, turn off hibernation with `powercfg /h off`), then run this program again. "
                             "If it still cannot shrink, Windows has files it cannot move near the end of the drive; docs/windows.md explains what to do."))
    if str(facts.get("BitLocker") or "").lower() in ("on", "1"):
        found.append(finding("bitlocker", "warn", f"BitLocker is on for {letter}:",
                             "Save the BitLocker recovery key somewhere that is not this computer before going on (account.microsoft.com/devices/recoverykey). If anything stops half way, Windows may ask for it."))
    if facts.get("OnBattery"):
        found.append(finding("power", "warn", "this computer is running on battery", "Plug it in before going on: a power cut while the partitions change would need the recovery steps in docs/windows.md."))
    return found


def windows_plan_lines(facts, iso_size, role):
    """What conversion would do on this machine, in order, with the sizes. Changes nothing."""
    size = iso_size or ESTIMATED_ISO
    need, part = windows_need(size), padded_size(size)
    letter, disk = facts["Letter"], facts["DiskNumber"]
    total = int(facts["Size"])
    esp = facts.get("EspNumber")
    return [
        f"1. Shrink {letter}: from {total / 1024 ** 3:.1f} GiB to {(total - need) / 1024 ** 3:.1f} GiB (gives up {need / MIB:.0f} MiB: the {size / 1024 ** 3:.2f} GiB installer plus {WINDOWS_MARGIN // MIB} MiB spare). Files on {letter}: are not touched.",
        f"2. Create a {part / MIB:.0f} MiB partition of type Linux data on disk {disk} and write the installer image into it, then read it back and compare it byte for byte.",
        f"3. Mount the EFI system partition (partition {esp if esp is not None else '?'} of disk {disk}) on a spare drive letter and copy GRUB to {BOOT_LOADER_FIRMWARE_PATH} and a config to \\EFI\\BOOT\\grub.cfg ({role} installer).",
        f"4. Add the boot entry \"{BOOT_DESCRIPTION}\" with bcdedit and a firmware boot option (Boot####) for it, and set both to run once, on the next restart only. Windows stays first in the normal boot order.",
        "5. Restart 15 seconds later. The installer then ERASES the whole of disk " + f"{disk} (Windows, the new partition and every file) and installs {role}.",
        "Undo: if any step fails, everything above is taken back newest first and Windows boots as before. docs/windows.md lists the commands to do it by hand.",
    ]


def windows_disk_target(disk):
    """The device the installer image is written to. FLEET_WINDOWS_TARGET redirects
    the write to a plain file for tests; a device or a symlink is refused, so the
    redirect can never reach a real disk."""
    redirect = os.environ.get("FLEET_WINDOWS_TARGET")
    if redirect:
        try:
            mode = os.lstat(redirect).st_mode
        except OSError:
            mode = 0
        invariant(stat.S_ISREG(mode), "the test write target must be an existing regular file, never a device or symlink", path=redirect)
        return redirect
    return f"\\\\.\\PHYSICALDRIVE{disk}"


def windows_partition_target(disk, number):
    """The partition's own device. Windows lets a program write inside a partition that has no
    volume through either handle; when the whole-disk handle is refused this one often is not."""
    if os.environ.get("FLEET_WINDOWS_TARGET"):
        return None
    return f"\\\\?\\GLOBALROOT\\Device\\Harddisk{ps_number(disk)}\\Partition{ps_number(number)}"


def _write_and_verify(iso, device, offset, zero_head, on_progress):
    size = os.path.getsize(iso)
    binary = getattr(os, "O_BINARY", 0)
    fd = os.open(device, os.O_RDWR | binary)
    written = 0
    expected = hashlib.sha256()
    try:
        landed = os.lseek(fd, offset, os.SEEK_SET)
        invariant(landed == offset, "the device did not seek to the requested byte", device=device, wanted=offset, got=landed)
        with open(iso, "rb") as source:
            while written < size:
                block = source.read(WRITE_CHUNK)
                invariant(block != b"", "the image ended early while writing", wrote=written, want=size)
                if written < zero_head:
                    cut = min(zero_head - written, len(block))
                    block = bytes(cut) + block[cut:]
                expected.update(block)
                if len(block) % WRITE_SECTOR:
                    block = block + b"\0" * (padded_size(len(block)) - len(block))
                count = os.write(fd, block)
                invariant(count == len(block), "the disk accepted a short write", wrote=count, asked=len(block), at=written)
                written += min(len(block), size - written)
                if on_progress:
                    on_progress(written, size)
        os.fsync(fd)
    finally:
        os.close(fd)
    # Read it back through a fresh handle, so nothing that was only buffered can pass for what the disk holds.
    fd = os.open(device, os.O_RDONLY | binary)
    try:
        landed = os.lseek(fd, offset, os.SEEK_SET)
        invariant(landed == offset, "the device did not seek to the requested byte", device=device, wanted=offset, got=landed)
        seen, remaining = hashlib.sha256(), size
        while remaining:
            block = os.read(fd, min(WRITE_CHUNK, padded_size(remaining)))
            invariant(len(block) > 0, "the disk returned nothing while reading back", missing=remaining)
            take = min(len(block), remaining)
            seen.update(block[:take])
            remaining -= take
    finally:
        os.close(fd)
    invariant(seen.digest() == expected.digest(), "the partition does not hold the installer after writing",
              "The disk may be failing. Nothing that cannot be undone was changed; run this program again or make an install USB.", device=device)
    return size


def write_region(iso, target, offset, zero_head=0, on_progress=None, fallback=None):
    """Write the image at a byte offset of a disk (or any file in tests), sync,
    read it back, and prove the bytes match. The first zero_head bytes are
    written as zeros: an ISO's hybrid MBR would otherwise make the partition
    look like both a filesystem and a partition table. fallback is (device,
    offset), tried once from the start if the first device refuses with an OS
    error (access denied, sharing violation): the partition's own device
    takes offset 0."""
    invariant(offset % WRITE_SECTOR == 0, "the write offset is not sector aligned", offset=offset)
    attempts = [(target, offset)] + ([fallback] if fallback else [])
    refused = []
    for index, (device, start) in enumerate(attempts):
        invariant(start % WRITE_SECTOR == 0, "the write offset is not sector aligned", offset=start, device=device)
        try:
            return _write_and_verify(iso, device, start, zero_head, on_progress)
        except OSError as exc:
            reason = f"{type(exc).__name__}: {exc}"
            log(f"writing through {device} failed: {reason}", "ERROR")
            refused.append(f"{device} ({reason})")
            if index + 1 < len(attempts):
                say(f"Windows refused the write through {device}. Trying the partition's own device {attempts[index + 1][0]}.")
    invariant(False, "Windows would not let this program write the installer into the new partition",
              "Nothing that cannot be undone was changed. Close disk tools, antivirus or backup programs that watch the disk (they can lock it), "
              "check that this is an administrator window, restart Windows and run this program again; or make an install USB with the word flash.",
              devices="; ".join(refused))


def grub_config(role, linux_path, initrd_path, cmdline, wifi=False):
    invariant(role in ROLES, "refusing to write a boot config for an unknown role", role=role)
    for word in (linux_path, initrd_path, cmdline):
        invariant("\n" not in word and "\r" not in word and "'" not in word, "the boot config would span lines or quote badly", value=word[:80])
    search_wifi = "search --no-floppy --set=fleet_credentials --file /EFI/fleet/fleet-wifi.initrd\n" if wifi else ""
    extra_initrd = " ($fleet_credentials)/EFI/fleet/fleet-wifi.initrd" if wifi else ""
    return (
        "set timeout=3\n"
        "set default=0\n"
        f"search --no-floppy --set=root --file /{INSTALLER_IMAGE_MARKER}\n"
        f"{search_wifi}"
        f"menuentry 'Fleet installer: ERASES the internal disk and installs {role}' {{\n"
        f"    linux {linux_path} {cmdline}\n"
        f"    initrd {initrd_path}{extra_initrd}\n"
        "}\n"
    )


def _iso_has(files, path):
    return _iso_key(files, path) is not None


def iso_boot_material(iso_path, role):
    """The role's boot entry and GRUB program, read out of the installer image. Everything
    the boot needs is checked here, before Windows is changed: an image with a layout this
    program does not know (a newer release) stops with nothing changed."""
    try:
        with Path(iso_path).open("rb") as handle:
            files = _iso_index(handle)
            config = _iso_bytes(handle, files, "isolinux/isolinux.cfg").decode("utf-8", "replace")
            block = _choose_block(_boot_blocks(config), role)
            grub = _iso_bytes(handle, files, "EFI/BOOT/BOOTX64.EFI")
            missing = [path for path in (INSTALLER_IMAGE_MARKER, block["linux"], block["initrd"]) if not _iso_has(files, path)]
            if missing:
                raise ValueError("missing " + ", ".join(missing))
            # A directory entry alone does not prove its boot file can load.
            # Use the same bounded, nonempty reads as Linux extraction before
            # Windows can shrink a partition or arm a one-time boot.
            for path in (block["linux"], block["initrd"]):
                _iso_bytes(handle, files, path)
    except (OSError, ValueError, KeyError) as exc:
        invariant(False, "the installer image does not have the boot layout this installer expects", NEWER_RELEASE_FIX, role=role, problem=str(exc))
    return block["linux"], block["initrd"], block.get("append", ""), grub


class WindowsUndo:
    """Steps to take back if a later step fails. Run newest first."""

    def __init__(self):
        self.steps = []

    def add(self, what, action):
        self.steps.append((what, action))

    def extend(self, other):
        self.steps.extend(other.steps)
        other.steps = []

    def run(self):
        """Take every step back, newest first. Keep failed actions available to retry."""
        failed, remaining = [], []
        for what, action in reversed(self.steps):
            try:
                action()
                log(f"undo ok: {what}")
            except Exception as exc:  # best effort: report every step, stop on none
                failed.append(what)
                remaining.append((what, action))
                log(f"undo FAILED: {what}: {exc} {getattr(exc, 'context', '')}", "ERROR")
                say(f"Could not undo: {what}. See the log; Windows disk tools can finish it.")
        self.steps = list(reversed(remaining))
        return failed


def undo_boot_attempt(attempt, boot_undo):
    """A failed mechanism must be completely removed before another is attempted."""
    failed = attempt.run()
    boot_undo.extend(attempt)
    invariant(not failed, "the handoff stopped after a one-time boot cleanup failure",
              "No restart was scheduled. Run the installer again to check and recover any remaining boot changes before retrying.",
              cleanup_failed="; ".join(failed))


class WindowsJournal:
    """Every change a Windows conversion makes, written to disk before it is made. A run that
    is killed (Task Manager, a power cut) cannot undo itself in memory; the next run reads
    this and takes the changes back before it starts. It is kept after the restart is
    scheduled too: `shutdown /a` leaves the one-time boot armed until the next run."""

    # v2 records the partition baseline/extent needed for safe crash recovery.
    # Older installers must refuse it rather than use their size-only fallback.
    VERSION = 2

    def __init__(self, directory=None):
        self.path = Path(directory or state_dir()) / WINDOWS_JOURNAL_NAME
        self.data = {}

    def peek(self):
        """The record of an unfinished run, or None. Never raises: the review only reports it."""
        try:
            return self.load()
        except Invariant:
            return {"unreadable": True}

    def load(self):
        if not self.path.is_file():
            return None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            invariant(False, "the record of an earlier Windows conversion cannot be read", WINDOWS_RECOVERY_FIX + f" Then delete {self.path}.",
                      file=str(self.path), error=str(exc))
        version = data.get("version") if isinstance(data, dict) else None
        invariant(type(version) is int and version in (1, self.VERSION),
                  "the record of an earlier Windows conversion was written by a different installer version",
                  "Run the latest Fleet installer: it takes the earlier conversion back. " + NEWER_RELEASE_FIX,
                  file=str(self.path), version=version)
        self.data = data
        return data

    def record(self, **values):
        self.data.update(values)
        self.data["version"] = self.VERSION
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        write_durably(temporary, json.dumps(self.data, sort_keys=True).encode("utf-8"))
        os.replace(temporary, self.path)

    def clear(self):
        self.path.unlink(missing_ok=True)
        self.data = {}


def is_fleet_grub_config(data):
    return b"Fleet installer: ERASES" in bytes(data or b"")


def boot_option_description(option):
    """The description of an EFI_LOAD_OPTION (after UINT32 attributes and UINT16 path length)."""
    raw = bytes(option or b"")[6:]
    end = next((index for index in range(0, len(raw) - 1, 2) if raw[index:index + 2] == b"\0\0"), None)
    return raw[:end].decode("utf-16-le", "replace") if end is not None else None


def bcd_sequence(shown):
    """The {fwbootmgr} one-time boot entry in `bcdedit /enum {fwbootmgr}` output, if any."""
    match = re.search(r"bootsequence\s+(" + GUID_RE.pattern + ")", shown or "", re.I)
    return match.group(1) if match else None


def _recover_bcd(entry, previous):
    current = bcd_sequence(bcd("/enum", "{fwbootmgr}"))
    if current is not None and current.lower() == entry.lower():
        if previous and previous != entry:
            bcd("/set", "{fwbootmgr}", "bootsequence", previous)
            expected = previous
        else:
            bcd("/deletevalue", "{fwbootmgr}", "bootsequence")
            expected = None
        restored = bcd_sequence(bcd("/enum", "{fwbootmgr}"))
        invariant((restored or "").lower() == (expected or "").lower(),
                  "Windows did not keep the restored one-time boot choice", WINDOWS_RECOVERY_FIX, entry=entry)
    # A failed enum-by-id is ambiguous (missing entry or a permission/probe
    # failure). A successful full enumeration proves the entry is absent.
    listed = {match.group(0).lower() for match in GUID_RE.finditer(bcd("/enum", "all"))}
    if entry.lower() in listed:
        bcd("/delete", entry)  # the default /cleanup also takes it out of the display order
        listed = {match.group(0).lower() for match in GUID_RE.finditer(bcd("/enum", "all"))}
    invariant(entry.lower() not in listed, "Windows did not remove the recorded boot entry", WINDOWS_RECOVERY_FIX, entry=entry)


def _recover_nvram(firmware, number, previous_next):
    name = boot_variable_name(number)
    chosen = firmware.read("BootNext")
    if chosen is not None and chosen[0] == struct.pack("<H", number):
        previous = (bytes.fromhex(previous_next[0]), int(previous_next[1])) if previous_next else None
        restore_firmware_variable(firmware, "BootNext", previous)
    order = firmware.read("BootOrder")
    if order is not None and number in parse_boot_order(order[0]):
        restored = (b"".join(struct.pack("<H", item) for item in parse_boot_order(order[0]) if item != number), order[1])
        restore_firmware_variable(firmware, "BootOrder", restored)
    stored = firmware.read(name)
    # Only an option this program wrote: the number may have been reused since.
    if stored is not None and boot_option_description(stored[0]) == BOOT_DESCRIPTION:
        restore_firmware_variable(firmware, name, None)


def _recover_esp(data):
    mount = json_from_output(windows_ps(ps_mount_esp_script()))
    esp, mounted = Path(mount["Root"]), mount["Letter"]
    try:
        if not data.get("esp_touched"):
            return  # the attempt mounted the partition but never changed its files
        loader = esp.joinpath(*BOOT_LOADER_PARTS)
        if loader.parent.exists():
            shutil.rmtree(loader.parent)
        cfg = esp / "EFI" / "BOOT" / "grub.cfg"
        saved = data.get("grub_cfg_saved")
        if saved is not None:
            write_durably(cfg, bytes.fromhex(saved))
        elif cfg.is_file() and is_fleet_grub_config(cfg.read_bytes()):
            cfg.unlink()
    finally:
        windows_ps(ps_unmount_script(mounted))


def _partition_guid(value):
    try:
        guid = uuid.UUID(str(value).strip("{}"))
    except (ValueError, AttributeError):
        invariant(False, "a Windows partition has no valid identity", WINDOWS_RECOVERY_FIX, guid=value)
    invariant(guid.int != 0, "a Windows partition has an empty identity", WINDOWS_RECOVERY_FIX)
    return str(guid)


def _linux_partitions(layout):
    listed = layout.get("Parts") or []
    parts = [listed] if isinstance(listed, dict) else listed
    invariant(isinstance(parts, list) and all(isinstance(item, dict) for item in parts),
              "Windows did not describe its Linux partitions safely", WINDOWS_RECOVERY_FIX)
    return parts


def _partition_extent(layout, freed, size):
    raw = layout.get("Offset")
    invariant(isinstance(raw, int) and not isinstance(raw, bool) and raw > 0,
              "Windows did not identify the freed partition extent safely", WINDOWS_RECOVERY_FIX, offset=raw)
    start, end = (raw + MIB - 1) // MIB * MIB, raw + freed
    invariant(end - start >= size, "the freed partition extent cannot hold the installer", WINDOWS_RECOVERY_FIX,
              start=start, end=end, size=size)
    return start, end


def _recover_partition(data):
    disk = int(data["disk"])
    parts = _linux_partitions(json_from_output(windows_ps(ps_linux_partitions_script(disk))))
    guid = data.get("partition_guid")
    if guid:
        wanted = _partition_guid(guid)
        before = data.get("partition_guids_before")
        invariant(not isinstance(before, list) or wanted not in {_partition_guid(value) for value in before},
                  "the earlier installer partition was already present before staging", WINDOWS_RECOVERY_FIX, guid=wanted)
        matches = [item for item in parts if _partition_guid(item.get("Guid")) == wanted]
    elif not parts:
        return
    else:
        # A crash may happen before New-Partition, so size alone proves nothing.
        # Only a new identity at the exact location reserved by this attempt is ours.
        baseline = data.get("partition_guids_before")
        start, end = data.get("partition_extent_start"), data.get("partition_extent_end")
        invariant(isinstance(baseline, list) and isinstance(start, int) and isinstance(end, int) and 0 < start < end,
                  "the earlier installer partition cannot be identified safely", WINDOWS_RECOVERY_FIX)
        before = {_partition_guid(value) for value in baseline}
        new = [item for item in parts if _partition_guid(item.get("Guid")) not in before]
        matches = [item for item in new if int(item.get("Offset") or 0) == start
                   and int(item.get("Size") or 0) >= int(data["partition_size"])
                   and start + int(item.get("Size") or 0) <= end]
        invariant(len(new) == len(matches), "the earlier installer partition cannot be identified safely", WINDOWS_RECOVERY_FIX,
                  unexpected=[item.get("Number") for item in new if item not in matches])
    invariant(len(matches) <= 1, "more than one partition could be the earlier installer partition", WINDOWS_RECOVERY_FIX,
              found=[item.get("Number") for item in matches])
    for item in matches:
        windows_ps(ps_remove_partition_script(disk, int(item["Number"])))


def cancel_windows_restart():
    """Confirm no timed restart remains before dismantling its boot resources.

    ERROR_NO_SHUTDOWN_IN_PROGRESS (1116) also proves the prerequisite, including
    after a user already ran shutdown /a. Never infer success from localized text.
    """
    try:
        result = run_logged([os.environ.get("FLEET_SHUTDOWN", "shutdown"), "/a"], capture_output=True,
                            text=True, errors="replace", stdin=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        invariant(False, "the scheduled restart could not be confirmed cancelled", WINDOWS_RESTART_RECOVERY_FIX,
                  problem=f"{type(exc).__name__}: {exc}")
    invariant(result.returncode in (0, 1116), "the scheduled restart could not be confirmed cancelled",
              WINDOWS_RESTART_RECOVERY_FIX, code=result.returncode)
    log("the scheduled restart was cancelled" if result.returncode == 0 else "no scheduled restart remains")


def recover_windows_staging(firmware=None, directory=None):
    """Take back what an unfinished earlier conversion changed, from its record. Every
    step checks what is there first, so running it twice changes nothing the second
    time. Returns the (now empty) journal for the next run to record into."""
    journal = WindowsJournal(directory)
    data = journal.load()
    if not data:
        return journal
    say("An earlier conversion on this computer did not finish. Taking back what it changed first.")
    failed = []

    def step(what, action):
        try:
            action()
            log(f"recovered: {what}")
        except Exception as exc:  # each step on its own; report all of them
            failed.append(what)
            log(f"recovery FAILED: {what}: {exc} {getattr(exc, 'context', '')}", "ERROR")

    if data.get("restart_scheduled"):
        cancel_windows_restart()  # a failed abort must stop before any boot or disk changes
    if data.get("bcd_entry"):
        step("remove the Windows boot manager entry", lambda: _recover_bcd(data["bcd_entry"], data.get("bcd_previous_sequence")))
    if data.get("boot_number") is not None:
        if firmware is None:
            failed.append("remove the firmware boot option (UEFI variables are not available here)")
        else:
            step("remove the firmware boot option", lambda: _recover_nvram(firmware, int(data["boot_number"]), data.get("boot_next_before")))
    invariant(not failed, "an earlier unfinished conversion could not be taken back completely", WINDOWS_RECOVERY_FIX,
              failed="; ".join(failed), record=str(journal.path))
    if data.get("esp_touched") or data.get("esp_letter"):
        step("remove the boot loader from the EFI system partition", lambda: _recover_esp(data))
    if data.get("partition_size"):
        step("remove the installer partition", lambda: _recover_partition(data))
    if data.get("original_size"):
        step(f"give {data.get('letter')}: its space back",
             lambda: windows_ps(ps_restore_script(data["letter"], int(data["original_size"])), timeout=7200))
    invariant(not failed, "an earlier unfinished conversion could not be taken back completely", WINDOWS_RECOVERY_FIX,
              failed="; ".join(failed), record=str(journal.path))
    journal.clear()
    WINDOWS["facts"] = None
    say("The earlier conversion was taken back.")
    return journal


def bcd(*args):
    tool = os.environ.get("FLEET_BCDEDIT", "bcdedit")
    done = run_logged([tool, *args], capture_output=True, text=True, errors="replace", stdin=subprocess.DEVNULL)
    invariant(done.returncode == 0, "bcdedit refused a firmware boot entry change", "Windows was not changed beyond what was undone. Make an install USB with the word flash.",
              args=" ".join(args), code=done.returncode, error=(done.stdout or done.stderr or "").strip()[-200:])
    return done.stdout


def bcd_one_time_boot(undo, journal=None):
    """Mechanism one: a Windows boot manager entry for the loader, run once. Returns its id."""
    previous = bcd_sequence(bcd("/enum", "{fwbootmgr}"))
    copied = GUID_RE.search(bcd("/copy", "{bootmgr}", "/d", BOOT_DESCRIPTION))
    invariant(copied is not None, "bcdedit gave no id for the new boot entry")
    entry = copied.group(0)
    # A journal write can fail too; the entry already exists at this point.
    undo.add("delete the firmware boot entry", lambda: _recover_bcd(entry, previous))
    if journal is not None:
        journal.record(bcd_entry=entry, bcd_previous_sequence=previous)
    bcd("/set", entry, "path", BOOT_LOADER_FIRMWARE_PATH)
    # Last in the normal order, so a firmware that ignores the one-time choice starts Windows, not the installer.
    # Entry deletion already covers an add that fails after changing the menu.
    bcd("/set", "{fwbootmgr}", "displayorder", entry, "/addlast")
    undo.add("take the entry out of the firmware boot menu", lambda: bcd("/set", "{fwbootmgr}", "displayorder", entry, "/remove"))
    if previous:
        undo.add("restore the earlier one-time boot choice", lambda: bcd("/set", "{fwbootmgr}", "bootsequence", previous))
    else:
        undo.add("clear the one-time boot choice", lambda: bcd("/deletevalue", "{fwbootmgr}", "bootsequence"))
    bcd("/set", "{fwbootmgr}", "bootsequence", entry)
    shown = bcd("/enum", "{fwbootmgr}")
    invariant(re.search(r"bootsequence\s+" + re.escape(entry), shown, re.I) is not None,
              "the firmware did not accept the one-time boot entry", "Windows was left as it was. Make an install USB with the word flash.", entry=entry)
    return entry


# ---- UEFI variables, written directly ----------------------------------------------
# The second one-time boot mechanism, the way efibootmgr does it, independent of
# bcdedit. Layouts (UEFI specification 2.10, sections 3.1.3 and 10):
#
#   EFI_LOAD_OPTION (the value of the variable Boot####, #### = four hex digits)
#     UINT32  Attributes            bit 0 = LOAD_OPTION_ACTIVE
#     UINT16  FilePathListLength    bytes in FilePathList
#     CHAR16  Description[]         UTF-16LE, ends with a 16-bit zero
#     EFI_DEVICE_PATH_PROTOCOL FilePathList[]   nodes, ending with an End node
#     UINT8   OptionalData[]        none here
#
#   Every device path node starts with: UINT8 Type, UINT8 SubType, UINT16 Length (the whole node)
#   Hard Drive media node: Type 4, SubType 1, Length 42
#     UINT32 PartitionNumber, UINT64 PartitionStart (LBA), UINT64 PartitionSize (sectors),
#     UINT8[16] Signature (the partition GUID), UINT8 MBRType (2 = GPT), UINT8 SignatureType (2 = GUID)
#   File Path media node: Type 4, SubType 4, Length 4 + bytes, then CHAR16 path ending with a 16-bit zero
#   End of entire path node: Type 0x7F, SubType 0xFF, Length 4
#
# A GUID is stored mixed-endian: the first three fields little-endian, the last
# eight bytes as written (Python: uuid.UUID(text).bytes_le).
# BootNext is a UINT16 option number; a variable's attributes are NV|BS|RT = 7.

EFI_GLOBAL_GUID = "{8BE4DF61-93CA-11D2-AA0D-00E098032B8C}"
EFI_ATTR_NV_BS_RT = 0x07
LOAD_OPTION_ACTIVE = 0x00000001
EFI_END_NODE = b"\x7f\xff\x04\x00"
ERROR_ENVVAR_NOT_FOUND = 203
ERROR_NOT_ALL_ASSIGNED = 1300
VARIABLE_READ_MAX = 4096


def efi_guid_bytes(text):
    return uuid.UUID(str(text).strip("{}")).bytes_le


def efi_hard_drive_node(partition_number, start_lba, size_lba, signature_guid):
    invariant(partition_number >= 1 and start_lba >= 1 and size_lba >= 1, "a hard drive device path node needs a real partition", number=partition_number, start=start_lba, size=size_lba)
    return struct.pack("<BBHIQQ16sBB", 0x04, 0x01, 42, partition_number, start_lba, size_lba, efi_guid_bytes(signature_guid), 0x02, 0x02)


def efi_file_node(path):
    raw = path.encode("utf-16-le") + b"\x00\x00"
    return struct.pack("<BBH", 0x04, 0x04, 4 + len(raw)) + raw


def efi_load_option(description, node_list, attributes=LOAD_OPTION_ACTIVE):
    listing = b"".join(node_list) + EFI_END_NODE
    return struct.pack("<IH", attributes, len(listing)) + description.encode("utf-16-le") + b"\x00\x00" + listing


def loader_load_option(part, sector):
    """Boot#### for the loader on the EFI system partition described by part (Get-Partition facts)."""
    offset, size = int(part["Offset"]), int(part["Size"])
    invariant(sector in (512, 4096) and offset % sector == 0 and size % sector == 0 and offset > 0,
              "the EFI system partition does not line up with the disk's sectors", sector=sector, offset=offset, size=size)
    node = efi_hard_drive_node(int(part["Number"]), offset // sector, size // sector, part["Guid"])
    return efi_load_option(BOOT_DESCRIPTION, [node, efi_file_node(BOOT_LOADER_FIRMWARE_PATH)])


def boot_variable_name(number):
    invariant(0 <= number <= 0xFFFF, "a boot option number is 16 bits", number=number)
    return f"Boot{number:04X}"


def parse_boot_order(data):
    return list(struct.unpack(f"<{len(data) // 2}H", data[:len(data) // 2 * 2]))


class WindowsFirmware:
    """UEFI variables through kernel32, the way efibootmgr uses the kernel. Only an
    elevated Windows process can use it. kernel and advapi are the loaded DLLs; tests
    hand in stand-ins so nothing here ever reaches real firmware off Windows."""

    def __init__(self, kernel=None, advapi=None):
        import ctypes
        from ctypes import wintypes
        self.ctypes, self.wintypes = ctypes, wintypes
        if kernel is None:
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel, self.advapi = kernel, advapi
        kernel.GetFirmwareEnvironmentVariableExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetFirmwareEnvironmentVariableExW.restype = wintypes.DWORD
        kernel.SetFirmwareEnvironmentVariableExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD]
        kernel.SetFirmwareEnvironmentVariableExW.restype = wintypes.BOOL
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi.OpenProcessToken.restype = wintypes.BOOL
        advapi.LookupPrivilegeValueW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
        advapi.LookupPrivilegeValueW.restype = wintypes.BOOL
        advapi.AdjustTokenPrivileges.argtypes = [wintypes.HANDLE, wintypes.BOOL, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
        advapi.AdjustTokenPrivileges.restype = wintypes.BOOL

    def last_error(self):
        getter = getattr(self.ctypes, "get_last_error", None)
        return getter() if getter else 0

    def clear_error(self):
        setter = getattr(self.ctypes, "set_last_error", None)
        if setter:
            setter(0)

    def fail(self, what, code=None):
        code = self.last_error() if code is None else code
        return OSError(code, f"{what} failed with Windows error {code}")

    def enable_privilege(self):
        """SeSystemEnvironmentPrivilege is in an elevated token but switched off until asked for."""
        ctypes, wintypes = self.ctypes, self.wintypes

        class LUID(ctypes.Structure):
            _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]

        class LuidAndAttributes(ctypes.Structure):
            _fields_ = [("Luid", LUID), ("Attributes", wintypes.DWORD)]

        class TokenPrivileges(ctypes.Structure):
            _fields_ = [("PrivilegeCount", wintypes.DWORD), ("Privileges", LuidAndAttributes * 1)]

        token = wintypes.HANDLE()
        self.clear_error()
        if not self.advapi.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x0020 | 0x0008, ctypes.byref(token)):  # TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY
            raise self.fail("OpenProcessToken")
        try:
            luid = LUID()
            if not self.advapi.LookupPrivilegeValueW(None, "SeSystemEnvironmentPrivilege", ctypes.byref(luid)):
                raise self.fail("LookupPrivilegeValueW")
            request = TokenPrivileges(1, (LuidAndAttributes * 1)(LuidAndAttributes(luid, 0x00000002)))  # SE_PRIVILEGE_ENABLED
            self.clear_error()
            if not self.advapi.AdjustTokenPrivileges(token, False, ctypes.byref(request), 0, None, None):
                raise self.fail("AdjustTokenPrivileges")
            # The call succeeds even when the privilege is not in the token; only the last error says so.
            if self.last_error() == ERROR_NOT_ALL_ASSIGNED:
                raise self.fail("AdjustTokenPrivileges", ERROR_NOT_ALL_ASSIGNED)
        finally:
            self.kernel.CloseHandle(token)

    def read(self, name):
        """(value bytes, attributes), or None when the variable does not exist."""
        ctypes, wintypes = self.ctypes, self.wintypes
        buffer = ctypes.create_string_buffer(VARIABLE_READ_MAX)
        attributes = wintypes.DWORD(0)
        self.clear_error()
        count = self.kernel.GetFirmwareEnvironmentVariableExW(name, EFI_GLOBAL_GUID, buffer, VARIABLE_READ_MAX, ctypes.byref(attributes))
        if count == 0:
            code = self.last_error()
            if code == ERROR_ENVVAR_NOT_FOUND:
                return None
            if code != 0:
                raise self.fail(f"reading {name}", code)
        return buffer.raw[:count], int(attributes.value)

    def write(self, name, data, attributes=EFI_ATTR_NV_BS_RT):
        ctypes = self.ctypes
        buffer = ctypes.create_string_buffer(bytes(data), len(data))
        self.clear_error()
        if not self.kernel.SetFirmwareEnvironmentVariableExW(name, EFI_GLOBAL_GUID, buffer, len(data), attributes):
            raise self.fail(f"writing {name}")

    def delete(self, name):
        self.clear_error()
        if not self.kernel.SetFirmwareEnvironmentVariableExW(name, EFI_GLOBAL_GUID, None, 0, EFI_ATTR_NV_BS_RT):
            code = self.last_error()
            if code != ERROR_ENVVAR_NOT_FOUND:
                raise self.fail(f"deleting {name}", code)


class FileFirmware:
    """UEFI variables kept as files in a directory: a stand-in for tests. It is chosen only
    through FLEET_FIRMWARE_STANDIN and replaces the real implementation; it cannot reach firmware."""

    def __init__(self, directory):
        self.directory = Path(directory)
        invariant(self.directory.is_dir(), "the firmware stand-in must be an existing directory", path=str(directory))

    def read(self, name):
        path = self.directory / name
        if not path.is_file():
            return None
        raw = path.read_bytes()
        return raw[4:], int.from_bytes(raw[:4], "little")

    def write(self, name, data, attributes=EFI_ATTR_NV_BS_RT):
        (self.directory / name).write_bytes(int(attributes).to_bytes(4, "little") + bytes(data))

    def delete(self, name):
        (self.directory / name).unlink(missing_ok=True)


def open_firmware():
    """The object that reads and writes UEFI variables, or None when this process cannot.
    Any test redirect (FLEET_WINDOWS_TARGET) without a stand-in means no firmware at all:
    a test must never be able to reach the real variables."""
    standin = os.environ.get("FLEET_FIRMWARE_STANDIN")
    if standin:
        return FileFirmware(standin)
    if os.environ.get("FLEET_WINDOWS_TARGET") or os.name != "nt":
        return None
    try:
        firmware = WindowsFirmware()
        firmware.enable_privilege()
        return firmware
    except (AttributeError, OSError, ImportError) as exc:
        log(f"UEFI variables are not available: {exc}", "WARN")
        return None


def free_boot_number(firmware, in_order):
    taken = set(in_order)
    for number in range(0x10000):
        if number not in taken and firmware.read(boot_variable_name(number)) is None:
            return number
    invariant(False, "the firmware has no free boot option number")


def restore_firmware_variable(firmware, name, previous):
    """Skip a refused write that changed nothing; prove every actual restoration."""
    if firmware.read(name) == previous:
        return
    if previous is None:
        firmware.delete(name)
    else:
        firmware.write(name, previous[0], previous[1])
    invariant(firmware.read(name) == previous, "the firmware did not keep a boot variable restoration",
              WINDOWS_RECOVERY_FIX, variable=name)


def nvram_one_time_boot(firmware, part, sector, undo, journal=None):
    """Mechanism two: a Boot#### load option for the loader, appended to BootOrder (so
    firmware that discards options it does not list keeps it, and never first), and
    BootNext pointed at it. Every write registers its undo first. Returns the number."""
    order = firmware.read("BootOrder")
    current = parse_boot_order(order[0]) if order else []
    number = free_boot_number(firmware, current)
    name, option = boot_variable_name(number), loader_load_option(part, sector)
    previous = firmware.read("BootNext")
    if journal is not None:
        journal.record(boot_number=number, boot_next_before=[previous[0].hex(), previous[1]] if previous else None)
    undo.add(f"delete the firmware boot option {name}", lambda: restore_firmware_variable(firmware, name, None))
    firmware.write(name, option)
    if order is not None:
        original, attributes = order
        undo.add("restore the firmware boot order", lambda: restore_firmware_variable(firmware, "BootOrder", order))
        firmware.write("BootOrder", original + struct.pack("<H", number), attributes)
    if previous is None:
        undo.add("clear the firmware one-time boot choice", lambda: restore_firmware_variable(firmware, "BootNext", None))
    else:
        undo.add("restore the firmware one-time boot choice", lambda: restore_firmware_variable(firmware, "BootNext", previous))
    firmware.write("BootNext", struct.pack("<H", number))
    return number, option


def verify_nvram(firmware, number, option):
    """Read everything back. Returns a list of what is wrong; empty means the firmware holds it."""
    problems = []
    name = boot_variable_name(number)
    stored = firmware.read(name)
    if stored is None or stored[0] != option:
        problems.append(f"{name} does not hold the loader entry")
    chosen = firmware.read("BootNext")
    if chosen is None or chosen[0] != struct.pack("<H", number):
        problems.append("BootNext does not point at it")
    return problems


def discard_installer_copy(iso):
    """Delete the downloaded installer, but only the installer's own cache file (it has been
    written to the new partition and read back; the copy only takes space on C:)."""
    path = Path(iso)
    try:
        folder = path.resolve().parent
        cache = os.environ.get("FLEET_CACHE") or os.path.join(os.environ.get("LOCALAPPDATA") or "", "fleet-installer")
        ours = path.name == "fleet-installer.iso" and (
            folder == state_dir().resolve() or folder == Path(cache).resolve()
            or (folder.name == "fleet-installer" and "appdata" in [part.lower() for part in folder.parts]))
        if ours and path.is_file():
            path.unlink()
            log(f"removed the downloaded installer {path}")
            return True
    except OSError as exc:
        log(f"could not remove the downloaded installer {path}: {exc}", "WARN")
    return False


def write_durably(path, data):
    with open(path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def stage_windows(role, iso, token=None, vault=None, chosen=None, on_progress=None, writer=None, firmware="auto", wifi=None):
    """Carve a partition out of C:, put the installer in it, and arrange one boot
    into it. Returns 0 once the restart is scheduled; anything else changed nothing.
    firmware is the UEFI variable access (tests hand in a stand-in); "auto" asks open_firmware()."""
    writer = writer or write_region
    invariant(role in ROLES, "refusing to stage an unknown role", role=role)
    iso_size = os.path.getsize(iso)
    if firmware == "auto":
        firmware = open_firmware()
    # A run that was killed part way left changes nobody took back; take them back first.
    journal = recover_windows_staging(firmware)
    WINDOWS["facts"] = None  # the download changed what C: can give up; ask again
    findings = windows_findings(iso_size, chosen["path"] if chosen else None, iso_path=iso)
    problems = [item for item in findings if item["status"] == "fail"]
    if problems:
        say("Next: " + problems[0]["fix"] + " Nothing was written.")
        return 2
    facts = windows_facts()
    ram = memory_finding(facts.get("Memory"), iso_size)
    if ram is not None and ram["status"] == "fail":
        say("Next: " + ram["fix"] + " Nothing was written.")
        return 2
    linux_path, initrd_path, append, grub = iso_boot_material(iso, role)
    cmdline = _boot_command(append, role, iso, token, vault, devbox_key() if role == "devbox" else None, findiso=False, origin="windows", wifi=wifi is not None)
    wireless_initrd = wifi_module().initrd(wifi) if wifi is not None else b""
    config = grub_config(role, linux_path, initrd_path, cmdline, wifi=wifi is not None)
    disk, need, letter = int(facts["DiskNumber"]), windows_need(iso_size), facts["Letter"]
    sector = int(facts.get("LogicalSectorSize") or 512)
    invariant(WRITE_SECTOR % sector == 0, "the disk's sector size does not divide the write alignment", sector=sector)
    original_size = int(facts["Size"])
    undo = WindowsUndo()
    boot_undo = WindowsUndo()
    restart_scheduled = False
    try:
        # Recorded before each change, so a killed run can be taken back by the next one.
        journal.record(letter=letter, disk=disk, original_size=original_size, role=role, started=_stamp())
        say(f"Making room: shrinking {letter}: by {need // MIB} MiB.")
        undo.add(f"give {letter}: its space back", lambda: windows_ps(ps_restore_script(letter, original_size), timeout=7200))
        windows_ps(ps_shrink_script(letter, original_size - need), timeout=7200)
        layout = json_from_output(windows_ps(ps_linux_partitions_script(disk, letter)))
        previous_guids = [_partition_guid(item.get("Guid")) for item in _linux_partitions(layout)]
        start, end = _partition_extent(layout, need, padded_size(iso_size))
        journal.record(partition_size=padded_size(iso_size), partition_guids_before=previous_guids,
                       partition_extent_start=start, partition_extent_end=end)
        undo.add("remove the installer partition", lambda: _recover_partition(journal.data))
        created = json_from_output(windows_ps(ps_new_partition_script(disk, padded_size(iso_size), start)))
        guid = _partition_guid(created.get("Guid"))
        invariant(guid not in previous_guids, "Windows reused an existing partition identity", WINDOWS_RECOVERY_FIX, guid=guid)
        journal.record(partition_guid=guid)
        invariant(created["Size"] >= padded_size(iso_size) and created["Offset"] == start and created["Offset"] + created["Size"] <= end,
                  "Windows made a partition that cannot hold the installer", created=created)
        say("Writing the installer into the new partition and reading it back.")
        alternate = windows_partition_target(disk, created["Number"])
        writer(iso, windows_disk_target(disk), int(created["Offset"]), ISO_SYSTEM_AREA, on_progress, (alternate, 0) if alternate else None)
        say("Placing the boot loader on the EFI system partition.")
        mount = json_from_output(windows_ps(ps_mount_esp_script()))
        esp, mounted = Path(mount["Root"]), mount["Letter"]
        # The drive letter disappears before restart scheduling. Recovery must
        # remount the ESP rather than keep closures over paths on that letter.
        undo.add("restore the EFI system partition", lambda: _recover_esp(journal.data))
        journal.record(esp_letter=mounted)
        loader = esp.joinpath(*BOOT_LOADER_PARTS)
        free = shutil.disk_usage(esp).free + (loader.stat().st_size if loader.is_file() else 0)
        invariant(free >= len(grub) + len(config) + len(wireless_initrd) + LOADER_SLACK, "the EFI system partition has too little free space for the boot loader",
                  "Windows keeps some EFI system partitions nearly full. Free space there (docs/windows.md shows how), or make an install USB with the word flash.",
                  free=free, need=len(grub) + len(config) + len(wireless_initrd) + LOADER_SLACK)
        cfg = esp / "EFI" / "BOOT" / "grub.cfg"
        # A grub.cfg this program wrote earlier is not the owner's: never keep or restore it.
        saved = cfg.read_bytes() if cfg.is_file() and not is_fleet_grub_config(cfg.read_bytes()) else None
        journal.record(esp_touched=True, grub_cfg_saved=saved.hex() if saved is not None else None)
        if loader.parent.exists():
            shutil.rmtree(loader.parent)  # no stale file (an old Wi-Fi handoff) survives into this run
        loader.parent.mkdir(parents=True, exist_ok=True)
        write_durably(loader, grub)
        if wireless_initrd:
            private = loader.parent / "fleet-wifi.initrd"
            write_durably(private, wireless_initrd)
            invariant(private.read_bytes() == wireless_initrd, "the Wi-Fi boot handoff did not read back correctly")
        cfg.parent.mkdir(parents=True, exist_ok=True)
        write_durably(cfg, config.encode("utf-8"))
        invariant(cfg.read_text(encoding="utf-8") == config and loader.read_bytes() == grub, "the EFI system partition did not keep the boot loader")
        say("Telling the firmware to start the installer once.")
        verified, problems = [], []
        entry = None
        attempt = WindowsUndo()
        try:
            entry = bcd_one_time_boot(attempt, journal)
            verified.append(f"bcdedit entry {entry}")
            boot_undo.extend(attempt)
        except (Invariant, OSError) as exc:
            problems.append(f"bcdedit: {getattr(exc, 'what', exc)}")
            log(f"bcdedit one-time boot failed: {exc} {getattr(exc, 'context', '')}", "ERROR")
            undo_boot_attempt(attempt, boot_undo)
        if firmware is not None:
            attempt = WindowsUndo()
            try:
                part = json_from_output(windows_ps(ps_partition_by_letter_script(mounted)))
                invariant(int(part["DiskNumber"]) == disk and part.get("GptType", "").lower() == ESP_GUID,
                          "the mounted EFI system partition is not on the disk being converted", part=part)
                number, option = nvram_one_time_boot(firmware, part, int(part.get("LogicalSectorSize") or sector), attempt, journal)
                wrong = verify_nvram(firmware, number, option)
                invariant(not wrong, "the firmware did not keep the boot option", problems=wrong)
                verified.append(f"firmware option {boot_variable_name(number)}")
                boot_undo.extend(attempt)
            except (Invariant, OSError, KeyError, ValueError) as exc:
                problems.append(f"firmware variables: {getattr(exc, 'what', exc)}")
                log(f"firmware one-time boot failed: {exc} {getattr(exc, 'context', '')}", "ERROR")
                undo_boot_attempt(attempt, boot_undo)
        else:
            problems.append("firmware variables: not available in this session")
        log("one-time boot installed: " + (", ".join(verified) or "none"))
        invariant(bool(verified), "no one-time boot entry could be installed and verified",
                  "Windows was left as it was. Make an install USB with the word flash.", problems="; ".join(problems))
        # Nothing else needs the EFI system partition; leave no drive letter behind.
        windows_ps(ps_unmount_script(mounted))
        journal.record(esp_letter=None)
        shutdown = os.environ.get("FLEET_SHUTDOWN", "shutdown")
        # Record the intent before invoking shutdown: a killed process or an
        # ambiguous launch failure must also cancel a possibly scheduled restart.
        journal.record(restart_scheduled=True)
        restart_scheduled = True
        restart = run_logged([shutdown, "/r", "/t", "15", "/c", "Fleet installer: this computer will erase its disk and become a " + role + " node."],
                             capture_output=True, text=True, errors="replace", stdin=subprocess.DEVNULL)
        invariant(restart.returncode == 0, "Windows would not schedule the restart",
                  "Every change was taken back. Restart Windows once (a pending update or another program may hold the restart), then run the installer again.",
                  code=restart.returncode)
        log("the restart is scheduled for 15 seconds from now")
        say("This computer restarts in 15 seconds into the installer, which then erases its disk. "
            "`shutdown /a` stops the restart but leaves the one-time boot armed: run the installer again to take it back "
            "(or remove it as docs/windows.md says), or the next restart starts the installer.")
    except BaseException as error:
        if restart_scheduled:
            try:
                cancel_windows_restart()
            except Exception as abort_error:
                raise Invariant("the conversion stopped and the scheduled restart could not be confirmed cancelled",
                                WINDOWS_RESTART_RECOVERY_FIX,
                                {"record": str(journal.path), "problem": str(abort_error)}) from error
        # Never remove the loader or installer while a one-time boot choice may
        # still point at them. The journal keeps both cleanup phases retryable.
        failed = boot_undo.run()
        if not failed:
            failed = undo.run()
        if not failed:
            journal.clear()
        elif isinstance(error, Exception):
            # The original fix would claim Windows was left as it was. Say what is still there;
            # the journal stays, so the next run takes the rest back.
            raise Invariant(f"the conversion stopped ({getattr(error, 'what', error)}) and some changes could not be taken back",
                            WINDOWS_RECOVERY_FIX + " Running the installer again also tries to take them back.",
                            {"not_undone": "; ".join(failed), "record": str(journal.path)}) from error
        raise
    discard_installer_copy(iso)
    return 0


def write_media(os_name, iso, device, wifi=None, capacity=None):
    if not device_ok(device):
        say("Next: the USB disk path was not usable. Nothing was written. Run this program again.")
        return 1
    tool = os.environ.get("FLEET_DD", "dd")
    if os_name == "Darwin" and device.startswith("/dev/"):
        target = "/dev/r" + device[len("/dev/"):]
        block = "bs=4m"
    else:
        target = device
        block = "bs=4M"
    completed = run_logged([tool, f"if={iso}", f"of={target}", block], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if completed.returncode != 0:
        say("Next: the USB disk could not be written. Nothing else was written. Run this program again from an administrator account.")
        return 1
    if capacity is not None and not wifi_module().simulated():
        wifi_module().write_trailer(target, capacity, os.path.getsize(iso), wifi)
    return 0


def load_role(argv_role):
    if argv_role:
        return argv_role.strip()
    say(f"Type the role ({ROLE_CHOICES}):")
    answer, timed_out = read_answer(os.environ.get("FLEET_CONFIRM_TIMEOUT", "120"))
    if timed_out or answer.strip() == "":
        say(f"Next: the role was not given. Nothing was written. Run this program again and type {ROLE_CHOICES}.")
        return None
    return answer.strip()


def choose_disk(os_name, action):
    try:
        disks = collect(os_name)
    except (OSError, RuntimeError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        return {"ok": False, "code": 2, "next": f"Next: the disks could not be listed ({exc}). Nothing was written. Run this program again."}
    return plan_disks(disks, action)


def cmd_fetch(argv):
    if len(argv) != 1:
        return fail("Next: give the file name where the installer should be saved. Nothing was written.", 2)
    return fetch_installer(argv[0])


VAULT_DEFAULT = ""
GUIDE_URL = "https://raw.githubusercontent.com/crvouga/fleet/main/packages/fleet/docs/agent-install.md"
X86 = ("x86_64", "amd64", "x64")
GIB = 1024 ** 3
MARK = {"ok": "ok  ", "info": "info", "warn": "WARN", "fail": "FAIL"}


def machine_arch():
    return (os.environ.get("FLEET_ARCH") or platform.machine() or "unknown").lower()


def effective_uid():
    override = os.environ.get("FLEET_EUID")
    if override not in (None, ""):
        try:
            return int(override)
        except ValueError:
            return None
    geteuid = getattr(os, "geteuid", None)
    return geteuid() if geteuid else None


def vault_addr():
    return (os.environ.get("FLEET_VAULT_ADDR") or VAULT_DEFAULT).rstrip("/")


def finding(name, status, detail, fix=""):
    return {"name": name, "status": status, "detail": detail, "fix": fix}


def mem_total(os_name):
    if os_name == "Linux":
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
        except (OSError, ValueError, IndexError):
            return None
    if os_name == "Darwin":
        try:
            return int(_run(["sysctl", "-n", "hw.memsize"]).strip())
        except (OSError, RuntimeError, ValueError):
            return None
    if os_name == "Windows":
        try:
            return int(_run([powershell_tool(), "-NoProfile", "-Command", ps_memory_script()]).strip())
        except (OSError, RuntimeError, ValueError):
            return None
    return None


def _curl_reason(done):
    lines = (done.stderr or "").strip().splitlines()
    return lines[-1] if lines else f"curl exited {done.returncode}"


def probe_installer():
    """Ask for one byte of the installer. Returns (error, total size or None)."""
    iso_url, _ = installer_urls()
    tool = os.environ.get("FLEET_CURL", "curl")
    with tempfile.TemporaryDirectory(prefix="fleet-probe-") as scratch:
        headers = Path(scratch) / "headers"
        try:
            done = run_logged(
                [tool, "-fsSL", "--max-time", "30", "-r", "0-0", "-D", str(headers), "-o", os.devnull, iso_url],
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            return f"curl could not run ({exc})", None
        if done.returncode != 0:
            try:
                return None, installer_parts(iso_url)["size"]
            except (OSError, RuntimeError, ValueError) as exc:
                return f"{_curl_reason(done)}; multipart release: {exc}", None
        size = None
        if headers.is_file():
            for line in headers.read_text(errors="replace").splitlines():
                match = re.match(r"(?i)content-range:\s*bytes\s+\d+-\d+/(\d+)", line.strip())
                if match:
                    size = int(match.group(1))
        return None, size


def lookup_verdict(role, status, reason, data):
    """Turn Vault's answer to sys/wrapping/lookup into a finding. status is the
    HTTP status, or None when Vault could not be reached at all."""
    if status in (400, 403, 404):
        return finding("enrollment", "fail", "the token is spent, expired, or not a wrapping token",
                       f"Mint a new single-use token with: just enroll {role or '<role>'}")
    if status != 200:
        return finding("enrollment", "fail", f"Vault at {vault_addr()} did not answer ({reason})",
                       "Check this machine's network and that Vault is up, then run this program again.")
    if not isinstance(data, dict):
        return finding("enrollment", "fail", "Vault answered with something that is not JSON",
                       f"Check that {vault_addr()} is the Vault address, then run this program again.")
    path = str(data.get("creation_path") or "").rstrip("/")
    if role and not path.endswith(f"fleet/{role}"):
        return finding("enrollment", "fail", f"the token was minted for {path or 'something else'}, not the {role} key",
                       f"Mint a token for this role with: just enroll {role}")
    return finding("enrollment", "ok", f"token is valid for {role or path} and has not been used")


def lookup_token(token, role):
    """Check a wrapping token without spending it. Returns a finding."""
    tool = os.environ.get("FLEET_CURL", "curl")
    url = f"{vault_addr()}/v1/sys/wrapping/lookup"
    with tempfile.TemporaryDirectory(prefix="fleet-lookup-") as scratch:
        body = Path(scratch) / "body"
        fd = os.open(body, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"token": token}, handle)
        reply = Path(scratch) / "reply"
        try:
            done = run_logged(
                [tool, "-fsS", "--max-time", "20", "-X", "POST", "-H", "Content-Type: application/json",
                 "--data-binary", f"@{body}", "-o", str(reply), url],
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            return finding("enrollment", "fail", f"curl could not run ({exc})", "Install curl, then run this program again.")
        if done.returncode != 0:
            reason = _curl_reason(done)
            seen = re.search(r"error: (\d{3})", reason)
            return lookup_verdict(role, int(seen.group(1)) if seen else None, reason, None)
        try:
            data = json.loads(reply.read_text(encoding="utf-8")).get("data") or {}
        except (OSError, ValueError, AttributeError):
            data = None
    return lookup_verdict(role, 200, "", data)


# The wizard replaces these with versions that do not need curl.
NET = {}


def preflight(os_name, role, action, token, directory, need_root=True, ssh_key=None, auto_enroll=False, disk_path=None, iso_path=None):
    """Everything that can be known before anything is erased. All problems are
    reported together so one fix pass is enough."""
    found = []
    uid = effective_uid()
    if not need_root:
        found.append(finding("privilege", "info", "the OS asks for permission when the install starts"))
    elif os_name in ("Linux", "Darwin") and uid is not None and uid != 0:
        found.append(finding("privilege", "fail", f"running as user id {uid}, not root", "Run this program again with sudo."))
    elif os_name == "Windows" and windows_admin() is False:
        found.append(finding("privilege", "fail", "this program is not running as administrator",
                             "Close this window, open Git Bash with Run as administrator (the wizard asks by itself), and run this program again."))
    else:
        found.append(finding("privilege", "ok", "root" if uid == 0 else "administrator rights are checked by the OS"))
    if action == "install":
        previous = node_role(read_kv(os.environ.get("FLEET_NODE_CONF", "/etc/fleet/node.conf")))
        if previous == "ci" and job_busy(os.environ.get("FLEET_BUSY_DIR", "/run/fleet")):
            found.append(finding("runner-idle", "fail", "this CI node is running a job", "Wait for its jobs to finish, then check again. A role conversion never interrupts a running job."))
        if role == "devbox":
            try:
                validate_ssh_key(ssh_key if ssh_key is not None else devbox_key())
                found.append(finding("ssh-access", "ok", "public key for the dev account is valid"))
            except (Invariant, OSError) as exc:
                found.append(finding("ssh-access", "fail", str(exc), "Paste your SSH public key in the wizard, or set FLEET_DEVBOX_SSH_KEY_FILE to your .pub file. Never supply a private key."))
        arch = machine_arch()
        if arch in X86:
            found.append(finding("architecture", "ok", arch))
        else:
            found.append(finding("architecture", "fail", f"{arch}; the installer is x86_64 UEFI only",
                                 "Run this program on an x86_64 computer. Other architectures are not supported yet."))
        if os_name == "Linux":
            efi = Path(os.environ.get("FLEET_EFI_DIR") or "/sys/firmware/efi")
            if efi.is_dir():
                found.append(finding("firmware", "ok", "booted in UEFI mode"))
            else:
                found.append(finding("firmware", "fail", "booted in legacy BIOS mode",
                                     "Turn on UEFI boot (and turn off CSM or legacy boot) in the firmware settings, then run this program again."))
        if os_name != "Windows":
            tool = os_boot_tool(os_name)
            if shutil.which(tool) or os.path.isfile(tool):
                found.append(finding("boot-tool", "ok", tool))
            else:
                found.append(finding("boot-tool", "fail", f"{tool} is not installed",
                                     "This computer cannot reboot into the installer. Plug in one USB disk and run this program again with the word flash."))
            stage = iso_filesystem(directory)
            if stage in SAFE_ISO_FS:
                found.append(finding("staging", "ok", f"the installer is staged on {stage}"))
            else:
                found.append(finding("staging", "fail", f"the installer would be staged on {stage or 'an unknown filesystem'}",
                                     "This computer cannot reboot into the installer. Plug in one USB disk and run this program again with the word flash."))
    error, size = NET.get("probe", probe_installer)()
    if action == "install" and os_name == "Windows":
        found.extend(NET.get("windows", windows_findings)(size, disk_path, need_root, iso_path=iso_path))
    if error:
        found.append(finding("network", "fail", f"the installer cannot be downloaded ({error})",
                             "Check the network. If the release is missing, wait for the Fleet workflow to publish it on merge, then run this program again."))
    else:
        found.append(finding("network", "ok", "the installer release is reachable"))
        if size:
            free = shutil.disk_usage(directory).free if Path(directory).exists() else None
            staged = Path(directory) / "fleet-installer.iso"
            if free is not None and staged.is_file():
                free += staged.stat().st_size  # a copy from an earlier attempt is reused or replaced, never kept twice
            if free is not None and free < size * 1.25:
                found.append(finding("space", "fail", f"{free // GIB} GiB free in {directory}, the installer needs about {size * 5 // 4 // GIB + 1} GiB",
                                     f"Free disk space in {directory}, then run this program again."))
            else:
                found.append(finding("space", "ok", f"installer is {size // (1024 ** 2)} MiB"))
            ram = memory_finding(mem_total(os_name), size) if action == "install" else None
            if ram is not None:
                found.append(ram)
    if action == "install":
        if token:
            found.append(NET.get("lookup", lookup_token)(token, role))
        elif auto_enroll:
            found.append(finding("enrollment", "info", "the repository owner will be asked to approve this node on GitHub before anything is erased"))
        else:
            found.append(finding("enrollment", "warn", "no enrollment token; this node would generate a key no other node shares",
                                 f"Mint one with `just enroll {role or '<role>'}` and rerun with its line, unless this role has no encrypted secrets yet."))
    return found


def show_findings(found):
    say("Checks:")
    for item in found:
        say(f"  {MARK[item['status']]}  {item['name']:<13} {item['detail']}")
        if item["fix"] and item["status"] in ("warn", "fail"):
            say(f"        fix: {item['fix']}")


def next_for(item):
    fix = item["fix"].strip()
    return f"Next: {fix}" if "Nothing was written" in fix else f"Next: {fix} Nothing was written."


def plan_lines(os_name, role, chosen, directory):
    """What installing would do, step by step, with sizes. Read-only: it only describes."""
    erases = chosen["plain"] if chosen.get("ok") else "the internal disk"
    if os_name == "Windows":
        facts = WINDOWS["facts"]
        if not facts:
            return ["Windows: the exact sizes and steps appear once this runs as administrator (nothing was queried)."]
        size = WINDOWS["iso_size"]
        label = f"{size / 1024 ** 3:.2f} GiB" if size else "about 8 GiB"
        return [f"0. Download the installer ({label}) to {Path(directory) / 'fleet-installer.iso'}; it is deleted again once it has been written to the new partition.",
                *windows_plan_lines(facts, size, role)]
    if os_name == "Linux":
        return [f"1. Download the installer to {Path(directory) / 'fleet-installer.iso'}.",
                "2. Load the installer's kernel and initrd with kexec.",
                f"3. Restart into it. The installer ERASES {erases} and installs {role}."]
    return [f"The installer cannot restart this computer into itself; make an install USB with the word flash. A USB install ERASES {erases}."]


def cmd_doctor(argv):
    """Read-only. Says exactly what would be erased and whether anything stands in the way."""
    as_json = "--json" in argv
    argv = [a for a in argv if a != "--json"]
    argv, token, token_error = enroll_token(argv)
    if token_error:
        return fail(token_error, 2)
    os_name = current_os()
    if os_name not in ("Linux", "Darwin", "Windows"):
        return fail(f"Next: {os_name} cannot start this installer. Nothing was written.", 2)
    role = argv[0] if argv else None
    if role is not None:
        error = role_error(role)
        if error:
            return fail(error, 2)
    directory = state_dir()
    chosen = choose_disk(os_name, "install")
    found = preflight(os_name, role, "install", token, directory, auto_enroll=enroll_enabled() and role is not None,
                      disk_path=chosen["path"] if chosen["ok"] else None, iso_path=directory / "fleet-installer.iso")
    if chosen["ok"]:
        found.append(finding("disk", "ok", chosen["plain"]))
    else:
        found.append(finding("disk", "fail", "no internal disk can be erased safely", chosen["next"].replace("Next: ", "", 1)))
    if role and installed_for(role, directory):
        found.append(finding("state", "info", f"already installed as {role}; running the program again does not wipe it"))
    problems = [item for item in found if item["status"] == "fail"]
    steps = plan_lines(os_name, role or "<role>", chosen, directory) if chosen["ok"] and os_name == "Windows" else []
    if as_json:
        print(json.dumps({
            "ok": not problems,
            "role": role,
            "erases": chosen.get("plain") if chosen["ok"] else None,
            "plan": steps,
            "confirm": f"{role}: {chosen['plain']}" if role and chosen["ok"] else None,
            "checks": found,
            "log": LOG["path"],
        }, indent=2))
    else:
        show_findings(found)
        if chosen["ok"]:
            say(f"Would erase: {chosen['plain']}")
        if steps:
            say("What installing would do (nothing has been changed):")
            for line in steps:
                say("  " + line)
    if problems:
        say(f"Result: NOT ready, {len(problems)} problem{'s' if len(problems) != 1 else ''}.")
        return fail(next_for(problems[0]), 2)
    say("Result: ready. Nothing was written. Show the person the role and the disk, get their yes, then run again with --yes.")
    return 0


def cmd_status():
    """Read-only health of an installed node."""
    conf = os.environ.get("FLEET_NODE_CONF", "/etc/fleet/node.conf")
    role = node_role(read_kv(conf))
    if not role:
        return fail("Next: this machine is not an installed fleet node (no role in " + conf + "). Install it with fleet-node.sh ROLE.", 1)
    found = [finding("role", "ok", role)]
    try:
        host = os.environ.get("FLEET_HOSTNAME") or _run(["hostname"]).strip()
    except (OSError, RuntimeError):
        host = "unknown"
    found.append(finding("hostname", "ok", host))
    revision = Path(os.environ.get("FLEET_REVISION", "/etc/fleet/revision"))
    rev = revision.read_text().strip() if revision.is_file() else "unknown"
    if rev in ("", "unknown"):
        found.append(finding("revision", "fail", "unknown", "This build has no git revision. Wait for the next sync, then check again."))
    else:
        found.append(finding("revision", "ok", rev[:12]))
    if (state_dir() / "withdrawn").is_file():
        found.append(finding("membership", "fail", "withdrawn: this node was removed from the fleet", "Reinstall it with fleet-node.sh ROLE to rejoin."))
    health = Path(os.environ.get("FLEET_HEALTH_FAILURE", "/run/fleet/health-failure"))
    if health.is_file():
        found.append(finding("last-sync", "fail", "the last switch failed its health check and was rolled back: "
                             + " ".join(health.read_text(errors="replace").split())[:200],
                             "Fix the cause in git (a revert pull request). The node retries by itself."))
    systemctl = os.environ.get("FLEET_SYSTEMCTL", "systemctl")
    if shutil.which(systemctl) or os.path.isfile(systemctl):
        timer = run_logged([systemctl, "is-active", "fleet-sync.timer"], capture_output=True, text=True)
        state = (timer.stdout or "").strip() or "unknown"
        found.append(finding("sync-timer", "ok" if state == "active" else "fail", state,
                             "" if state == "active" else "The node is not polling main. Check `systemctl status fleet-sync.timer`."))
        failed = run_logged([systemctl, "--failed", "--no-legend", "--plain"], capture_output=True, text=True)
        units = [line.split()[0] for line in (failed.stdout or "").splitlines() if line.split()]
        if units:
            found.append(finding("units", "fail", "failed: " + ", ".join(units), "Read `journalctl -u " + units[0] + "` on the node."))
        else:
            found.append(finding("units", "ok", "no failed units"))
    else:
        found.append(finding("systemd", "warn", "systemctl is not available here", ""))
    install_log = state_dir() / "logs" / "install.log"
    if install_log.is_file():
        found.append(finding("install-log", "info", str(install_log)))
    show_findings(found)
    problems = [item for item in found if item["status"] == "fail"]
    if problems:
        say(f"Result: {len(problems)} problem{'s' if len(problems) != 1 else ''}.")
        return fail(f"Next: {problems[0]['fix'] or problems[0]['detail']}", 1)
    say("Result: healthy.")
    return 0


ENROLL_RE = re.compile(r"^[A-Za-z0-9._-]{8,512}$")

# ---- Self-service enrollment ---------------------------------------------------
# A new node has no credential for Vault, and the installer release is public, so
# a node cannot simply ask for its role key. The person who owns the repository
# approves the node instead: the node shows a prefilled GitHub issue, the owner
# submits it, and the `Fleet enroll` workflow (which logs in to Vault with its
# GitHub OIDC identity, never a stored secret) asks Vault for a single-use
# response-wrapped token and posts it as a comment sealed to the node's one-time
# public key. Only the node holds the matching private key, and the node alone
# can unwrap the token. Anyone else reading the comment sees ciphertext.

REPO = os.environ.get("FLEET_GITHUB_REPO", "crvouga/fleet")
ENROLL_WAIT = 15 * 60
ENROLL_POLL = 15
FIELD_ROLE = "fleet-enroll-role: "
FIELD_KEY = "fleet-enroll-key: "
P25519 = 2 ** 255 - 19
BASE_POINT = (9).to_bytes(32, "little")


def x25519(scalar, point):
    """RFC 7748 X25519, in plain Python so the one downloaded file needs no
    package. Checked against the RFC's test vectors in tests/test_enroll.py."""
    invariant(len(scalar) == 32 and len(point) == 32, "x25519 needs 32-byte inputs", scalar=len(scalar), point=len(point))
    k = bytearray(scalar)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    k = int.from_bytes(k, "little")
    x1 = int.from_bytes(point, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in reversed(range(255)):
        bit = (k >> t) & 1
        swap ^= bit
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a, b = (x2 + z2) % P25519, (x2 - z2) % P25519
        aa, bb = a * a % P25519, b * b % P25519
        e = (aa - bb) % P25519
        c, d = (x3 + z3) % P25519, (x3 - z3) % P25519
        da, cb = d * a % P25519, c * b % P25519
        x3 = (da + cb) ** 2 % P25519
        z3 = x1 * (da - cb) ** 2 % P25519
        x2 = aa * bb % P25519
        z2 = e * (aa + 121665 * e) % P25519
    if swap:
        x2, x3, z2, z3 = x3, x2, z3, z2
    return (x2 * pow(z2, P25519 - 2, P25519) % P25519).to_bytes(32, "little")


def _hkdf(secret, salt, info, length):
    prk = hmac.new(salt, secret, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def _stream(key, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(out[:length])


def _b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_keypair():
    private = os.urandom(32)
    return private, x25519(private, BASE_POINT)


def seal(plaintext, recipient_public):
    """Encrypt to one public key: ephemeral X25519, HKDF-SHA256, an HMAC-SHA256
    keystream, and an HMAC-SHA256 tag over the ciphertext (encrypt-then-MAC)."""
    ephemeral = os.urandom(32)
    ephemeral_public = x25519(ephemeral, BASE_POINT)
    shared = x25519(ephemeral, recipient_public)
    invariant(shared != bytes(32), "the recipient public key is a low-order point")
    keys = _hkdf(shared, ephemeral_public + recipient_public, b"fleet-seal-v1", 64)
    cipher = bytes(a ^ b for a, b in zip(plaintext, _stream(keys[:32], len(plaintext))))
    tag = hmac.new(keys[32:], ephemeral_public + cipher, hashlib.sha256).digest()
    return _b64(ephemeral_public + cipher + tag)


def open_sealed(blob, private):
    """Returns the plaintext, or None when the blob is not for this key or was altered."""
    try:
        raw = _unb64(blob.strip())
    except ValueError:
        return None
    if len(raw) < 64:
        return None
    ephemeral_public, cipher, tag = raw[:32], raw[32:-32], raw[-32:]
    shared = x25519(private, ephemeral_public)
    if shared == bytes(32):
        return None
    public = x25519(private, BASE_POINT)
    keys = _hkdf(shared, ephemeral_public + public, b"fleet-seal-v1", 64)
    want = hmac.new(keys[32:], ephemeral_public + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, want):
        return None
    return bytes(a ^ b for a, b in zip(cipher, _stream(keys[:32], len(cipher))))


# Every installer surface (the wizard, this program, the live installer screen)
# reports problems on one GitHub issue form. Its field ids are fixed by
# .github/ISSUE_TEMPLATE/fleet-installer.yml; tests/test_issue_form.py keeps them in step.
ISSUE_FORM = "fleet-installer.yml"
ISSUE_FIELDS = ("step", "what-happened", "diagnostic")
ISSUE_URL_MAX = 7500  # GitHub refuses much longer new-issue addresses


def issue_form_url(title, step="", diagnostic="", happened=""):
    """A new issue on the Fleet installer form, its fields filled in and redacted.
    The person reviews it in the browser before anything is submitted."""
    fields = {"template": ISSUE_FORM, "title": redact(title).strip()[:120] or "Fleet installer problem",
              "step": redact(step).strip()[:200], "what-happened": redact(happened).strip(),
              "diagnostic": redact(diagnostic).strip()}
    # A space is "+", not "%20": a QR code holds about a fifth more of the report.
    query = urllib.parse.urlencode({key: value for key, value in fields.items() if value}, quote_via=urllib.parse.quote_plus)
    return f"https://github.com/{REPO}/issues/new?{query}"


def issue_form_url_within(title, step, diagnostic, limit=ISSUE_URL_MAX, note="(shortened to fit a link; attach the full report)"):
    """issue_form_url with the diagnostic cut until the address fits `limit`.
    Encoded length is what counts: one non-ASCII character can cost nine."""
    text = redact(diagnostic)
    if len(issue_form_url(title, step, text)) <= limit:
        return issue_form_url(title, step, text)
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if len(issue_form_url(title, step, text[:middle] + "\n" + note)) <= limit:
            low = middle
        else:
            high = middle - 1
    return issue_form_url(title, step, text[:low] + "\n" + note)


def report_link(message, command):
    """One line every failure of this program ends with: a pre-filled issue."""
    first = next((line for line in redact(message).splitlines() if line.strip()), "fleet-node failure").strip()
    first = re.sub(r"^(Next|Why):\s*", "", first)
    facts = [f"Source: fleet-node.sh {command}", f"Result: {first}", f"System: {current_os()} {machine_arch()}",
             f"Log: {LOG['path'] or 'none'} (attach it to the issue; it is redacted)"]
    title = "Fleet installer: " + (first if len(first) <= 90 else first[:87] + "...")
    return "Report: " + issue_form_url_within(title, f"fleet-node.sh {command}", "\n".join(facts), limit=2000)


def enroll_issue_url(role, public):
    body = (
        f"Approve a new fleet {role} node. Submit this issue as it is.\n\n"
        f"{FIELD_ROLE}{role}\n{FIELD_KEY}{_b64(public)}\n"
    )
    query = urllib.parse.urlencode({"title": f"fleet-enroll {role}", "body": body}, quote_via=urllib.parse.quote)
    return f"https://github.com/{REPO}/issues/new?{query}"


def parse_enroll_request(title, body):
    """(role, public key bytes) from an enrollment issue, or raises Invariant."""
    fields = {}
    for line in str(body or "").splitlines():
        for name in (FIELD_ROLE, FIELD_KEY):
            if line.startswith(name):
                fields[name] = line[len(name):].strip()
    role = fields.get(FIELD_ROLE, "")
    invariant(role in ROLES, "the enrollment request names an unknown role", "Run the installer again.", role=role)
    invariant(str(title or "").strip() == f"fleet-enroll {role}", "the issue title does not match its role", title=title, role=role)
    try:
        public = _unb64(fields.get(FIELD_KEY, ""))
    except ValueError:
        public = b""
    invariant(len(public) == 32, "the enrollment request holds no valid public key", "Run the installer again.")
    return role, public


def _github(path, etag=None):
    base = os.environ.get("FLEET_GITHUB_API", "https://api.github.com").rstrip("/")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "fleet-node", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("FLEET_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    if etag:
        headers["If-None-Match"] = etag
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=20) as reply:
            return reply.status, json.loads(reply.read().decode("utf-8", "replace")), reply.headers.get("ETag")
    except urllib.error.HTTPError as exc:
        return exc.code, None, etag
    except (urllib.error.URLError, OSError, ValueError):
        return 0, None, etag


def await_approval(role, private, public, wait=ENROLL_WAIT, interval=ENROLL_POLL, sleep=time.sleep, notify=None, cancel=None):
    """Poll the public issue until the workflow answers. Returns (token, error)."""
    marker = FIELD_KEY + _b64(public)
    issue, etags = None, {}
    deadline = time.monotonic() + wait
    while True:
        if issue is None:
            path = f"/repos/{REPO}/issues?state=all&sort=created&direction=desc&per_page=30"
            code, data, etags["issues"] = _github(path, etags.get("issues"))
            if code == 200:
                for item in data:
                    if "pull_request" not in item and marker in str(item.get("body") or ""):
                        issue = item["number"]
                        if notify:
                            notify("The request was received. Waiting for the approval workflow.")
                        break
        if issue is not None:
            code, data, etags["comments"] = _github(f"/repos/{REPO}/issues/{issue}/comments?per_page=50", etags.get("comments"))
            for comment in (data or []) if code == 200 else []:
                if (comment.get("user") or {}).get("login") != "github-actions[bot]":
                    continue
                for line in str(comment.get("body") or "").splitlines():
                    if line.startswith("fleet-error: "):
                        return None, line[len("fleet-error: "):].strip()
                    if line.startswith("fleet-sealed: "):
                        plain = open_sealed(line[len("fleet-sealed: "):], private)
                        if plain is None:
                            continue
                        try:
                            answer = json.loads(plain.decode("utf-8"))
                        except ValueError:
                            continue
                        if answer.get("role") == role and ENROLL_RE.fullmatch(str(answer.get("token") or "")):
                            return answer["token"], None
        if cancel and cancel():
            return None, "cancelled"
        if time.monotonic() >= deadline:
            return None, "nobody approved this node in time"
        sleep(interval)


def self_enroll(role, notify=None, wait=None, cancel=None):
    """Ask the owner to approve this node. Returns (token, error). Nothing is
    erased here; a refusal or a timeout leaves every disk as it was."""
    say_it = notify or say
    private, public = new_keypair()
    url = enroll_issue_url(role, public)
    say_it("Approve this node: press 'Submit new issue' on the GitHub page that opens, signed in as the repository owner.")
    say_it("If no page opened, open this address on any computer: " + url)
    if not os.environ.get("FLEET_NO_BROWSER"):
        try:
            webbrowser.open(url)
        except webbrowser.Error:
            pass
    seconds = wait if wait is not None else int(os.environ.get("FLEET_ENROLL_WAIT") or ENROLL_WAIT)
    interval = int(os.environ.get("FLEET_ENROLL_POLL") or ENROLL_POLL)
    token, error = await_approval(role, private, public, seconds, interval, notify=notify, cancel=cancel)
    if token:
        say_it("Approved. The enrollment token arrived sealed and was opened on this machine.")
    return token, error


def enroll_enabled():
    return not flag(os.environ.get("FLEET_NO_ENROLL"))




def validate_ssh_key(value):
    """No authorized_keys options or line injection. Validate the wire type.
    The live installer additionally asks ssh-keygen to validate the key."""
    value = str(value or "").strip()
    invariant(value and len(value) <= 2048 and "\n" not in value and "\r" not in value,
              "a devbox needs one SSH public key", "Paste the contents of your .pub file; never your private key.")
    parts = value.split()
    invariant(len(parts) >= 2 and parts[0] in ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"),
              "unsupported SSH public key type", "Use a standard Ed25519, RSA or ECDSA .pub file.")
    try:
        wire = base64.b64decode(parts[1], validate=True)
    except ValueError:
        invariant(False, "the SSH public key has invalid base64", "Copy the complete contents of your .pub file.")
    length = int.from_bytes(wire[:4], "big")
    invariant(len(wire) >= 8 and wire[4:4 + length] == parts[0].encode() and len(wire) > 4 + length,
              "the SSH public key is incomplete or has a mismatched type", "Copy the complete contents of your .pub file.")
    if parts[0] == "ssh-ed25519":
        tail = wire[4 + length:]
        invariant(len(tail) == 36 and tail[:4] == (32).to_bytes(4, "big"), "the Ed25519 public key must contain exactly 32 bytes")
    return " ".join(parts[:2])


def devbox_key():
    inline = os.environ.get("FLEET_DEVBOX_SSH_KEY")
    if inline:
        return validate_ssh_key(inline)
    path = Path(os.environ.get("FLEET_DEVBOX_SSH_KEY_FILE") or "/nix/fleet-state/devbox/authorized_keys")
    return validate_ssh_key(path.read_text(encoding="utf-8") if path.is_file() else "")


def enroll_token(argv):
    """Return (rest, token, error). The token is a single-use Vault wrapping
    token for this role's age key. It is read from a file or the environment,
    never from an argument, so it is not left in shell history or ps."""
    rest = []
    path = os.environ.get("FLEET_ENROLL_TOKEN_FILE", "")
    items = iter(argv)
    for item in items:
        if item == "--token" or item.startswith("--token="):
            return argv, None, "Next: pass the token with --token-file PATH or FLEET_ENROLL_TOKEN, not as an argument. Nothing was written."
        if item == "--token-file":
            path = next(items, "")
            if not path:
                return argv, None, "Next: --token-file needs a path. Nothing was written."
        elif item.startswith("--token-file="):
            path = item.split("=", 1)[1]
        else:
            rest.append(item)
    token = os.environ.get("FLEET_ENROLL_TOKEN", "")
    if path:
        try:
            token = Path(path).read_text(encoding="utf-8")
        except OSError:
            return argv, None, "Next: the token file could not be read. Nothing was written."
    token = token.strip()
    if token and not ENROLL_RE.fullmatch(token):
        return argv, None, "Next: the enrollment token is not a Vault token. Nothing was written."
    return rest, token or None, None


def cmd_install(argv, action):
    assume_yes = flag(os.environ.get("FLEET_YES")) or any(a in ("--yes", "-y") for a in argv)
    plan_only = "--plan" in argv
    reinstall = "--reinstall" in argv
    argv = [a for a in argv if a not in ("--yes", "-y", "--plan", "--reinstall")]
    if reinstall and action != "install":
        return fail("Next: --reinstall takes a node role, not flash. Nothing was written.", 2)
    argv, token, token_error = enroll_token(argv)
    if token_error:
        return fail(token_error, 2)
    if token and action != "install":
        return fail("Next: flash takes no token. Nothing was written.", 2)
    os_name = current_os()
    if os_name not in ("Linux", "Darwin", "Windows"):
        return fail(f"Next: {os_name} cannot start this installer. Nothing was written.", 2)
    role = None
    if action == "install":
        role = load_role(argv[0] if argv else "")
        if role is None:
            return 1
        error = role_error(role)
        if error:
            return fail(error, 2)
        if argv and len(argv) > 1:
            return fail("Next: pass only the role. Nothing was written.", 2)
    elif argv:
        return fail("Next: flash takes no role. Nothing was written.", 2)
    directory = state_dir()
    chosen = choose_disk(os_name, action)
    if not chosen["ok"]:
        return fail(chosen["next"], chosen.get("code", 2))
    # Every check that does not need a person runs before anyone is asked to
    # confirm, so a doomed install never gets as far as the prompt.
    found = preflight(os_name, role, action, token, directory, auto_enroll=action == "install" and enroll_enabled(), disk_path=chosen["path"],
                      iso_path=directory / "fleet-installer.iso")
    show_findings(found)
    problems = [item for item in found if item["status"] == "fail"]
    if problems:
        say(f"Result: NOT ready, {len(problems)} problem{'s' if len(problems) != 1 else ''}.")
        return fail(next_for(problems[0]), 2)
    if plan_only:
        # Nothing below runs: no approval is requested, nothing is downloaded, nothing is changed.
        say("What this would do on this computer:")
        for line in (plan_lines(os_name, role, chosen, directory) if action == "install" else [f"Write the installer to the USB disk {chosen['plain']} (erases it)."]):
            say("  " + line)
        say("Result: ready. This was only the plan: nothing was written or changed. Run the same command without --plan to do it.")
        return 0
    if action == "install":
        say(f"Role: {role}")
        say(f"Disk: {chosen['plain']}")
        if reinstall:
            say("Hard reinstall requested: the existing installation and every file on the internal disk will be erased.")
        say("This erases that internal disk. Nothing is erased until you confirm the role and the disk.")
        say("Type this line exactly:")
        say(f"{role}: {chosen['plain']}")
        label = role
    else:
        say("Disk: " + chosen["plain"])
        say("This writes the installer onto that USB disk and erases what is on it. The internal disk is not erased.")
        say("Type this line exactly:")
        say("flash: " + chosen["plain"])
        label = "flash"
    if assume_yes:
        say("--yes was given, so the line above is taken as typed. Disk rules still apply.")
    else:
        answer, timed_out = read_answer(os.environ.get("FLEET_CONFIRM_TIMEOUT", "120"))
        error = confirm(label, chosen["plain"], answer, timed_out)
        if error:
            return fail(error, 1)
    again = choose_disk(os_name, action)
    if not again["ok"] or again["disk_id"] != chosen["disk_id"]:
        return fail("Next: the disk changed before it was used. Nothing was written. Run this program again.")
    block = install_block if action == "install" else media_block
    invariant(block(again["disk"]) is None, "the disk about to be erased fails the rules that chose it", disk=again["disk"])
    invariant(device_ok(again["path"]), "the disk about to be erased has an unusable device path", path=again["path"])
    if action == "install" and not reinstall and installed_for(role, directory):
        say(f"This machine is already installed as {role}. The disk was not wiped.")
        return 0
    iso = directory / "fleet-installer.iso"
    fetched = fetch_installer(iso)
    if fetched != 0:
        return fetched
    # Wi-Fi downloads can outlive a wrapping-token lease. Request approval only
    # after the complete image has been verified, and recheck the disk afterward.
    if action == "install" and not token and enroll_enabled() and (reinstall or not installed_for(role, directory)):
        token, error = self_enroll(role)
        if error:
            return fail(f"Next: this node was not approved ({error}). Nothing was written. Run this program again, or add --no-enroll to install without the role's shared key.", 2)
        verdict = NET.get("lookup", lookup_token)(token, role)
        if verdict["status"] == "fail":
            return fail(f"Next: the approval token cannot be used ({verdict['detail']}). Nothing was written. Run this program again to be approved again.", 2)
    fresh = choose_disk(os_name, action)
    invariant(fresh.get("ok") and fresh.get("disk_id") == chosen["disk_id"],
              "the disk changed while the installer was downloading or waiting for approval",
              "Review the exact disk again. Nothing was erased.")
    if action == "install":
        return perform_install(os_name, role, str(iso), token, os.environ.get("FLEET_VAULT_ADDR") or None, directory, chosen)
    network = wifi_profile(os_name)
    capacity = int(chosen["disk"].get("size") or 0)
    if not wifi_module().simulated():
        invariant(capacity >= padded_size(os.path.getsize(iso)) + wifi_module().TRAILER_SIZE,
                  "the USB has no space for the Wi-Fi handoff", "Use a larger USB disk. Nothing was written.")
    written = write_media(os_name, str(iso), chosen["path"], wifi=network, capacity=capacity)
    if written != 0:
        return written
    say("FLEET-WIPE media")
    say(f"The USB disk now holds the installer. Boot that disk. On the installer menu choose {ROLE_CHOICES}. Choose a role and press Enter; every entry erases the internal disk.")
    return 0


class ReleaseChanging(RuntimeError):
    """Only the release metadata is inconsistent during publication, not image bytes."""


def check_release_readiness(role, expected_sha, iso_url):
    if wifi_module().simulated():
        return
    url = iso_url.rsplit('/', 1)[0] + '/fleet-installer.readiness.json'
    with urllib.request.urlopen(url, timeout=10) as response:
        raw = response.read(65537)
    invariant(len(raw) <= 65536, 'the release readiness manifest is too large')
    try:
        document = json.loads(raw)
        invariant(document['version'] == 1, 'the release readiness version is unsupported', NEWER_RELEASE_FIX, version=document['version'])
        blocked = document['roles'][role]['blocked']
        invariant(isinstance(blocked, list) and all(isinstance(value, str) for value in blocked), 'the release readiness checks are malformed')
        if document['imageSha256'] != expected_sha:
            raise ReleaseChanging('The installer release is being updated; waiting for matching metadata before downloading.')
    except (KeyError, ValueError, TypeError) as exc:
        invariant(False, 'FLEET_RELEASE_READINESS_INVALID: the release readiness manifest is incomplete or newer than this installer',
                  'Download the latest Fleet installer and try again. If it repeats, the release is incomplete: re-run the Fleet workflow. Nothing was erased.',
                  role=role, problem=f"{type(exc).__name__}: {exc}")
    invariant(not blocked, 'FLEET_PLATFORM_NOT_READY: ' + '; '.join(blocked),
              'The platform administrator must resolve the configuration errors and publish the installer. No image was downloaded and nothing was erased.')


def check_installer_readiness(iso, role):
    if wifi_module().simulated():
        return
    try:
        with Path(iso).open("rb") as handle:
            raw = _iso_bytes(handle, _iso_index(handle), "fleet-readiness.json")
        invariant(len(raw) <= 65536, "the installer readiness manifest is too large")
        manifest = json.loads(raw)
        invariant(manifest.get("version") == 1, "the installer readiness manifest has an unsupported version", NEWER_RELEASE_FIX, version=manifest.get("version"))
        blocked = manifest["roles"][role]["blocked"]
        invariant(isinstance(blocked, list) and all(isinstance(item, str) for item in blocked), "the installer readiness checks are malformed")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        invariant(False, "FLEET_INSTALLER_READINESS_MISSING: this image cannot prove it can join and update",
                  "Download the current Fleet installer. Nothing was erased.")
    invariant(not blocked, "FLEET_PLATFORM_NOT_READY: " + "; ".join(blocked),
              "The platform administrator must resolve these Fleet configuration errors and publish a new installer. Reopen the wizard afterward. Nothing was erased.")


def perform_install(os_name, role, iso, token, vault, directory, chosen, on_progress=None, wifi=None):
    """The point of no return, shared by the command line and the wizard. On a
    real machine kexec does not come back; the marker is for the test seam."""
    invariant(role in ROLES, "perform_install was given an unknown role", role=role)
    invariant(chosen.get("ok") and chosen.get("disk_id"), "perform_install needs a chosen disk", chosen=chosen)
    invariant(os.path.isfile(iso) and os.path.getsize(iso) > 0, "perform_install needs the verified installer image", iso=str(iso))
    # Read credentials before withdrawing a runner or changing partitions.
    network = wifi_profile(os_name, wifi)
    check_installer_readiness(iso, role)
    handoff = {"wifi": network} if network is not None else {}
    previously_withdrawn = bool(checked_marker(directory, "withdrawn"))
    # An earlier attempt that was killed before its cleanup left `handoff` with the duty to
    # restore the CI runner. That withdrawal belongs to this reinstall too: keep the duty.
    inherited = previously_withdrawn and read_kv(Path(directory) / "handoff").get("restore_ci") == "1"
    started = False
    try:
        retire_runner_for_install(directory)
        restore_ci = inherited or (not previously_withdrawn and bool(checked_marker(directory, "withdrawn")))
        write_text(Path(directory) / "handoff", f"role={role}\ndisk={chosen['disk_id']}\nstatus=staged\nrestore_ci={int(restore_ci)}\n")
        if os_name == "Windows":
            staged = stage_windows(role, str(iso), token, vault, chosen, on_progress, **handoff)
        else:
            staged = stage_reboot(os_name, role, str(iso), token, vault, **handoff)
        if staged != 0:
            return staged
        started = True
    finally:
        if not started:
            (Path(directory) / "handoff").unlink(missing_ok=True)
        if not started and (inherited or not previously_withdrawn) and checked_marker(directory, "withdrawn"):
            # Staging failed before the live installer could erase anything.
            # Undo only this reinstall's withdrawal; intentional removals stay.
            (Path(directory) / "withdrawn").unlink()
            root = Path(os.environ.get("FLEET_BUSY_DIR", "/run/fleet"))
            write_text(root / "agent-drained", "recover failed reinstall\n")
            resume = os.environ.get("FLEET_RESUME") or (None if wifi_module().simulated() else shutil.which("fleet-resume"))
            if resume and run_logged([resume]).returncode == 0:
                (root / "agent-drained").unlink(missing_ok=True)
                log("failed handoff: previous CI node resumed")
            else:
                log("FLEET_RECOVERY_PENDING: the fleet agent will retry runner recovery after the failed handoff", "ERROR")
    say(f"FLEET-WIPE role={role}")
    say(f"Installer staged for {role}; joining Fleet is confirmed only after the new node boots and reports.")
    return 0


def runner_name_prefix():
    override = os.environ.get("FLEET_HOSTNAME")
    node = read_kv(Path(os.environ.get("FLEET_BUSY_DIR", "/run/fleet")) / "node")
    value = override or node.get("runner_prefix") or _run(["hostname"]).strip()
    invariant(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}", value) is not None,
              "the CI node has no safe runner identity", "Wait for node identity to initialize before retrying.")
    return value


def retire_runner_for_install(directory):
    """An idle CI node withdraws before changing roles; serialize with its
    job-start hook so no project code begins between the check and reboot."""
    previous = node_role(read_kv(os.environ.get("FLEET_NODE_CONF", "/etc/fleet/node.conf")))
    if previous != "ci":
        return
    import fcntl
    root = Path(os.environ.get("FLEET_BUSY_DIR", "/run/fleet"))
    root.mkdir(parents=True, exist_ok=True)
    with open(root / "gate", "a") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        invariant(not job_busy(root), "a runner job started before the reinstall", "Wait for the job to finish, then review again. Nothing was erased.")
        if not checked_marker(directory, "withdrawn"):
            key = os.environ.get("FLEET_CREDENTIAL", "/run/secrets/github-app-key")
            runner = read_kv(os.environ.get("FLEET_RUNNER_CONF", "/etc/fleet/runner.conf"))
            invariant(credential_ready(key, runner), "cannot withdraw this CI node with its current credential",
                      "Restore the CI role's GitHub App credential before reinstalling. Nothing was erased.")
            host = runner_name_prefix()
            invariant(bool(host), "the CI node has no hostname to withdraw")
            code = call_runner("withdraw", runner, key, host)
            invariant(code == 0, "the CI node could not be withdrawn before reinstalling", "Check GitHub connectivity and the CI credential, then try again. Nothing was erased.", code=code)
            write_text(Path(directory) / "withdrawn", "status=withdrawn\nrole=ci\n")
        write_text(root / "draining", "reinstall\n")


def job_busy(directory):
    root = Path(directory)
    if not root.exists():
        return False
    for candidate in root.rglob("busy"):
        if candidate.is_file():
            return True
    return False


def credential_ready(key_path, conf):
    if not key_path or not os.path.isfile(key_path) or os.path.getsize(key_path) == 0:
        return False
    if not conf:
        return False
    for field in ("scope", "app_id", "installation_id"):
        value = str(conf.get(field) or "")
        if not value or "TODO" in value:
            return False
    targets = conf.get("targets") or []
    if not targets or any("TODO" in target for target in targets):
        return False
    if conf.get("scope") not in ("organization", "repository"):
        return False
    return True


def node_role(conf):
    role = (conf or {}).get("role", "")
    if role in ROLES:
        return role
    return ""


def call_runner(mode, conf, key_path, host):
    tool = os.environ.get("FLEET_RUNNER_CONTROL", "runner-control")
    for target in conf.get("targets") or []:
        completed = subprocess.run(
            [tool, mode, conf["scope"], target, conf["app_id"], conf["installation_id"], key_path, host],
            check=False,
        )
        if completed.returncode != 0:
            return completed.returncode
    return 0


def cmd_remove():
    directory = state_dir()
    busy_root = os.environ.get("FLEET_BUSY_DIR", "/run/fleet")
    key_path = os.environ.get("FLEET_CREDENTIAL", "/run/secrets/github-app-key")
    node = read_kv(os.environ.get("FLEET_NODE_CONF", "/etc/fleet/node.conf"))
    runner = read_kv(os.environ.get("FLEET_RUNNER_CONF", "/etc/fleet/runner.conf"))
    role = node_role(node)
    busy = job_busy(busy_root)
    withdrawn = bool(checked_marker(directory, "withdrawn"))
    ready = credential_ready(key_path, runner)
    plan = removal_plan(busy, ready, withdrawn, role)
    invariant(plan["action"] in ("hold", "withdraw", "retire", "noop", "refuse"), "removal_plan returned an unknown action", action=plan["action"])
    invariant(not plan["stop_job"], "a removal plan must never stop a running job", plan=plan)
    invariant(not (busy and plan["power_off"]), "a removal plan powers off a busy machine", plan=plan)
    if plan["stop_job"]:
        return fail("Next: refusing to stop a running job. Leave this machine on.", 1)
    if plan["action"] in ("hold", "withdraw"):
        host = runner_name_prefix()
        code = call_runner(plan["action"], runner, key_path, host)
        if code != 0:
            return fail("Next: the runner could not be withdrawn with the credential already on this machine. Nothing was stopped. Run this program again.", code)
    if plan["action"] == "refuse":
        return fail(plan["next"], plan["code"])
    if plan["next"]:
        say(plan["next"])
    if plan["power_off"]:
        if not withdrawn:
            write_text(directory / "withdrawn", "status=withdrawn\n" + (f"role={role}\n" if role in ROLES else ""))
        say("The machine can be powered off.")
        retire_from_fleet_api()
        return power_off(role)
    return plan["code"]


def retire_from_fleet_api():
    """Tell the fleet controller this node is leaving. Best effort: ten seconds at most, and no failure here
    ever blocks or fails the removal. FLEET_AGENT names the command (tests); a test state directory
    without it skips the call."""
    command = os.environ.get("FLEET_AGENT")
    if command is None and not os.environ.get("FLEET_STATE"):
        command = shutil.which("fleet-agent")
    if not command:
        return
    try:
        subprocess.run([*command.split(), "retire"], check=False, timeout=10, capture_output=True)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass


def power_off(role):
    """Power a removed fleet node off by itself. Other machines are left on."""
    command = os.environ.get("FLEET_POWEROFF")
    if command is None and not os.environ.get("FLEET_STATE") and role:
        command = "systemctl poweroff"
    if not command:
        return 0
    say("Powering off now.")
    completed = subprocess.run(command.split(), check=False)
    if completed.returncode != 0:
        say("Next: the machine could not be powered off. It is withdrawn and stays out of the fleet. Power it off by hand.")
    return 0


USAGE = f"""usage: fleet-node.sh COMMAND

  ROLE              install this machine as {ROLE_CHOICES}
  doctor [ROLE]     read-only: what would be erased, and what stands in the way
  status            health of an installed node
  remove            take this node out of the fleet and power it off
  flash             write the installer to a USB disk
  guide             print the runbook an agent follows

Flags: --yes (take the confirmation as typed), --token-file PATH, --no-enroll (skip the GitHub approval
and let the node make its own key), --json (doctor), --plan (print the exact steps and sizes, change nothing).
--reinstall deliberately erases an existing installation of the same role; disk checks and confirmation still apply.
Every run writes a log; its path is printed when something fails.
Agent runbook: """ + GUIDE_URL


def dispatch(argv):
    command = argv[0] if argv else "install"
    rest = argv[1:] if argv else []
    if command in ("help", "-h", "--help"):
        print(USAGE)
        return 0
    if command in ROLES:
        return cmd_install([command, *rest], "install")
    if command == "install":
        return cmd_install(rest, "install")
    if command == "flash":
        return cmd_install(rest, "media")
    if command == "fetch":
        return cmd_fetch(rest)
    if command == "doctor":
        return cmd_doctor(rest)
    if command == "status":
        return cmd_status()
    if command == "remove":
        return cmd_remove()
    error = role_error(command)
    if error and command != "":
        return fail(error, 2)
    return fail("Next: use install, doctor, status, flash, fetch, or remove (help lists them). Nothing was written.", 2)


def main(argv=None):
    # Windows error text arrives in the language of the installation. A console or pipe in another
    # code page must never turn a message into a crash.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(errors="replace")
            except (OSError, ValueError):
                pass
    argv = list(sys.argv[1:] if argv is None else argv)
    if any(a in ("--yes", "-y") for a in argv):
        os.environ["FLEET_YES"] = "1"
        argv = [a for a in argv if a not in ("--yes", "-y")]
    if "--no-enroll" in argv:
        os.environ["FLEET_NO_ENROLL"] = "1"
        argv = [a for a in argv if a != "--no-enroll"]
    if argv and argv[0] not in ("help", "-h", "--help"):
        start_log(argv)
    try:
        code = dispatch(argv)
    except KeyboardInterrupt:
        return fail("Next: interrupted. Nothing was written unless FLEET-WIPE was printed above. Run this program again.", 130)
    except Invariant as broken:
        log(traceback.format_exc(), "ERROR")
        for key, value in broken.context.items():
            say(f"  {key}={value}")
        return fail(f"FLEET-INVARIANT {broken.what}\nNext: the program stopped on its own safety check and took no further step. {broken.fix}", 71)
    except Exception as exc:
        log(traceback.format_exc(), "ERROR")
        return fail(f"FLEET-ERROR unexpected {type(exc).__name__}: {exc}\nNext: this is a bug in the program, not in your setup. Run it again; if it repeats, give the log to the maintainer.", 70)
    invariant(isinstance(code, int) and code in (0, 1, 2, 70, 71, 130), "a command returned an exit code outside the documented set", code=code)
    log(f"finished with exit code {code}")
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(1)
