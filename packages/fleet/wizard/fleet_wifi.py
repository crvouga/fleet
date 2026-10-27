"""Private Wi-Fi handoff shared by the launcher and the installed system.

No credentials in argv, the kernel command line, logs, or the Nix store.
USB handoffs occupy a reserved trailer outside the verified ISO filesystem.
"""
import gzip
import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

TRAILER_SIZE = 65536
MAGIC = b"FLEET-WIFI-v1".ljust(16, b"\0")
LIVE = Path("/run/fleet-wifi/wifi.json")
PERSISTENT = Path("/nix/fleet-state/network/wifi.json")
PROFILE = Path("/run/NetworkManager/system-connections/fleet-wifi.nmconnection")


class WifiError(Exception):
    """Messages are deliberately credential-free, including malformed input."""


class NetworkUnavailable(WifiError):
    """Retryable only before disk operations or one-time token consumption."""


def require(condition, message):
    if not condition:
        raise WifiError(message)


def utf8_length(value):
    try:
        return len(value.encode("utf-8")) if isinstance(value, str) else -1
    except UnicodeError:
        return -1


def validate(value):
    require(isinstance(value, dict), "Wi-Fi settings must be an object.")
    ssid, password = value.get("ssid"), value.get("password", "")
    auth = value.get("auth", "wpa-psk" if password else "open")
    hidden = value.get("hidden", False)
    require(isinstance(ssid, str) and 1 <= utf8_length(ssid) <= 32 and
            all(ord(c) >= 32 and ord(c) != 127 for c in ssid), "Wi-Fi needs a valid network name of at most 32 bytes.")
    require(isinstance(password, str) and all(ord(c) >= 32 and ord(c) != 127 for c in password),
            "The Wi-Fi password contains unsupported characters.")
    require(auth in ("open", "wpa-psk", "sae") and isinstance(hidden, bool),
            "Automatic Wi-Fi supports open, WPA/WPA2 Personal and WPA3 Personal networks.")
    if auth == "open":
        require(not password, "An open Wi-Fi network must not have a password.")
    elif auth == "wpa-psk":
        require(8 <= utf8_length(password) <= 63 or
                len(password) == 64 and all(c in "0123456789abcdefABCDEF" for c in password),
                "WPA/WPA2 Personal needs an 8–63 byte password or a 64-digit hexadecimal key.")
    else:
        require(1 <= utf8_length(password) <= 63, "WPA3 Personal needs a reusable password.")
    return {"ssid": ssid, "password": password, "auth": auth, "hidden": hidden}


def encode(profile):
    return json.dumps(validate(profile), ensure_ascii=True, sort_keys=True).encode("ascii")


def decode(data):
    require(len(data) <= 4096, "The Wi-Fi handoff is too large.")
    try:
        return validate(json.loads(data))
    except (ValueError, UnicodeError):
        raise WifiError("The Wi-Fi handoff is damaged.") from None


def simulated():
    return any(os.environ.get(k) for k in (
        "FLEET_DISKS_FILE", "FLEET_WINDOWS_TARGET", "FLEET_WRITE_TARGET", "FLEET_ALLOW_UNPRIVILEGED", "FLEET_ALLOW_ANY_OS_INSTALL",
        "FLEET_DD", "FLEET_LSBLK", "FLEET_DISKUTIL", "FLEET_POWERSHELL", "FLEET_OS", "FLEET_EUID", "FLEET_ARCH",
    ))


def discover(os_name, supplied=None):
    if supplied is not None:
        return validate(supplied)
    # Simulated installers must never read the host's saved credentials.
    if simulated():
        return None
    source = os.environ.get("FLEET_WIFI_FILE")
    if source:
        return read_private(Path(source))
    from wifi_capture import capture
    profile = capture(os_name)
    return validate(profile) if profile is not None else None


def connection_id(profile):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "fleet-wifi:" + validate(profile)["ssid"]))


def keyfile(profile):
    p = validate(profile)
    # Numeric SSID bytes avoid keyfile ambiguity for names containing ; or =.
    ssid = ";".join(str(c) for c in p["ssid"].encode()) + ";"
    password = p["password"].replace("\\", "\\\\").replace(" ", "\\s")
    security = "" if p["auth"] == "open" else f"\n[wifi-security]\nkey-mgmt={p['auth']}\npsk={password}\npsk-flags=0\n"
    return (f"[connection]\nid=Fleet Wi-Fi\nuuid={connection_id(p)}\ntype=wifi\nautoconnect=true\nautoconnect-retries=0\n"
            f"\n[wifi]\nmode=infrastructure\nssid={ssid}\nhidden={'true' if p['hidden'] else 'false'}\npowersave=2\n"
            f"{security}\n[ipv4]\nmethod=auto\nroute-metric=600\n\n[ipv6]\nmethod=auto\nroute-metric=600\n")


def write_private(path, data):
    path = Path(path)
    require(not path.is_symlink() and not path.parent.is_symlink(), "The Wi-Fi handoff path is not a private regular file.")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, name = tempfile.mkstemp(prefix=".fleet-wifi-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_private(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_uid == getattr(os, "geteuid", lambda: 0)(),
                "Wi-Fi settings must be a private file owned by the current user.")
        return decode(handle.read(4097))


def initrd(profile):
    """A gzip newc archive: Linux accepts concatenated initramfs members."""
    def member(name, body, mode, ino):
        name = name.encode() + b"\0"
        fields = [ino, mode, 0, 0, 1, 0, len(body), 0, 0, 0, 0, len(name), 0]
        header = b"070701" + b"".join(f"{v:08x}".encode() for v in fields)
        entry = header + name
        entry += b"\0" * (-len(entry) % 4)
        return entry + body + b"\0" * (-len(body) % 4)
    archive = member("fleet-wifi.json", encode(profile), stat.S_IFREG | 0o600, 1)
    archive += member("TRAILER!!!", b"", 0, 2)
    return gzip.compress(archive, mtime=0)


def trailer(profile):
    if profile is None:
        return bytes(TRAILER_SIZE)
    data = encode(profile)
    result = MAGIC + struct.pack(">I", len(data)) + hashlib.sha256(data).digest() + data
    return result.ljust(TRAILER_SIZE, b"\0")


def read_trailer(device):
    with open(device, "rb", buffering=0) as handle:
        handle.seek(-TRAILER_SIZE, os.SEEK_END)
        data = handle.read(TRAILER_SIZE)
    if data[:16] != MAGIC:
        return None
    length = struct.unpack(">I", data[16:20])[0]
    require(0 < length <= 4096 and len(data) == TRAILER_SIZE, "The USB Wi-Fi handoff is incomplete.")
    payload = data[52:52 + length]
    require(hashlib.sha256(payload).digest() == data[20:52], "The USB Wi-Fi handoff failed its integrity check.")
    return decode(payload)


def write_trailer(device, capacity, image_size, profile):
    padded = (image_size + 4095) // 4096 * 4096
    require(capacity >= padded + TRAILER_SIZE, "The USB needs 64 KiB of free space after the installer image for Wi-Fi settings.")
    data = trailer(profile)
    testing = simulated()
    if testing:
        try:
            mode = os.lstat(device).st_mode
        except OSError:
            mode = 0
        require(stat.S_ISREG(mode), "Simulated Wi-Fi writes require an existing regular file, never a device or symlink.")
    flags = getattr(os, "O_BINARY", 0) | (getattr(os, "O_NOFOLLOW", 0) if testing else 0)
    with os.fdopen(os.open(device, os.O_RDWR | flags), "r+b", buffering=0) as handle:
        require(not testing or stat.S_ISREG(os.fstat(handle.fileno()).st_mode), "A simulated Wi-Fi write cannot target a device.")
        handle.seek(capacity - TRAILER_SIZE)
        require(handle.write(data) == len(data), "The USB accepted an incomplete Wi-Fi handoff.")
        os.fsync(handle.fileno())
    with os.fdopen(os.open(device, os.O_RDONLY | flags), "rb", buffering=0) as handle:
        require(not testing or stat.S_ISREG(os.fstat(handle.fileno()).st_mode), "A simulated Wi-Fi read cannot target a device.")
        handle.seek(capacity - TRAILER_SIZE)
        require(handle.read(TRAILER_SIZE) == data, "The USB Wi-Fi handoff did not read back correctly.")


def removable_devices(root=Path("/sys/class/block")):
    for entry in root.iterdir():
        if (entry / "partition").exists():
            continue
        try:
            if (entry / "removable").read_text().strip() == "1" or "/usb" in str(entry.resolve()):
                yield Path("/dev") / entry.name
        except OSError:
            continue


def prepare(live=LIVE, persistent=PERSISTENT, target=PROFILE, devices=None):
    if live.exists():
        profile = read_private(live)
    elif persistent.exists():
        profile = read_private(persistent)
    else:
        profiles = []
        for device in removable_devices() if devices is None else devices:
            try:
                profile = read_trailer(device)
            except OSError:
                continue
            if profile is not None:
                profiles.append(profile)
        require(len({encode(p) for p in profiles}) <= 1, "Conflicting USB Wi-Fi handoffs are attached. Leave only the intended installer connected.")
        profile = profiles[0] if profiles else None
    if profile is not None:
        write_private(live, encode(profile))
        write_private(target, keyfile(profile).encode())
    return profile


# ---- the live installer: connect, say what was seen, never guess ---------------------
#
# fleet-install runs `ready` before it reads the approval or touches a disk. Any
# working internet is accepted first: a cable, a phone's USB tethering, or a
# network the person chose with fleet-wifi. Otherwise the carried profile is
# connected, with the variants a network in range suggests. What was seen goes to
# network.json beside the installer's screen state (scripts/live_console.py): the
# screen shows it, and the problem report carries it without the network name.

MAC = re.compile(r"\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b")
KERNEL_WIFI = re.compile(r"firmware|wlan|wifi|wlp|wlo|80211|iwlwifi|rtw|rtl8|ath\d|mt7|brcm|mwifiex|\bwl\b", re.I)
KERNEL_TROUBLE = re.compile(r"fail|error|unable|timed? ?out|missing|not found|deauth|disassoc|reason|-\d+\b", re.I)
AUTH_NAMES = {"open": "open", "wpa-psk": "WPA2 Personal", "sae": "WPA3 Personal"}
CONNECT_BUDGET = 150  # seconds per readiness run; fleet-auto.sh repeats it until its own deadline
# (pattern in NetworkManager's error, code, sentence for the screen). First match wins.
NM_REASONS = (
    (r"Secrets were required|psk|password|4-way|handshake", "refused", "The Wi-Fi network refused the saved password."),
    (r"could not be found|No network with SSID", "not-visible", "The saved Wi-Fi network was not found in range."),
    (r"IP configuration|DHCP", "no-address", "Wi-Fi connected, but the network gave this computer no address (DHCP)."),
    (r"no device|not available|unavailable", "adapter-unavailable", "The Wi-Fi adapter is not ready."),
    (r"[Tt]imeout|took too long", "timeout", "Wi-Fi did not finish connecting in time."),
)


def live_state():
    return Path(os.environ.get("FLEET_LIVE_STATE") or "/run/fleet-live")


def sys_root():
    return Path(os.environ.get("FLEET_SYS") or "/sys")


def sysread(path, limit=256):
    try:
        return Path(path).read_text(errors="replace")[:limit].strip()
    except OSError:
        return ""


def cmdline_value(name):
    words = sysread(os.environ.get("FLEET_CMDLINE") or "/proc/cmdline", 8192).split()
    values = [word.split("=", 1)[1] for word in words if word.startswith(name + "=")]
    return values[-1] if values else ""


def hardware_id(device):
    """'pci 8086:2723' or 'usb 0bda:8179': enough to look up the driver an adapter needs."""
    vendor, product = sysread(device / "vendor"), sysread(device / "device")
    if vendor and product:
        return "pci " + re.sub(r"^0x", "", vendor) + ":" + re.sub(r"^0x", "", product)
    for parent in (device, device.parent):
        vendor, product = sysread(parent / "idVendor"), sysread(parent / "idProduct")
        if vendor and product:
            return f"usb {vendor}:{product}"
    return "unknown"


def adapters(root=None):
    """Network interfaces backed by hardware, as the kernel sees them."""
    root = root or sys_root()
    try:
        entries = sorted((root / "class/net").iterdir())
    except OSError:
        return []
    found = []
    for entry in entries:
        device = entry / "device"
        if not device.exists():
            continue  # lo, bridges and other virtual interfaces
        driver = device / "driver"
        found.append({
            "name": entry.name,
            "type": "wifi" if (entry / "wireless").exists() or (entry / "phy80211").exists() else "wired",
            "driver": Path(os.path.realpath(driver)).name if driver.exists() else "none",
            "id": hardware_id(Path(os.path.realpath(device))),
            "link": sysread(entry / "operstate") or "unknown",
            "carrier": sysread(entry / "carrier") == "1",
        })
    return found


def driverless(root=None):
    """Network controllers no driver claimed: Linux cannot use them at all."""
    root = root or sys_root()
    try:
        devices = sorted((root / "bus/pci/devices").iterdir())
    except OSError:
        return []
    return [hardware_id(device) for device in devices
            if sysread(device / "class").startswith("0x02") and not (device / "driver").exists()]


def radios(root=None):
    root = root or sys_root()
    try:
        entries = sorted((root / "class/rfkill").iterdir())
    except OSError:
        return []
    return [{"soft": sysread(entry / "soft") == "1", "hard": sysread(entry / "hard") == "1"}
            for entry in entries if sysread(entry / "type") == "wlan"]


def command(run, args, timeout=20):
    """(status, stdout, stderr) as text. A missing or hung tool is a status, not an exception."""
    try:
        done = run(args, capture_output=True, timeout=timeout, check=False, env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        return 127, "", "did not finish"

    def text(value):
        return value.decode("utf-8", "replace") if isinstance(value, bytes) else value or ""
    return done.returncode, text(getattr(done, "stdout", "")), text(getattr(done, "stderr", ""))


def terse(line):
    """Split one `nmcli --terse` line; a network name may contain an escaped colon."""
    fields, current, escaped = [], "", False
    for char in line:
        if escaped:
            current, escaped = current + char, False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append(current)
            current = ""
        else:
            current += char
    return fields + [current]


def wifi_devices(run):
    status, out, _ = command(run, ["nmcli", "--terse", "--fields", "DEVICE,TYPE,STATE", "device"])
    rows = [terse(line) for line in out.splitlines()] if status == 0 else []
    return [{"name": row[0], "state": row[2]} for row in rows if len(row) == 3 and row[1] == "wifi"]


def band(frequency):
    digits = re.match(r"\d+", frequency or "")
    mhz = int(digits.group(0)) if digits else 0
    return "6 GHz" if mhz >= 5925 else "5 GHz" if mhz >= 4900 else "2.4 GHz" if mhz else "unknown"


def scan(run, ssid):
    """How many networks are in range, and how the carried one looks if it is one of them."""
    status, out, _ = command(run, ["nmcli", "--terse", "--fields", "SSID,SIGNAL,SECURITY,FREQ",
                                   "device", "wifi", "list", "--rescan", "yes"], timeout=40)
    if status != 0:
        return None
    rows = [row for row in (terse(line) for line in out.splitlines()) if len(row) == 4]
    matches = sorted((row for row in rows if row[0] == ssid), key=lambda row: -int(row[1]) if row[1].isdigit() else 0)
    seen = {"nearby": len({row[0] for row in rows if row[0]}), "visible": bool(matches)}
    if matches:
        best = matches[0]
        seen.update(signal=int(best[1]) if best[1].isdigit() else None,
                    security=best[2].strip() if best[2].strip() not in ("", "--") else "open", band=band(best[3]))
    return seen


def variants(profile, seen):
    """The carried profile, then the one alternative the network in range suggests.
    Windows records WPA3 for a network that also offers WPA2, which some Linux
    drivers cannot do, and a hidden network never appears in a scan."""
    security = (seen or {}).get("security", "")
    older = "WPA2" in security or "WPA1" in security
    reusable = 8 <= utf8_length(profile["password"]) <= 63
    if profile["auth"] == "sae" and reusable and (seen is None or older):
        return [profile, {**profile, "auth": "wpa-psk"}]
    if profile["auth"] == "wpa-psk" and reusable and "WPA3" in security and not older:
        return [{**profile, "auth": "sae"}, profile]
    if seen is not None and not seen["visible"] and not profile["hidden"]:
        return [profile, {**profile, "hidden": True}]
    return [profile]


def clean(text, ssid=""):
    """Command output fit for a public report: no network name, no hardware address."""
    text = " ".join(str(text).split())
    if ssid:
        text = text.replace(ssid, "<network>")
    return MAC.sub("<mac>", text)[:120]


def explain(stderr, ssid):
    text = re.sub(r"^Error:\s*(Connection activation failed:\s*)?", "", " ".join(stderr.split()))
    for pattern, code, sentence in NM_REASONS:
        if re.search(pattern, text, re.I):
            return code, sentence, clean(text, ssid)
    return "no-connect", "Wi-Fi did not connect.", clean(text, ssid)


def kernel_notes(run, limit=4):
    """The kernel's last complaints about wireless hardware or firmware."""
    status, out, _ = command(run, ["journalctl", "--dmesg", "--boot", "--output", "cat", "--no-pager",
                                   "--lines", "600", "--quiet"], timeout=15)
    if status != 0:
        return []
    notes = [line for line in out.splitlines() if KERNEL_WIFI.search(line) and KERNEL_TROUBLE.search(line)]
    return [clean(line)[:140] for line in notes[-limit:]]


def routes(run):
    """Interfaces with a default route. None means no network at all."""
    names = []
    for args in (["ip", "route", "show", "default"], ["ip", "-6", "route", "show", "default"]):
        status, out, _ = command(run, args, timeout=10)
        names += re.findall(r"\bdev\s+(\S+)", out) if status == 0 else []
    return sorted(set(names))


def internet_ready():
    """DNS, then HTTPS with certificate checks, so a captive portal cannot pass.
    The message says which of the two failed."""
    try:
        socket.getaddrinfo("github.com", 443, type=socket.SOCK_STREAM)
    except OSError:
        raise WifiError("internet names do not resolve (DNS).") from None
    try:
        with urllib.request.urlopen("https://github.com/robots.txt", timeout=15) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        raise WifiError(f"github.com answered HTTP {exc.code}; a sign-in page (captive portal) may be in the way.") from None
    except OSError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise WifiError(f"the HTTPS certificate was refused ({reason.verify_message}); "
                            "a sign-in page (captive portal) or a wrong clock.") from None
        if isinstance(reason, (socket.timeout, TimeoutError)):
            raise WifiError("HTTPS to github.com timed out.") from None
        raise WifiError(f"HTTPS to github.com failed ({type(reason).__name__}).") from None
    require(status == 200, f"github.com answered HTTP {status}; a sign-in page (captive portal) may be in the way.")


def redraw():
    """Show progress on the installer screen now, not at its next 30-second tick."""
    tool = os.environ.get("FLEET_LIVE") or "fleet-live"
    if os.environ.get("FLEET_AUTO") != "1" or not shutil.which(tool):
        return
    try:
        subprocess.run([tool, "tick"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


class Facts:
    """network.json: what readiness checked and saw. The console user reads it
    (fleet-status), so it never holds a password. The network name is shown on
    this machine's screen; scripts/live_console.py keeps it out of reports."""

    def __init__(self, path=None):
        self.path = path
        self.data = {"checks": {}, "attempts": []}

    def update(self, **changes):
        self.data.update(changes)
        self.save()

    def check(self, name, state, detail=""):
        self.data["checks"][name] = {"state": state, "detail": detail}
        self.save()

    def attempt(self, profile, result, detail=""):
        entry = {"auth": profile["auth"], "hidden": profile["hidden"], "result": result, "detail": detail}
        self.data["attempts"] = (self.data["attempts"] + [entry])[-6:]
        self.save()

    def fail(self, code, sentence):
        self.update(code=code, verdict=sentence)
        return NetworkUnavailable(sentence)

    def save(self):
        if self.path is None:
            return
        self.data["updated"] = int(time.time())
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(self.path.name + ".new")
            temporary.write_text(json.dumps(self.data))
            temporary.chmod(0o644)
            temporary.replace(self.path)
        except OSError:
            return
        redraw()


def adapter_name(name):
    driver = next((item["driver"] for item in adapters() if item["name"] == name), "")
    return f"{name} ({driver})" if driver and driver != "none" else name


def no_adapter(facts, run):
    wireless = [item for item in adapters() if item["type"] == "wifi"]
    missing = driverless()
    if any(radio["hard"] for radio in radios()):
        code, sentence = "radio-off", "Wi-Fi is switched off by a hardware switch or key on this computer."
    elif wireless:
        code, sentence = "adapter-unavailable", (f"The Wi-Fi adapter ({wireless[0]['driver']}) is present but never became "
                                                 "ready; its firmware may be missing.")
    elif missing:
        code, sentence = "no-driver", f"This computer's network adapter ({missing[0]}) has no Linux driver in this installer."
    else:
        code, sentence = "no-adapter", "Linux found no Wi-Fi adapter on this computer."
    facts.check("adapter", "fail", sentence)
    facts.update(kernel=kernel_notes(run))
    return facts.fail(code, sentence)


def load(run, profile):
    write_private(PROFILE, keyfile(profile).encode())
    status, _, _ = command(run, ["nmcli", "connection", "load", str(PROFILE)])
    if status != 0:
        raise NetworkUnavailable("The Wi-Fi service could not load the private profile. Nothing was erased.")


def ready(profile, run=None, sleep=None, probe=None, facts=None, clock=None):
    """Connect the carried profile and prove the internet works. Returns the
    profile that worked: its security or hidden setting may differ from the carried one."""
    run, sleep, probe = run or subprocess.run, sleep or time.sleep, probe or internet_ready
    clock = clock or time.monotonic
    facts = facts or Facts()
    loaded = profile
    deadline = clock() + CONNECT_BUDGET
    command(run, ["rfkill", "unblock", "wlan"], timeout=10)
    command(run, ["nmcli", "radio", "wifi", "on"], timeout=10)
    facts.check("adapter", "active", "waiting for the Wi-Fi adapter")
    until = clock() + 20
    while True:
        usable = [device for device in wifi_devices(run) if device["state"] not in ("unavailable", "unmanaged")]
        if usable or clock() >= until:
            break
        sleep(2)
    if not usable:
        raise no_adapter(facts, run)
    facts.check("adapter", "ok", adapter_name(usable[0]["name"]))
    for round_number in range(1, 4):
        facts.check("visible", "active", "looking for the network")
        seen = scan(run, profile["ssid"])
        if seen is None:
            facts.check("visible", "unknown", "the scan did not finish")
        elif seen["visible"]:
            facts.check("visible", "ok", f"signal {seen['signal']}%, {seen['band']}, {seen['security']}")
        else:
            facts.check("visible", "fail", f"not among {seen['nearby']} networks in range")
        facts.update(scan=seen)
        for candidate in variants(profile, seen):
            label = AUTH_NAMES[candidate["auth"]] + (", hidden" if candidate["hidden"] else "")
            facts.check("connect", "active", f"try {round_number} of 3, {label}")
            if candidate != loaded:
                load(run, candidate)
                loaded = candidate
            status, _, error = command(run, ["nmcli", "--wait", "40", "connection", "up", "uuid", connection_id(candidate)], timeout=55)
            if status != 0:
                code, sentence, detail = explain(error, profile["ssid"])
                facts.attempt(candidate, code, detail)
                facts.check("connect", "fail", sentence)
                facts.update(code=code, verdict=sentence)
                continue
            facts.attempt(candidate, "connected")
            facts.check("connect", "ok", label)
            facts.check("internet", "active", "checking DNS and HTTPS to github.com")
            try:
                probe()
            except (OSError, WifiError) as exc:
                problem = str(exc) if isinstance(exc, WifiError) else "the internet check failed."
                facts.check("internet", "fail", problem)
                facts.update(code="internet", verdict="Wi-Fi connected, but " + problem)
                break  # the radio works; other security settings cannot fix the internet
            facts.check("internet", "ok", "DNS and HTTPS to github.com work")
            facts.update(code="ready", verdict="Connected to the internet over Wi-Fi.")
            return candidate
        if round_number < 3 and clock() < deadline:
            sleep(3 * round_number)
        else:
            break
    facts.update(kernel=kernel_notes(run))
    raise NetworkUnavailable(facts.data.get("verdict") or "Wi-Fi did not connect.")


def online(run, probe, facts):
    """Internet that already works, through anything. None when there is no route at all."""
    links = routes(run)
    if not links:
        return None
    facts.check("internet", "active", "checking DNS and HTTPS to github.com through " + ", ".join(links))
    try:
        probe()
    except (OSError, WifiError) as exc:
        problem = str(exc) if isinstance(exc, WifiError) else "the internet check failed."
        facts.check("internet", "fail", problem)
        facts.update(code="internet", verdict="Connected, but " + problem)
        return False
    facts.check("internet", "ok", "DNS and HTTPS to github.com work through " + ", ".join(links))
    facts.update(code="ready", verdict="Connected to the internet.", via=links)
    return True


def keep_working_wifi(facts):
    """A network the person chose (fleet-wifi) replaces the carried one, so the
    installed node joins the network that worked here."""
    try:
        active = discover("Linux")
    except WifiError:
        return
    if active is not None:
        write_private(LIVE, encode(active))
        facts.update(profile={"ssid": active["ssid"], "auth": active["auth"], "hidden": active["hidden"]})


def check(run=None, probe=None):
    run, probe = run or subprocess.run, probe or internet_ready
    facts = Facts(live_state() / "network.json")
    try:
        previous = json.loads((live_state() / "network.json").read_text()).get("run", 0)
    except (OSError, ValueError, AttributeError):
        previous = 0
    facts.update(run=int(previous) + 1 if str(previous).isdigit() else 1, sent=cmdline_value("fleet.wifi") or "unknown", arrived=LIVE.exists(), adapters=adapters(),
                 driverless=driverless(), radios=radios(), clock=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 code="checking", verdict="", via=[])
    if online(run, probe, facts):
        keep_working_wifi(facts)
        return
    profile = read_private(LIVE) if LIVE.exists() else discover("Linux")
    if profile is None:
        wired = [item for item in adapters() if item["type"] == "wired"]
        facts.check("settings", "fail", "none arrived")
        if any(item["carrier"] for item in wired):
            raise facts.fail("no-address", "A network cable is connected, but the network gave this computer no address (DHCP).")
        sent = facts.data["sent"] == "sent"
        raise facts.fail("settings-lost" if sent else "no-settings",
                         "Wi-Fi settings were sent with this restart but did not reach the installer, and no network cable is connected."
                         if sent else "No Wi-Fi settings reached the installer, and no network cable is connected.")
    facts.update(profile={"ssid": profile["ssid"], "auth": profile["auth"], "hidden": profile["hidden"]})
    facts.check("settings", "ok", AUTH_NAMES[profile["auth"]])
    write_private(LIVE, encode(profile))
    load(run, profile)
    working = ready(profile, run, facts=facts, probe=probe)
    if working != profile:
        write_private(LIVE, encode(working))


def main(args):
    if args == ["prepare"]:
        prepare()
    elif args == ["ready"]:
        check()
    elif len(args) == 2 and args[0] == "persist":
        if LIVE.exists():
            profile = read_private(LIVE)
            destination = Path(args[1]) / "nix/fleet-state/network/wifi.json"
            write_private(destination, encode(profile))
            require(read_private(destination) == profile, "Installed Wi-Fi settings failed read-back verification.")
    else:
        raise WifiError("Unknown Wi-Fi handoff operation.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except NetworkUnavailable as exc:
        print(f"FLEET_NETWORK_UNAVAILABLE: {exc} Nothing was erased; the installer tries again automatically.", file=sys.stderr)
        sys.exit(75)
    except WifiError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)
    except OSError:
        # Never emit exception repr, profile contents or subprocess output.
        print("Fleet Wi-Fi setup failed. Check Wi-Fi credentials and connectivity before retrying; disk installation was stopped.", file=sys.stderr)
        sys.exit(2)
