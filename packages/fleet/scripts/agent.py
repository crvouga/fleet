#!/usr/bin/env python3
"""fleet-agent: report this node to the fleet API and apply the settings it sends.

The contract is packages/fleet-api/PROTOCOL.md. Two rules shape everything here.

* Data, never code. The API sends typed settings. This program interprets the
  keys it knows (scripts/fleetconf.py lists them) and ignores the rest. Nothing
  a server sends is ever executed, written into a unit, or used as a path.
* The fleet works without the API. Reporting is best effort. A node that cannot
  reach the server keeps its last settings (cached on disk) and the values built
  into its image. Nothing in this program can block fleet-sync or a runner.

Commands:  run (loop, for the unit)   once (one report)   status   retire

Python standard library only, Python 3.11 or newer, runs as root on NixOS.
FLEET_API_URL names the server; empty (or a URL containing TODO) disables the agent.
"""
import hashlib
import json
import os
import random
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import cattle  # noqa: E402  (sibling module; the Nix derivation puts all three scripts together)
import fleetconf  # noqa: E402
import node_readiness  # noqa: E402
import recovery  # noqa: E402
import telemetry  # noqa: E402

VERSION = "1"
DEFAULT_INTERVAL = 60
BACKOFF_CAP = 900
REJECTED_DELAY = 3600
HTTP_TIMEOUT = 15
RETIRE_TIMEOUT = 5
MAX_RESPONSE = 1 << 20
MAX_EVENTS = 20
MAX_MESSAGE = 500
DRAIN_RETRY_SECONDS = 900
# Active roles in roles.json; rewritten by scripts/fleet_roles.py sync.
ROLES = ("ci", "devbox")
HEX64 = re.compile(r"[0-9a-f]{64}")
REVISION = re.compile(r"[0-9a-f]{1,64}")
TOKEN_CHARS = re.compile(r"[A-Za-z0-9._-]{8,512}")
UNIT_NAME = re.compile(r"[A-Za-z0-9:_.\\@-]+\.(?:service|socket|timer|mount|target|path|device|swap|scope|slice)")

_REDACTIONS = (
    (re.compile(r"(?i)\bBearer\s+[^\s\"']+"), "Bearer [redacted]"),
    (re.compile(r"(?i)((?:secret|token|password|authorization)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+"), r"\1[redacted]"),
    (re.compile(r"\b(?:hvs|hvb|hvr|ghp|gho|ghs|ghu|github_pat|AGE-SECRET-KEY)[-_A-Za-z0-9.]+"), "[redacted]"),
    (re.compile(r"[0-9a-fA-F]{32,}"), "[redacted]"),
)


def redact(text, known=()):
    """Remove tokens and keys from anything that is logged or sent as an event."""
    text = str(text)
    for value in known:
        if value and len(value) >= 4:
            text = text.replace(value, "[redacted]")
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


class NetworkError(Exception):
    """The server could not be reached (DNS, TLS, timeout, reset). The message is a class name only."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def default_http(method, url, headers, body, timeout):
    """Send one request. TLS verification stays on; redirects are never followed (they would carry the token)."""
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(MAX_RESPONSE + 1)
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read(MAX_RESPONSE + 1)
        finally:
            error.close()
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise NetworkError(type(error).__name__) from None


class Clock:
    def time(self):
        return time.time()

    def monotonic(self):
        return time.monotonic()


def default_run(argv, timeout=10):
    """Run a command and return (exit code, stdout). A missing program or a timeout is a failure, not a crash."""
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return 127, ""
    return done.returncode, done.stdout


def api_base(url):
    """The usable base URL, or None when the agent is disabled. Raises ValueError for a URL that must not be used."""
    value = (url or "").strip()
    if not value or "TODO" in value:
        return None
    parsed = urlparse(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise ValueError("FLEET_API_URL must be a plain URL: no credentials, query or fragment")
    loopback = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("FLEET_API_URL must be https (http only for the loopback address)")
    return value.rstrip("/")


class Paths:
    """Every place the agent reads or writes. Tests point these at a temporary directory."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.state = Path(env.get("FLEET_AGENT_STATE") or "/nix/fleet-state/agent")
        self.run = Path(env.get("FLEET_RUN") or "/run/fleet")
        self.etc = Path(env.get("FLEET_ETC") or "/etc/fleet")
        self.proc = Path(env.get("FLEET_PROC") or "/proc")
        self.sys = Path(env.get("FLEET_SYS") or "/sys")
        self.nix_mount = env.get("FLEET_NIX_MOUNT") or "/nix"
        self.boot_mount = env.get("FLEET_BOOT_MOUNT") or "/boot"
        self.root_mount = env.get("FLEET_ROOT_MOUNT") or "/"
        self.applied = Path(env.get("FLEET_CONFIG") or self.state.parent / "config.json")
        self.systemctl = env.get("FLEET_SYSTEMCTL") or "systemctl"
        self.systemd_run = env.get("FLEET_SYSTEMD_RUN") or "systemd-run"
        self.drain = env.get("FLEET_DRAIN") or "/run/current-system/sw/bin/fleet-drain"
        self.resume = env.get("FLEET_RESUME") or "/run/current-system/sw/bin/fleet-resume"

    @property
    def secret(self):
        return self.state / "node.secret"

    @property
    def role_token(self):
        return self.state / "role-token"

    @property
    def config(self):
        return self.state / "config.json"

    @property
    def reported(self):
        return self.state / "reported.json"

    @property
    def status(self):
        return self.state / "status.json"


def read_text(path, limit=65536):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return None


def read_kv(path):
    data = {}
    for line in (read_text(path) or "").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip()
    return data


def read_json(path):
    text = read_text(path, 262144)
    if text is None:
        return None
    try:
        return json.loads(text)
    except (ValueError, RecursionError):
        return None


def write_private(path, text):
    fleetconf.write_atomic(str(path), text, 0o600)


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clip(text, limit):
    text = str(text)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def used_percent(path):
    """Like df: used / (used + available), rounded up. None when the mount cannot be read."""
    try:
        stat = os.statvfs(path)
    except OSError:
        return None
    used = stat.f_blocks - stat.f_bfree
    total = used + stat.f_bavail
    if total <= 0:
        return None
    return min(100, -(-used * 100 // total))


class Agent:
    def __init__(self, paths, url, http=None, clock=None, sleep=None, rng=None, run=None, log=None):
        self.paths = paths
        self.base = api_base(url)
        self.http = http or default_http
        self.clock = clock or Clock()
        self.sleep = sleep or time.sleep
        self.rng = rng or random.Random()
        self.command = run or default_run
        self.log_line = log or (lambda line: print(line, file=sys.stderr, flush=True))
        self.secret = None
        self.needs_register = False
        self.approval = None
        self.register_interval = None
        self.failures = 0
        self.rejected = False
        self.last_error = None
        self.last_success = None
        self.config_revision = None
        self.settings = {}
        self.problems = []
        self.last_drain_attempt = None
        self.readiness = None
        self.readiness_at = None
        self.outbox_sent = []
        self.loaded = False
        self.applied_once = False
        self.services_unknown = False
        self.telemetry = telemetry.Collector(paths, self.command, self.clock,
            lambda value: redact(value, [self.secret or "", self._token() or ""]))

    # logging -----------------------------------------------------------------

    def log(self, message):
        self.log_line("fleet-agent: " + redact(message, [self.secret or "", self._token() or ""]))

    # state -------------------------------------------------------------------

    def _token(self):
        """The optional role token from the installer. Invalid content is ignored, never used."""
        text = read_text(self.paths.role_token, 1024)
        value = (text or "").strip()
        return value if TOKEN_CHARS.fullmatch(value) else None

    def ensure_secret(self):
        """Keep a 32 byte random node secret on disk (0600). A new one means the node must register again."""
        current = (read_text(self.paths.secret, 256) or "").strip()
        if HEX64.fullmatch(current):
            if self.secret is not None and current != self.secret:
                self.needs_register = True
            self.secret = current
            return False
        if current:
            self.log("node.secret is not a 64 digit hex string; generating a new one")
        fresh = secrets.token_hex(32)
        self.paths.state.mkdir(parents=True, exist_ok=True)
        os.chmod(self.paths.state, 0o700)
        write_private(self.paths.secret, fresh + "\n")
        self.secret = fresh
        self.needs_register = True
        return True

    def load_cached(self):
        """The last config the API sent. Corrupt or missing means no cached config (image defaults)."""
        if self.loaded:
            return
        self.loaded = True
        document = read_json(self.paths.config)
        revision = document.get("revision") if isinstance(document, dict) else None
        values = document.get("values") if isinstance(document, dict) else None
        if isinstance(revision, str) and REVISION.fullmatch(revision) and isinstance(values, dict):
            self.config_revision = revision
            self.settings = fleetconf.sanitize(values)
        elif document is not None:
            self.log("cached config.json is not valid; ignoring it")

    def reported_state(self):
        document = read_json(self.paths.reported)
        return document if isinstance(document, dict) else {}

    # identity ----------------------------------------------------------------

    def identity(self):
        node = read_kv(self.paths.run / "node")
        role = node.get("role")
        hostname = node.get("hostname")
        if role not in ROLES or not hostname:
            return None
        machine_id = node.get("machine_id", "")
        if not HEX64.fullmatch(machine_id):
            try:
                machine_id = cattle.read_machine_digest(
                    attempts=1,
                    uuid_path=str(self.paths.sys / "class/dmi/id/product_uuid"),
                    net_root=str(self.paths.sys / "class/net"),
                )
            except (ValueError, OSError):
                return None
        capabilities = [tag for tag in node.get("capabilities", "").split(",") if tag]
        return {
            "id": machine_id,
            "role": role,
            "hostname": hostname,
            "runner_prefix": node.get("runner_prefix") or hostname,
            "capabilities": capabilities,
            "arch": node.get("arch") or None,
        }

    # collecting facts ---------------------------------------------------------

    def meminfo(self):
        facts = {}
        for line in (read_text(self.paths.proc / "meminfo") or "").splitlines():
            parts = line.replace(":", " ").split()
            if len(parts) >= 2 and parts[1].isdigit():
                facts[parts[0]] = int(parts[1]) // 1024
        return facts

    def cpu(self):
        text = read_text(self.paths.proc / "cpuinfo") or ""
        model = None
        logical = 0
        for line in text.splitlines():
            if line.startswith("processor"):
                logical += 1
            elif line.startswith("model name") and model is None and ":" in line:
                model = clip(line.split(":", 1)[1].strip(), 200) or None
        cores = None
        if (self.paths.sys / "devices/system/cpu").is_dir():
            try:
                cores = cattle.physical_cores(str(self.paths.sys / "devices/system/cpu"))
            except (OSError, ValueError):
                cores = None
        if cores is None and logical:
            cores = logical
        return {"cores": cores, "model": model}

    def addresses(self):
        code, out = self.command(["ip", "-j", "addr"], 5)
        found = []
        if code == 0:
            try:
                interfaces = json.loads(out)
            except (ValueError, RecursionError):
                interfaces = []
            for interface in interfaces if isinstance(interfaces, list) else []:
                if not isinstance(interface, dict) or "LOOPBACK" in (interface.get("flags") or []):
                    continue
                for entry in interface.get("addr_info") or []:
                    if isinstance(entry, dict) and entry.get("scope") == "global" and isinstance(entry.get("local"), str):
                        if entry["local"] not in found:
                            found.append(entry["local"])
        else:
            found = self._route_address()
        return [address[:64] for address in found[:16]]

    def _route_address(self):
        """No packet is sent: connecting a UDP socket only asks the kernel which address it would use."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(("192.0.2.1", 9))
                address = probe.getsockname()[0]
        except OSError:
            return []
        return [] if address.startswith("0.") else [address]

    def failed_units(self):
        code, out = self.command([self.paths.systemctl, "--failed", "--plain", "--no-legend", "--no-pager"], 10)
        self.services_unknown = code != 0
        if code != 0:
            return []
        units = []
        for line in out.splitlines():
            token = line.strip().lstrip("*● ").split(" ", 1)[0] if line.strip() else ""
            if UNIT_NAME.fullmatch(token) and len(token) <= 128 and token not in units:
                units.append(token)
        return units[:100]

    def rollback_reason(self):
        text = read_text(self.paths.run / "health-failure", 8192)
        if text is None:
            text = read_text(self.paths.state.parent / "sync/health-failure", 8192)
        if text is None:
            return None
        lines = [line for line in text.splitlines() if not re.match(r"^(mode|previous|toplevel)=", line)]
        mode = next((line.split("=", 1)[1] for line in text.splitlines() if line.startswith("mode=")), "switch")
        reason = " ".join(line.strip() for line in lines if line.strip()) or "health check failed"
        return mode, reason

    def runners(self, identity):
        if identity["role"] != "ci":
            return None
        count, selected, busy = telemetry.configured_slots(self.paths)
        if count is None:
            return None
        return {"slots": len(selected), "busy": len(busy)}

    def recovery_facts(self):
        try:
            return recovery.status(self.recovery_base, run=self.paths.run, sync=self.paths.state.parent / "sync")
        except OSError:
            return None

    def revision(self):
        value = (read_text(self.paths.etc / "revision", 256) or "").strip()
        return value if value and value != "unknown" else None

    @property
    def recovery_base(self):
        return self.paths.state.parent / "recovery"

    def note_recovery(self, kind, severity, key, message, data=None):
        """A recovery fact, kept on disk until Fleet accepts it (scripts/recovery.py)."""
        try:
            recovery.queue(kind, severity, key, message, data, base=self.recovery_base)
        except (OSError, ValueError) as error:
            self.log(f"could not record a {kind} event: {type(error).__name__}")

    def collect_events(self, identity):
        """Events since the last accepted report, and the state to remember once the server accepted them.

        Every event carries a key, so a report the server stored but whose
        answer was lost cannot record the same event twice when it is resent.
        Recovery events come from the durable outbox and leave it only once a
        heartbeat carrying them was accepted (self.outbox_sent)."""
        reported = self.reported_state()
        update = dict(reported)
        events = []
        boot_id = (read_text(self.paths.proc / "sys/kernel/random/boot_id", 128) or "").strip() or None
        if boot_id and reported.get("bootId") != boot_id:
            events.append({"kind": "boot", "severity": "info", "message": "node started", "key": f"boot:{boot_id}"})
            update["bootId"] = boot_id
        failure = self.rollback_reason()
        if failure is not None:
            mode, reason = failure
            signature = hashlib.sha256(f"{mode}\n{reason}".encode()).hexdigest()[:16]
            if reported.get("rollback") != signature:
                rolled_back = mode in ("boot", "switch")
                events.append({"kind": "rollback" if rolled_back else "update-failed", "severity": "error",
                    "message": f"sync {'rolled back' if rolled_back else 'failed'} ({mode}): {reason}",
                    "key": f"sync:{signature}"})
                update["rollback"] = signature
        else:
            update.pop("rollback", None)
        pending = (read_text(self.paths.run / "reboot-pending", 1024) or "").strip()
        if (self.paths.run / "reboot-pending").exists():
            signature = hashlib.sha256(pending.encode()).hexdigest()[:16]
            if reported.get("rebootPending") != signature:
                events.append({
                    "kind": "reboot-pending",
                    "severity": "warn",
                    "message": "a new kernel is installed; the reboot waits for reboot.enabled",
                    "key": f"reboot-pending:{signature}",
                })
                update["rebootPending"] = signature
        else:
            update.pop("rebootPending", None)
        for problem in self.problems:
            signature = hashlib.sha256(f"{boot_id}\n{problem}".encode()).hexdigest()[:16]
            events.append({"kind": "config", "severity": "warn", "message": problem, "key": f"config:{signature}"})
        try:
            recovery.recover_jobs(base=self.recovery_base)
            queued = recovery.pending(self.recovery_base)
        except OSError as error:
            self.log(f"could not read the recovery outbox: {type(error).__name__}")
            queued = []
        room = max(0, MAX_EVENTS - len(events))
        self.outbox_sent = [record["key"] for record in queued[:room]]
        events += [{"kind": record["kind"], "severity": record["severity"], "message": record["message"],
                    "key": record["key"], "at": record.get("at"), "data": record.get("data") or {}}
                   for record in queued[:room]]
        secrets_ = [self.secret or "", self._token() or ""]
        events = [
            {
                "kind": clip(event["kind"], 40),
                "severity": event["severity"],
                "message": clip(redact(event["message"], secrets_), MAX_MESSAGE),
                **({"key": event["key"]} if event.get("key") else {}),
                **({"at": event["at"]} if event.get("at") else {}),
                **({"data": {name: (clip(redact(value, secrets_), 300) if isinstance(value, str) else value)
                             for name, value in event["data"].items()
                             if isinstance(value, (str, int, float, bool)) or value is None}}
                   if event.get("data") else {}),
            }
            for event in events[:MAX_EVENTS]
        ]
        return events, update

    def heartbeat_body(self, identity, events):
        memory = self.meminfo()
        uptime = (read_text(self.paths.proc / "uptime", 128) or "").split()
        load = (read_text(self.paths.proc / "loadavg", 128) or "").split()
        failure = self.rollback_reason()
        try:
            uptime_seconds = int(float(uptime[0]))
        except (IndexError, ValueError):
            uptime_seconds = None
        try:
            load1 = float(load[0])
        except (IndexError, ValueError):
            load1 = None
        arch = identity["arch"]
        if not arch:
            arch = os.uname().machine
        failed_units = self.failed_units()
        readiness = node_readiness.issues(self.paths, identity, self.command, self._token(), self.settings)
        if self.services_unknown:
            readiness = ["FLEET_SERVICE_STATUS_UNKNOWN: systemd service health could not be verified."] + readiness[:11]
        body = {
            "v": 1,
            "nodeId": identity["id"],
            "role": identity["role"],
            "hostname": identity["hostname"],
            "capabilities": identity["capabilities"],
            "revision": self.revision(),
            "bootId": (read_text(self.paths.proc / "sys/kernel/random/boot_id", 128) or "").strip() or None,
            "uptimeSeconds": uptime_seconds,
            "kernel": clip((read_text(self.paths.proc / "sys/kernel/osrelease", 128) or "").strip(), 64) or None,
            "arch": clip(arch, 32),
            "cpu": self.cpu(),
            "memory": {"totalMiB": memory.get("MemTotal"), "availableMiB": memory.get("MemAvailable")},
            "load1": load1,
            "disk": {
                "nixUsedPercent": used_percent(self.paths.nix_mount),
                "bootUsedPercent": used_percent(self.paths.boot_mount),
            },
            "addresses": self.addresses(),
            "sync": {
                "rolledBack": failure is not None and failure[0] in ("boot", "switch"),
                "healthFailure": clip(redact(failure[1], [self.secret or ""]), 300) if failure else None,
                "paused": self.settings.get("sync.paused") is True,
            },
            "failedUnits": failed_units,
            "runners": self.runners(identity),
            "readiness": {"issues": [clip(redact(item, [self.secret or "", self._token() or ""]), 500)
                for item in readiness]},
            "agent": {"version": VERSION, "configRevision": self.config_revision},
            "events": events,
            "recovery": self.recovery_facts(),
        }
        # Kept for the node's console screen (node_console.py): what Fleet is told.
        self.readiness = body["readiness"]["issues"]
        self.readiness_at = iso(self.clock.time())
        try:
            body["telemetry"] = self.telemetry.collect(identity, failed_units, self.services_unknown)
        except Exception:
            # One broken sensor must never hide the heartbeat or leak its raw
            # exception. Missing telemetry remains unknown to older servers.
            body["telemetry"] = {"sampledAt": iso(self.clock.time()), "cpuUsagePercent": None,
                "filesystems": [], "temperatures": [], "power": [], "swap": None,
                "network": [], "runnerSlots": [], "logs": [],
                "issues": ["Telemetry collection failed; measurements are unknown and will be retried."]}
        while len(json.dumps(body, separators=(",", ":")).encode()) > 48 * 1024:
            for key in ("logs", "temperatures", "power", "network", "runnerSlots", "filesystems"):
                if body["telemetry"][key]:
                    body["telemetry"][key].pop()
                    issue = "Telemetry was bounded to fit the heartbeat request budget."
                    if issue not in body["telemetry"]["issues"] and len(body["telemetry"]["issues"]) < 16:
                        body["telemetry"]["issues"].append(issue)
                    break
            else:
                break
        return body

    # talking to the API -------------------------------------------------------

    def api(self, method, path, body, bearer=None, timeout=HTTP_TIMEOUT):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"fleet-agent/{VERSION}",
        }
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        status, raw = self.http(method, self.base + path, headers, json.dumps(body, separators=(",", ":")).encode(), timeout)
        document = None
        if isinstance(raw, (bytes, bytearray)) and len(raw) <= MAX_RESPONSE:
            try:
                parsed = json.loads(raw.decode("utf-8", "replace") or "null")
                document = parsed if isinstance(parsed, dict) else None
            except (ValueError, RecursionError):
                document = None
        return status, document

    def describe(self, status, document):
        """A log-safe description of a failed answer: the status and the server's error code, nothing else."""
        code = document.get("error") if isinstance(document, dict) else None
        return f"HTTP {status}" + (f" ({clip(code, 40)})" if isinstance(code, str) else "")

    def register(self, identity):
        body = {
            "nodeId": identity["id"],
            "role": identity["role"],
            "hostname": identity["hostname"],
            "secret": self.secret,
        }
        token = self._token()
        if token:
            body["roleToken"] = token
        status, document = self.api("POST", "/v1/nodes/register", body)
        if status in (200, 201) and document and document.get("status") in ("approved", "pending", "rejected"):
            self.needs_register = False
            self.approval = document["status"]
            interval = document.get("heartbeatIntervalSeconds")
            if type(interval) is int and 15 <= interval <= 3600:
                self.register_interval = interval
            self.log(f"registered with the fleet API: {self.approval}")
            return True
        self.last_error = "register: " + self.describe(status, document)
        self.log(self.last_error)
        return False

    def send_heartbeat(self, identity):
        events, update = self.collect_events(identity)
        body = self.heartbeat_body(identity, events)
        status, document = self.api("POST", "/v1/heartbeat", body, bearer=f"{identity['id']}.{self.secret}")
        return status, document, update

    # configuration ------------------------------------------------------------

    def accept_config(self, config):
        revision = config.get("revision") if isinstance(config, dict) else None
        values = config.get("values") if isinstance(config, dict) else None
        if not (isinstance(revision, str) and REVISION.fullmatch(revision) and isinstance(values, dict)):
            self.log("ignoring a config block with an invalid shape")
            return
        flat = fleetconf.sanitize(values)
        write_private(self.paths.config, json.dumps({"revision": revision, "values": fleetconf.nest(flat)}, sort_keys=True) + "\n")
        self.config_revision = revision
        self.settings = flat
        self.log(f"received config {revision}")
        self.apply(flat)

    def apply(self, flat):
        """Make this node's runtime match the settings. Each step stands alone: one failing never blocks the rest."""
        self.step("write applied config", self.write_applied, flat)
        try:
            node_conf = cattle.load_conf(str(self.paths.etc / "node.conf"))
            role = node_conf["role"]
        except (OSError, KeyError, ValueError):
            self.log("no node.conf; runner settings are not applied")
            return
        if role != "ci":
            self.step("runner labels", self.apply_labels_only, node_conf, flat)
            return
        outcome = {}
        self.step("runner files", self.apply_runner_files, node_conf, flat, outcome)
        self.step("drain and resume", self.apply_drain, flat, node_conf)
        self.step("capacity", self.apply_capacity, outcome)
        self.step("restart idle slots", self.refresh_slots, node_conf, outcome)

    def reconcile(self):
        """Every cycle, with or without the API: keep enforcing the cached settings.

        A drain that did not finish is retried (rate limited); a slot that was
        busy when the capacity went down is stopped once it is idle.
        """
        node_conf = self.safe_node_conf()
        if node_conf.get("role") != "ci":
            return
        self.step("drain and resume", self.apply_drain, self.settings, node_conf)
        self.step("capacity", self.apply_capacity, {})
        self.step("runner refresh", self.refresh_stale_slots, node_conf)

    def refresh_stale_slots(self, node_conf):
        """Bring idle runners onto the system an update installed.

        Runner units are not restarted by an update (runners.nix sets
        restartIfChanged = false): restarting them killed the jobs they were
        running. A busy runner takes the new system when its job ends and it
        registers again; an idle one is restarted here. Each slot records the
        system it started on (/run/fleet/slot-N/system)."""
        if (self.paths.run / "draining").exists():
            return
        current = os.path.realpath(os.environ.get("FLEET_CURRENT_SYSTEM") or "/run/current-system")
        states = self.units_state(node_conf)
        for number, state in sorted(states.items()):
            slot = f"slot-{number}"
            started = (read_text(self.paths.run / slot / "system", 1024) or "").strip()
            if state != "active" or not started or started == current:
                continue
            if (self.paths.run / slot / "busy").exists():
                continue
            self.command([self.paths.systemctl, "--no-block", "try-restart", f"github-runner-{slot}.service"], 15)

    def step(self, name, function, *args):
        try:
            function(*args)
        except Exception as error:  # a bad step is reported, never fatal
            message = f"{name} failed: {type(error).__name__}"
            self.problems.append(message)
            self.log(message)

    def write_applied(self, flat):
        text = json.dumps(fleetconf.nest(flat), sort_keys=True, indent=2) + "\n"
        fleetconf.write_atomic(str(self.paths.applied), text, 0o600)
        fleetconf.write_atomic(str(self.paths.run / "config.json"), text, 0o644)

    def node_facts(self):
        node = read_kv(self.paths.run / "node")
        ram = cattle.mem_total_mib(read_text(self.paths.proc / "meminfo", 65536) or "")
        cores = cattle.physical_cores(str(self.paths.sys / "devices/system/cpu"))
        return node.get("arch") or os.uname().machine, ram, cores

    def tags_for(self, node_conf, flat, ram):
        high_mem = cattle.effective_capacity(node_conf, flat)["high_mem_gib"]
        return cattle.capability_tags(self.paths.etc / "capabilities.d", ram, high_mem)

    def apply_labels_only(self, node_conf, flat):
        arch, ram, cores = self.node_facts()
        cattle.apply_dynamic(self.paths.run, node_conf, flat, ram, cores, arch, self.tags_for(node_conf, flat, ram))

    def apply_runner_files(self, node_conf, flat, outcome):
        arch, ram, cores = self.node_facts()
        outcome.update(cattle.apply_dynamic(self.paths.run, node_conf, flat, ram, cores, arch, self.tags_for(node_conf, flat, ram)))

    def slot_max(self, node_conf):
        return max(1, int(node_conf.get("slot_max", "1")))

    def units_state(self, node_conf):
        """{slot number: systemd ActiveState} for every slot unit in this image's closure."""
        numbers = list(range(1, self.slot_max(node_conf) + 1))
        code, out = self.command([self.paths.systemctl, "is-active", *[f"github-runner-slot-{n}.service" for n in numbers]], 15)
        lines = out.splitlines()
        return {n: (lines[i].strip() if i < len(lines) else "unknown") for i, n in enumerate(numbers)}

    def launch(self, unit, argv, env=None):
        """Start a transient unit and return at once; the agent never waits on a drain."""
        code, _ = self.command([self.paths.systemctl, "is-active", "--quiet", unit + ".service"], 10)
        if code == 0:
            return False
        options = [f"--setenv={name}={value}" for name, value in sorted((env or {}).items())]
        code, _ = self.command([self.paths.systemd_run, "--no-block", "--collect", f"--unit={unit}", *options, "--", *argv], 15)
        if code != 0:
            self.log(f"could not start {unit}")
        return code == 0

    def apply_drain(self, flat, node_conf):
        wanted = flat.get("runners.enabled") is False or flat.get("runners.cordoned") is True
        draining = (self.paths.run / "draining").exists()
        marker = self.paths.run / "agent-drained"
        if wanted:
            active = [n for n, state in self.units_state(node_conf).items() if state in ("active", "activating")]
            due = self.last_drain_attempt is None or self.clock.monotonic() - self.last_drain_attempt >= DRAIN_RETRY_SECONDS
            if (not draining or active) and due:
                self.last_drain_attempt = self.clock.monotonic()
                if self.launch("fleet-config-drain", [self.paths.drain], {"FLEET_DRAIN_REASON": "config"}):
                    fleetconf.write_atomic(str(marker), "drain started by fleet configuration\n", 0o644)
                    self.log("runners disabled or cordoned by configuration; draining")
        else:
            self.last_drain_attempt = None
            if marker.exists():
                if not draining:
                    marker.unlink()
                elif self.launch("fleet-config-resume", [self.paths.resume]):
                    self.log("runners enabled by configuration; resuming")
                    # Keep the marker until a later cycle observes that resume
                    # actually removed the drain gate. Launching is not success.
            elif draining:
                self.reopen_orphaned_gate(flat)

    def reopen_orphaned_gate(self, flat):
        """Admission closed with nothing left that wants it closed: reopen it.

        Each holder of the gate records a reason (scripts/drain.sh). A cordon
        lifted while its drain was still starting, or a drain from before
        reasons existed, leaves the gate closed with no owner; without this the
        node silently serves no jobs until it reboots. A manual drain stays closed
        until a person reopens it, here through runners.reopenAfter in Fleet."""
        if (self.paths.run / "update-draining").exists():
            return  # an update holds admission; fleet-sync resumes or reboots
        reasons = self.paths.run / "drain-reasons"
        try:
            held = {path.name: path.stat().st_mtime for path in reasons.iterdir()}
        except OSError:
            held = {}
        reopen_after = flat.get("runners.reopenAfter")
        if "manual" in held and type(reopen_after) is int and reopen_after > held["manual"]:
            held.pop("manual")
            (reasons / "manual").unlink(missing_ok=True)
            self.note_recovery("gate-reopened", "info", f"gate:manual:{reopen_after}",
                               "Runner admission was reopened from Fleet after a manual drain.")
        if set(held) - {"config", "unknown"}:
            return  # an update, low disk or a manual drain still holds it
        if self.launch("fleet-gate-resume", [self.paths.resume]):
            self.log("runner admission was closed with no remaining reason; reopening")
            self.note_recovery("gate-reopened", "warn", f"gate:orphan:{int(self.clock.time()) // 3600}",
                               "Runner admission was closed with no remaining reason (for example a cordon lifted "
                               "while its drain was starting); it was reopened automatically.")

    def apply_capacity(self, outcome):
        pending = (self.paths.run / "capacity-pending").exists()
        if outcome.get("slots_changed") or pending:
            self.command([self.paths.systemctl, "--no-block", "restart", "fleet-capacity.service"], 15)

    def refresh_slots(self, node_conf, outcome):
        """New labels or a new repository only reach a runner when it registers again. Idle runners do that now; busy ones after their job."""
        if (self.paths.run / "draining").exists():
            return
        if outcome.get("labels_changed"):
            slots = {f"slot-{n}" for n in range(1, self.slot_max(node_conf) + 1)}
        else:
            slots = set(outcome.get("assignments_changed") or ())
        if not slots:
            return
        states = self.units_state(node_conf)
        count = outcome.get("slots") or 0
        for slot in sorted(slots):
            number = int(slot.rsplit("-", 1)[1]) if slot.rsplit("-", 1)[-1].isdigit() else 0
            if number < 1 or number > count or states.get(number) != "active":
                continue
            if (self.paths.run / slot / "busy").exists():
                continue
            self.command([self.paths.systemctl, "--no-block", "try-restart", f"github-runner-{slot}.service"], 15)

    # the loop -----------------------------------------------------------------

    def interval(self):
        configured = self.settings.get("heartbeat.intervalSeconds")
        if type(configured) is int:
            return configured
        return self.register_interval or DEFAULT_INTERVAL

    def jitter(self, seconds):
        return seconds + seconds * 0.1 * self.rng.random()

    def delay_after_failure(self):
        base = self.interval()
        steps = min(max(self.failures - 1, 0), 10)
        return self.jitter(min(max(BACKOFF_CAP, base), base * 2**steps))

    def record_status(self, outcome, delay):
        document = {
            "api": self.base,
            "outcome": outcome,
            "approval": self.approval,
            "lastAttemptAt": iso(self.clock.time()),
            "lastSuccessAt": iso(self.last_success) if self.last_success else None,
            "failures": self.failures,
            "lastError": self.last_error,
            "configRevision": self.config_revision,
            "intervalSeconds": self.interval(),
            "nextInSeconds": int(delay),
            "readiness": self.readiness,
            "readinessAt": self.readiness_at,
        }
        try:
            write_private(self.paths.status, json.dumps(document, sort_keys=True) + "\n")
        except OSError:
            pass

    def cycle(self):
        """One attempt to report. Returns (ok, seconds until the next attempt). Never raises."""
        try:
            return self._cycle()
        except Exception as error:  # the loop must outlive any surprise
            self.failures += 1
            self.last_error = f"unexpected {type(error).__name__}"
            self.log(f"{self.last_error}: {error}")
            delay = self.delay_after_failure()
            self.record_status("failed", delay)
            return False, delay

    def fail(self, reason, delay=None):
        self.failures += 1
        self.last_error = reason
        delay = self.delay_after_failure() if delay is None else delay
        self.log(f"{reason}; trying again in {int(delay)}s")
        self.record_status("failed", delay)
        return False, delay

    def _cycle(self):
        self.ensure_secret()
        self.load_cached()
        if not self.applied_once:
            self.applied_once = True
            if self.settings:
                self.apply(self.settings)
        else:
            self.reconcile()
        identity = self.identity()
        if identity is None:
            return self.fail("identity is not ready (no /run/fleet/node)", self.jitter(30))
        try:
            if self.needs_register and not self.register(identity):
                return self.fail(self.last_error or "register failed")
            status, document, update = self.send_heartbeat(identity)
            if status == 401:
                self.log("the server does not know this node; registering again")
                self.needs_register = True
                if not self.register(identity):
                    return self.fail(self.last_error or "register failed")
                status, document, update = self.send_heartbeat(identity)
        except NetworkError as error:
            return self.fail(f"API unreachable ({error}); keeping the cached config")
        if status == 403:
            self.failures = 0
            self.rejected = True
            self.last_error = "heartbeat: " + self.describe(status, document)
            delay = self.jitter(REJECTED_DELAY)
            self.log(f"{self.last_error}; reporting hourly")
            self.record_status("rejected", delay)
            return False, delay
        if status != 200 or document is None:
            return self.fail("heartbeat: " + self.describe(status, document))
        self.rejected = False
        self.failures = 0
        self.last_error = None
        self.last_success = self.clock.time()
        if document.get("status") in ("approved", "pending"):
            self.approval = document["status"]
        try:
            write_private(self.paths.reported, json.dumps(update, sort_keys=True) + "\n")
        except OSError:
            self.log("could not save reported state")
        # Fleet stored these recovery events; a crash before this line only
        # resends them, and the server ignores keys it already has.
        try:
            recovery.acknowledge(self.outbox_sent, base=self.recovery_base)
        except OSError:
            self.log("could not clear the recovery outbox")
        self.outbox_sent = []
        self.problems = []
        if "config" in document:
            self.accept_config(document["config"])
        delay = self.jitter(self.interval())
        self.record_status("ok", delay)
        return True, delay

    def safe_node_conf(self):
        try:
            return cattle.load_conf(str(self.paths.etc / "node.conf"))
        except (OSError, ValueError):
            return {}

    def run_forever(self, max_cycles=None):
        cycles = 0
        while max_cycles is None or cycles < max_cycles:
            _ok, delay = self.cycle()
            cycles += 1
            if max_cycles is not None and cycles >= max_cycles:
                break
            self.sleep(delay)

    # commands ------------------------------------------------------------------

    def retire(self):
        """Tell the API this node is leaving. Best effort and short: removal never waits on the network."""
        current = (read_text(self.paths.secret, 256) or "").strip()
        identity = self.identity()
        if not HEX64.fullmatch(current) or identity is None:
            return 0
        self.secret = current
        try:
            status, document = self.api("POST", "/v1/retire", {}, bearer=f"{identity['id']}.{current}", timeout=RETIRE_TIMEOUT)
        except NetworkError as error:
            self.log(f"retire: API unreachable ({error})")
            return 1
        if status == 200:
            self.log("retired from the fleet API")
            return 0
        self.log("retire: " + self.describe(status, document))
        return 1

    def status_lines(self):
        document = read_json(self.paths.status)
        document = document if isinstance(document, dict) else {}
        identity = self.identity()
        cached = read_json(self.paths.config)
        revision = cached.get("revision") if isinstance(cached, dict) else None
        return [
            f"api: {self.base}",
            f"node: {identity['hostname'] if identity else 'unknown'}"
            + (f" ({identity['id'][:12]})" if identity else ""),
            f"node secret: {'present' if HEX64.fullmatch((read_text(self.paths.secret, 256) or '').strip()) else 'missing'}",
            f"role token: {'present' if self._token() else 'absent'}",
            f"registration: {document.get('approval') or 'unknown'}",
            f"last report: {document.get('lastAttemptAt') or 'never'} ({document.get('outcome') or 'none'})",
            f"last success: {document.get('lastSuccessAt') or 'never'}",
            f"last error: {document.get('lastError') or 'none'}",
            f"config revision: {revision if isinstance(revision, str) else 'none'}",
            f"report interval: {document.get('intervalSeconds') or DEFAULT_INTERVAL}s",
        ]


USAGE = "usage: agent.py run | once | status | retire"


def main(argv=None, env=None, **seams):
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    if len(argv) != 1 or argv[0] not in ("run", "once", "status", "retire"):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        base = api_base(env.get("FLEET_API_URL"))
    except ValueError as error:
        print(f"fleet-agent: disabled: {error}", file=sys.stderr)
        return 0
    if base is None:
        return 0
    agent = Agent(Paths(env), base, **seams)
    command = argv[0]
    if command == "run":
        agent.run_forever()
        return 0
    if command == "once":
        ok, _ = agent.cycle()
        for line in agent.status_lines():
            print(line)
        return 0 if ok else 1
    if command == "status":
        agent.load_cached()
        for line in agent.status_lines():
            print(line)
        return 0
    return agent.retire()


if __name__ == "__main__":
    sys.exit(main())
