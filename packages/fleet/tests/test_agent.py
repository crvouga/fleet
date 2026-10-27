#!/usr/bin/env python3
"""fleet-agent against a real local HTTP server that speaks packages/fleet-api/PROTOCOL.md."""

import hashlib
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).parents[1] / "scripts"
PROTOCOL = Path(__file__).parents[2] / "fleet-api" / "PROTOCOL.md"
sys.path.insert(0, str(SCRIPTS))

import agent  # noqa: E402
import fleetconf  # noqa: E402

MACHINE_ID = "a3f9" + "0123456789abcdef" * 3 + "0123456789ab"
ROLE_TOKEN = "ci-role-token-9f8e7d6c5b4a"
HOSTNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9._:+-]{1,64}$")
EVENT_KIND_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")


def revision_of(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:16]


class Rng:
    """No jitter, so delays are exact."""

    def random(self):
        return 0.0


class Clock:
    def __init__(self):
        self.now = 1_760_000_000.0

    def time(self):
        return self.now

    def monotonic(self):
        return self.now


def validate_heartbeat(body):
    """The limits in packages/fleet-api/src/domain/heartbeat-validation.ts, as errors."""
    errors = []

    def need(condition, message):
        if not condition:
            errors.append(message)

    def number(value, low, high, integer=False):
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and low <= value <= high
            and (not integer or isinstance(value, int))
        )

    def nullable_string(value, limit, pattern=None):
        return value is None or (isinstance(value, str) and len(value) <= limit and (pattern is None or pattern.match(value)))

    need(body.get("v") == 1, "v")
    need(isinstance(body.get("nodeId"), str) and re.fullmatch(r"[0-9a-f]{64}", body["nodeId"]), "nodeId")
    need(body.get("role") in agent.ROLES, "role")
    need(isinstance(body.get("hostname"), str) and HOSTNAME_RE.match(body["hostname"]), "hostname")
    caps = body.get("capabilities")
    need(isinstance(caps, list) and len(caps) <= 32 and all(isinstance(c, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,50}", c) for c in caps), "capabilities")
    need(nullable_string(body.get("revision"), 64, TOKEN_RE), "revision")
    need(nullable_string(body.get("bootId"), 64, TOKEN_RE), "bootId")
    need(body.get("uptimeSeconds") is None or number(body["uptimeSeconds"], 0, 10_000_000_000, True), "uptimeSeconds")
    need(nullable_string(body.get("kernel"), 64), "kernel")
    need(nullable_string(body.get("arch"), 32), "arch")
    cpu = body.get("cpu") or {}
    need(cpu.get("cores") is None or number(cpu["cores"], 0, 4096, True), "cpu.cores")
    need(nullable_string(cpu.get("model"), 200), "cpu.model")
    memory = body.get("memory") or {}
    for key in ("totalMiB", "availableMiB"):
        need(memory.get(key) is None or number(memory[key], 0, 1_000_000_000, True), "memory." + key)
    need(body.get("load1") is None or number(body["load1"], 0, 1_000_000), "load1")
    disk = body.get("disk") or {}
    for key in ("nixUsedPercent", "bootUsedPercent"):
        need(disk.get(key) is None or number(disk[key], 0, 100), "disk." + key)
    addresses = body.get("addresses")
    need(isinstance(addresses, list) and len(addresses) <= 16 and all(isinstance(a, str) and len(a) <= 64 for a in addresses), "addresses")
    sync = body.get("sync") or {}
    need(isinstance(sync.get("rolledBack"), bool) and isinstance(sync.get("paused"), bool), "sync flags")
    need(nullable_string(sync.get("healthFailure"), 500), "sync.healthFailure")
    units = body.get("failedUnits")
    need(isinstance(units, list) and len(units) <= 100 and all(isinstance(u, str) and len(u) <= 128 for u in units), "failedUnits")
    runners = body.get("runners")
    need(runners is None or (number(runners.get("slots"), 0, 4096, True) and number(runners.get("busy"), 0, 4096, True)), "runners")
    info = body.get("agent") or {}
    need(isinstance(info.get("version"), str) and TOKEN_RE.match(info["version"]), "agent.version")
    need(nullable_string(info.get("configRevision"), 64, TOKEN_RE), "agent.configRevision")
    events = body.get("events")
    need(isinstance(events, list) and len(events) <= 20, "events")
    for event in events if isinstance(events, list) else []:
        need(isinstance(event.get("kind"), str) and EVENT_KIND_RE.match(event["kind"]), "event.kind")
        need(isinstance(event.get("message"), str) and len(event["message"]) <= 500, "event.message")
        need(event.get("severity") in ("info", "warn", "error"), "event.severity")
    return errors


class Api:
    """A small server for the node endpoints of PROTOCOL.md."""

    def __init__(self):
        self.nodes = {}
        self.requests = []
        self.script = []
        self.role_tokens = {"ci": ROLE_TOKEN}
        self.values = {}
        self.interval = 60
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": body, "raw": raw})
                status, payload = outer.respond(self.path, self.headers.get("Authorization"), body)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def paths(self):
        return [request["path"] for request in self.requests]

    def of(self, path):
        return [request for request in self.requests if request["path"] == path]

    def envelope(self, node):
        values = self.values if node["approval"] == "approved" else {"heartbeat": {"intervalSeconds": self.interval}}
        return {"revision": revision_of(values), "values": values}

    def respond(self, path, authorization, body):
        if self.script:
            status, payload = self.script.pop(0)
            return status, payload
        if path == "/v1/nodes/register":
            return self.register(body)
        credential = (authorization or "").removeprefix("Bearer ").partition(".")
        node = self.nodes.get(credential[0])
        known = node is not None and node["secretHash"] == hashlib.sha256(credential[2].encode()).hexdigest()
        if not known:
            return 401, {"error": "unauthorized", "message": "Register again."}
        if path == "/v1/retire":
            node["approval"] = "retired"
            return 200, {"ok": True}
        if node["approval"] in ("rejected", "retired"):
            return 403, {"error": node["approval"], "message": "Back off."}
        errors = validate_heartbeat(body or {})
        if errors or body["nodeId"] != credential[0]:
            return 400, {"error": "invalid_request", "message": "; ".join(errors)}
        node["last"] = body
        envelope = self.envelope(node)
        answer = {"ok": True, "status": node["approval"], "serverTime": "2026-10-14T12:00:00.000Z"}
        if body["agent"]["configRevision"] != envelope["revision"]:
            answer["config"] = envelope
        return 200, answer

    def register(self, body):
        valid = (
            isinstance(body, dict)
            and re.fullmatch(r"[0-9a-f]{64}", str(body.get("nodeId")))
            and re.fullmatch(r"[0-9a-f]{64}", str(body.get("secret")))
            and HOSTNAME_RE.match(str(body.get("hostname")))
            and body.get("role") in self.role_tokens
        )
        if not valid:
            return 400, {"error": "invalid_request", "message": "bad body"}
        proved = body.get("roleToken") is not None and body["roleToken"] == self.role_tokens[body["role"]]
        existing = self.nodes.get(body["nodeId"])
        approval = "approved" if proved else "pending"
        if existing and existing["approval"] == "rejected":
            approval = "rejected"
        created = existing is None
        self.nodes[body["nodeId"]] = {
            "secretHash": hashlib.sha256(body["secret"].encode()).hexdigest(),
            "approval": approval,
            "role": body["role"],
        }
        return (201 if created else 200), {"status": approval, "heartbeatIntervalSeconds": self.interval}


class FakeRun:
    """Stands in for ip, systemctl and systemd-run. Records every command."""

    def __init__(self):
        self.calls = []
        self.failed = "fleet-disk.service loaded failed failed Fail when /nix is full\n"
        self.active = set()
        self.refuse = set()

    def __call__(self, argv, timeout=10):
        self.calls.append(list(argv))
        name = Path(argv[0]).name
        if name == "ip":
            interfaces = [
                {"ifname": "lo", "flags": ["LOOPBACK", "UP"], "addr_info": [{"family": "inet", "local": "127.0.0.1", "scope": "host"}]},
                {"ifname": "enp1", "flags": ["UP"], "addr_info": [
                    {"family": "inet", "local": "192.168.1.20", "scope": "global"},
                    {"family": "inet6", "local": "fe80::1", "scope": "link"},
                ]},
            ]
            return 0, json.dumps(interfaces)
        if name == "systemctl":
            if "--failed" in argv:
                return 0, self.failed
            if argv[1] == "is-active" and "--quiet" in argv:
                return (0 if argv[-1] in self.active else 3), ""
            if argv[1] == "is-active":
                states = ["active" if unit in self.active else "inactive" for unit in argv[2:]]
                return (0 if all(state == "active" for state in states) else 3), "\n".join(states) + "\n"
            return 0, ""
        if name == "systemd-run":
            return (1 if "systemd-run" in self.refuse else 0), ""
        return 127, ""

    def matching(self, *words):
        return [call for call in self.calls if all(word in call for word in words)]


MEMINFO = "MemTotal:       16777216 kB\nMemFree:         1024 kB\nMemAvailable:   10485760 kB\n"
CPUINFO = "".join(f"processor\t: {n}\nmodel name\t: Test CPU 9000\n\n" for n in range(4))
EXAMPLE_REVISION = "9f3c2a1e5b7d4c6a8e0f1b2c3d4e5f6a7b8c9d0e"


class Node:
    """A temporary machine: /run/fleet, /etc/fleet, /proc, /sys and the state directory."""

    def __init__(self, root, role="ci"):
        self.root = Path(root)
        self.run = self.root / "run/fleet"
        self.etc = self.root / "etc/fleet"
        self.proc = self.root / "proc"
        self.sys = self.root / "sys"
        self.state = self.root / "nix/fleet-state/agent"
        for directory in (self.run, self.etc / "capabilities.d", self.proc / "sys/kernel/random"):
            directory.mkdir(parents=True)
        (self.run / "node").write_text(
            f"hostname={role}-gpu-a3f9\nrole={role}\nid=a3f9\nmachine_id={MACHINE_ID}\ncapabilities=gpu\narch=x86_64\n"
        )
        (self.etc / "capabilities.d/gpu").write_text("gpu\n")
        if role == "ci":
            (self.run / "slot-count").write_text("4\n")
            for n in range(1, 9):
                (self.run / f"slot-{n}").mkdir()
        (self.etc / "node.conf").write_text(
            f"role={role}\nflake_attr={role}\nreserve_gib=4\nper_runner_gib=6\nper_runner_cores=2\nslot_max=8\nhigh_mem_gib=60\n"
        )
        (self.etc / "revision").write_text(EXAMPLE_REVISION + "\n")
        (self.proc / "meminfo").write_text(MEMINFO)
        (self.proc / "cpuinfo").write_text(CPUINFO)
        (self.proc / "uptime").write_text("86400.55 100.00\n")
        (self.proc / "loadavg").write_text("0.42 0.30 0.20 1/100 1234\n")
        (self.proc / "sys/kernel/random/boot_id").write_text("5b0f1c9e-0000-4000-8000-000000000001\n")
        (self.proc / "sys/kernel/osrelease").write_text("6.12.30\n")
        for n in range(4):
            topology = self.sys / f"devices/system/cpu/cpu{n}/topology"
            topology.mkdir(parents=True)
            (topology / "physical_package_id").write_text("0\n")
            (topology / "core_id").write_text(f"{n}\n")

    def env(self, url=""):
        return {
            "FLEET_API_URL": url,
            "FLEET_AGENT_STATE": str(self.state),
            "FLEET_RUN": str(self.run),
            "FLEET_ETC": str(self.etc),
            "FLEET_PROC": str(self.proc),
            "FLEET_SYS": str(self.sys),
            "FLEET_NIX_MOUNT": str(self.root),
            "FLEET_BOOT_MOUNT": str(self.root),
            "FLEET_SYSTEMCTL": "systemctl",
            "FLEET_SYSTEMD_RUN": "systemd-run",
            "FLEET_DRAIN": "/test/fleet-drain",
            "FLEET_RESUME": "/test/fleet-resume",
        }

    @property
    def applied(self):
        return self.root / "nix/fleet-state/config.json"

    def set_boot_id(self, value):
        (self.proc / "sys/kernel/random/boot_id").write_text(value + "\n")

    def busy(self, slot):
        (self.run / f"slot-{slot}/busy").write_text("1\n")


class AgentCase(unittest.TestCase):
    role = "ci"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.node = Node(self.tmp.name, self.role)
        self.api = Api()
        self.run_stub = FakeRun()
        self.logs = []
        self.clock = Clock()
        self.sleeps = []

    def tearDown(self):
        self.api.close()
        self.tmp.cleanup()

    def make(self, url=None, role_token=None):
        if role_token is not None:
            self.node.state.mkdir(parents=True, exist_ok=True)
            (self.node.state / "role-token").write_text(role_token + "\n")
        return agent.Agent(
            agent.Paths(self.node.env()),
            url or self.api.url,
            clock=self.clock,
            sleep=self.sleeps.append,
            rng=Rng(),
            run=self.run_stub,
            log=self.logs.append,
        )

    def heartbeats(self):
        return [request["body"] for request in self.api.of("/v1/heartbeat")]

    def secret(self):
        return (self.node.state / "node.secret").read_text().strip()


class RegistrationTests(AgentCase):
    def test_first_run_creates_a_private_secret_and_registers_with_the_role_token(self):
        worker = self.make(role_token=ROLE_TOKEN)
        ok, delay = worker.cycle()
        self.assertTrue(ok, self.logs)
        self.assertEqual(delay, 60)
        secret = self.secret()
        self.assertRegex(secret, r"^[0-9a-f]{64}$")
        self.assertEqual((self.node.state / "node.secret").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.node.state.stat().st_mode & 0o777, 0o700)
        register, = self.api.of("/v1/nodes/register")
        self.assertNotIn("Authorization", register["headers"])
        self.assertEqual(
            register["body"],
            {"nodeId": MACHINE_ID, "role": "ci", "hostname": "ci-gpu-a3f9", "secret": secret, "roleToken": ROLE_TOKEN},
        )
        self.assertEqual(self.api.nodes[MACHINE_ID]["approval"], "approved")
        heartbeat, = self.api.of("/v1/heartbeat")
        self.assertEqual(heartbeat["headers"]["Authorization"], f"Bearer {MACHINE_ID}.{secret}")
        self.assertEqual(heartbeat["headers"]["Content-Type"], "application/json")

    def test_without_a_role_token_the_node_waits_for_approval_and_keeps_reporting(self):
        worker = self.make()
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        register, = self.api.of("/v1/nodes/register")
        self.assertNotIn("roleToken", register["body"])
        self.assertEqual(self.api.nodes[MACHINE_ID]["approval"], "pending")
        self.assertEqual(len(self.heartbeats()), 1)
        status = json.loads((self.node.state / "status.json").read_text())
        self.assertEqual(status["approval"], "pending")
        # A pending node is told only how often to report. Nothing else is applied.
        self.assertEqual(json.loads(self.node.applied.read_text()), {"heartbeat": {"intervalSeconds": 60}})
        self.api.nodes[MACHINE_ID]["approval"] = "approved"
        worker.cycle()
        self.assertEqual(json.loads((self.node.state / "status.json").read_text())["approval"], "approved")
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 1)

    def test_an_invalid_role_token_file_is_ignored(self):
        worker = self.make(role_token="has spaces and is not a token")
        worker.cycle()
        register, = self.api.of("/v1/nodes/register")
        self.assertNotIn("roleToken", register["body"])

    def test_a_rejected_node_backs_off_to_hourly_and_does_not_crash(self):
        worker = self.make()
        worker.cycle()
        self.api.nodes[MACHINE_ID]["approval"] = "rejected"
        ok, delay = worker.cycle()
        self.assertFalse(ok)
        self.assertEqual(delay, 3600)
        ok, delay = worker.cycle()
        self.assertEqual(delay, 3600)
        self.assertEqual(json.loads((self.node.state / "status.json").read_text())["outcome"], "rejected")
        self.api.nodes[MACHINE_ID]["approval"] = "approved"
        ok, delay = worker.cycle()
        self.assertTrue(ok)
        self.assertEqual(delay, 60)

    def test_a_401_registers_again_and_reports_in_the_same_cycle(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        self.api.nodes.clear()
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 2)
        self.assertEqual(self.api.nodes[MACHINE_ID]["approval"], "approved")
        self.assertEqual(self.api.paths()[-3:], ["/v1/heartbeat", "/v1/nodes/register", "/v1/heartbeat"])

    def test_a_regenerated_secret_registers_again(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        first = self.secret()
        (self.node.state / "node.secret").write_text("this is not a secret\n")
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        self.assertNotEqual(self.secret(), first)
        self.assertRegex(self.secret(), r"^[0-9a-f]{64}$")
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 2)
        self.assertEqual(self.api.of("/v1/nodes/register")[-1]["body"]["secret"], self.secret())

    def test_a_restart_with_a_secret_on_disk_does_not_register_again(self):
        self.make().cycle()
        self.make().cycle()
        self.assertEqual(len(self.api.of("/v1/nodes/register")), 1)
        self.assertEqual(len(self.heartbeats()), 2)

    def test_the_id_falls_back_to_the_hardware_when_the_node_file_predates_machine_id(self):
        (self.node.run / "node").write_text("hostname=ci-a3f9\nrole=ci\nid=a3f9\ncapabilities=\narch=x86_64\n")
        dmi = self.node.sys / "class/dmi/id"
        dmi.mkdir(parents=True)
        (dmi / "product_uuid").write_text("ABCDEF01-2345-6789-ABCD-EF0123456789\n")
        import cattle
        expected = cattle.machine_digest("abcdef01-2345-6789-abcd-ef0123456789", None)
        self.make().cycle()
        self.assertEqual(self.heartbeats()[0]["nodeId"], expected)


class HeartbeatPayloadTests(AgentCase):
    def example(self):
        if not PROTOCOL.is_file():
            self.skipTest("packages/fleet-api/PROTOCOL.md is not present")
        text = PROTOCOL.read_text()
        for block in re.findall(r"```json\n(.*?)```", text, re.S):
            if '"v": 1' in block and '"nodeId"' in block:
                return json.loads(block)
        self.fail("PROTOCOL.md has no heartbeat example")

    def shape(self, value):
        if isinstance(value, dict):
            return {key: self.shape(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.shape(value[0])] if value and isinstance(value[0], dict) else "list"
        if isinstance(value, bool):
            return "bool"
        if isinstance(value, int):
            return "int"
        if isinstance(value, float):
            return "float"
        return type(value).__name__

    def test_the_payload_has_exactly_the_documented_fields_and_types(self):
        self.node.state.mkdir(parents=True)
        revision = revision_of({})
        (self.node.state / "config.json").write_text(json.dumps({"revision": revision, "values": {}}))
        (self.node.run / "slot-1/busy").write_text("1\n")
        self.make().cycle()
        body = self.heartbeats()[0]
        self.assertEqual(validate_heartbeat(body), [])
        documented = self.example()
        # The example's event list holds one entry; the agent reports a boot event.
        # Keep the base protocol compatible with older agents while the
        # optional telemetry extension depends on the host's available sensors.
        self.assertEqual(self.shape({key: value for key, value in body.items() if key != "telemetry"}),
                         self.shape({key: value for key, value in documented.items() if key != "telemetry"}))
        self.assertEqual(set(body["telemetry"]), {"sampledAt", "cpuUsagePercent", "filesystems", "temperatures",
            "power", "swap", "network", "runnerSlots", "logs", "issues"})

    def test_every_field_is_filled_from_the_machine(self):
        (self.node.run / "slot-1/busy").write_text("1\n")
        (self.node.run / "slot-3/busy").write_text("1\n")
        (self.node.run / "health-failure").write_text("mode=switch\nprevious=/p\ntoplevel=/t\ngithub unreachable\n")
        self.make().cycle()
        body = self.heartbeats()[0]
        for key in ("v", "nodeId", "role", "hostname", "capabilities", "revision", "bootId", "uptimeSeconds", "kernel", "arch",
                    "cpu", "memory", "load1", "disk", "addresses", "sync", "failedUnits", "runners", "agent", "events"):
            self.assertIn(key, body)
        self.assertEqual(body["v"], 1)
        self.assertEqual(body["nodeId"], MACHINE_ID)
        self.assertEqual(body["role"], "ci")
        self.assertEqual(body["hostname"], "ci-gpu-a3f9")
        self.assertEqual(body["capabilities"], ["gpu"])
        self.assertEqual(body["revision"], EXAMPLE_REVISION)
        self.assertEqual(body["bootId"], "5b0f1c9e-0000-4000-8000-000000000001")
        self.assertEqual(body["uptimeSeconds"], 86400)
        self.assertEqual(body["kernel"], "6.12.30")
        self.assertEqual(body["arch"], "x86_64")
        self.assertEqual(body["cpu"], {"cores": 4, "model": "Test CPU 9000"})
        self.assertEqual(body["memory"], {"totalMiB": 16384, "availableMiB": 10240})
        self.assertEqual(body["load1"], 0.42)
        for key in ("nixUsedPercent", "bootUsedPercent"):
            self.assertIsInstance(body["disk"][key], int)
            self.assertTrue(0 <= body["disk"][key] <= 100)
        self.assertEqual(body["addresses"], ["192.168.1.20"])
        self.assertEqual(body["sync"], {"rolledBack": True, "healthFailure": "github unreachable", "paused": False})
        self.assertEqual(body["failedUnits"], ["fleet-disk.service"])
        self.assertEqual(body["runners"], {"slots": 4, "busy": 2})
        self.assertEqual(body["agent"], {"version": "1", "configRevision": None})

    def test_a_node_without_runners_reports_null_and_unreadable_facts_are_null(self):
        for path in ("proc/uptime", "proc/loadavg", "etc/fleet/revision", "proc/sys/kernel/osrelease"):
            (self.node.root / path).unlink()
        (self.node.run / "slot-count").unlink()
        self.run_stub.failed = "garbage that is not a unit\n"
        self.make().cycle()
        body = self.heartbeats()[0]
        self.assertIsNone(body["runners"])
        self.assertIsNone(body["uptimeSeconds"])
        self.assertIsNone(body["load1"])
        self.assertIsNone(body["revision"])
        self.assertIsNone(body["kernel"])
        self.assertEqual(body["failedUnits"], [])
        self.assertEqual(validate_heartbeat(body), [])

    def test_a_non_ci_node_has_no_runner_block(self):
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        self.node = Node(self.tmp.name, "devbox")
        self.api.role_tokens["devbox"] = ROLE_TOKEN
        self.make().cycle()
        self.assertIsNone(self.heartbeats()[0]["runners"])
        self.assertEqual(self.heartbeats()[0]["role"], "devbox")

    def test_ip_missing_falls_back_to_the_route_address(self):
        original = self.run_stub.__call__

        def no_ip(argv, timeout=10):
            if Path(argv[0]).name == "ip":
                self.run_stub.calls.append(list(argv))
                return 127, ""
            return original(argv, timeout)

        worker = self.make()
        worker.command = no_ip
        worker.cycle()
        addresses = self.heartbeats()[0]["addresses"]
        self.assertIsInstance(addresses, list)
        self.assertLessEqual(len(addresses), 1)

    def test_limits_hold_for_many_failed_units_and_long_text(self):
        self.run_stub.failed = "".join(f"unit-{n}.service loaded failed failed x\n" for n in range(300))
        self.node.state.mkdir(parents=True)
        (self.node.run / "node").write_text(
            f"hostname=ci-a3f9\nrole=ci\nid=a3f9\nmachine_id={MACHINE_ID}\ncapabilities=gpu\narch=x86_64\n"
        )
        (self.node.run / "health-failure").write_text("mode=switch\n" + "x" * 5000 + "\n")
        self.make().cycle()
        body = self.heartbeats()[0]
        self.assertEqual(len(body["failedUnits"]), 100)
        self.assertEqual(validate_heartbeat(body), [])
        self.assertLessEqual(len(body["events"][-1]["message"]), 500)


class EventTests(AgentCase):
    def kinds(self, index):
        return [event["kind"] for event in self.heartbeats()[index]["events"]]

    def test_boot_is_reported_once_per_boot(self):
        worker = self.make()
        worker.cycle()
        worker.cycle()
        self.assertEqual(self.kinds(0), ["boot"])
        self.assertEqual(self.kinds(1), [])
        self.node.set_boot_id("5b0f1c9e-0000-4000-8000-000000000002")
        worker.cycle()
        self.assertEqual(self.kinds(2), ["boot"])
        self.make().cycle()
        self.assertEqual(self.kinds(3), [])

    def test_a_boot_event_is_not_lost_when_the_server_is_down(self):
        worker = self.make()
        worker.cycle()
        self.node.set_boot_id("5b0f1c9e-0000-4000-8000-000000000003")
        self.api.script = [(500, {"error": "internal"})]
        ok, _ = worker.cycle()
        self.assertFalse(ok)
        worker.cycle()
        self.assertEqual(self.kinds(-1), ["boot"])
        self.assertEqual([k for k in map(self.kinds_of, self.heartbeats())].count(["boot"]), 3)

    def kinds_of(self, body):
        return [event["kind"] for event in body["events"]]

    def test_rollback_is_reported_when_the_health_failure_file_appears_and_only_once(self):
        worker = self.make()
        worker.cycle()
        (self.node.run / "health-failure").write_text("mode=switch\nprevious=/p\ntoplevel=/t\ngithub unreachable\n")
        worker.cycle()
        worker.cycle()
        self.assertEqual(self.kinds(1), ["rollback"])
        event = self.heartbeats()[1]["events"][0]
        self.assertEqual(event["severity"], "error")
        self.assertIn("github unreachable", event["message"])
        self.assertEqual(self.kinds(2), [])
        self.assertTrue(self.heartbeats()[2]["sync"]["rolledBack"])
        (self.node.run / "health-failure").unlink()
        worker.cycle()
        (self.node.run / "health-failure").write_text("mode=boot\nprevious=/p\ntoplevel=/t\ncache unreachable\n")
        worker.cycle()
        self.assertEqual(self.kinds(4), ["rollback"])

    def test_a_pending_reboot_is_reported_as_a_warning_once(self):
        worker = self.make()
        worker.cycle()
        (self.node.run / "reboot-pending").write_text("toplevel=/nix/store/x\n")
        worker.cycle()
        worker.cycle()
        self.assertEqual(self.kinds(1), ["reboot-pending"])
        self.assertEqual(self.heartbeats()[1]["events"][0]["severity"], "warn")
        self.assertEqual(self.kinds(2), [])

    def test_at_most_twenty_events_with_truncated_messages(self):
        worker = self.make()
        worker.problems = ["step failed: " + "x" * 2000 for _ in range(40)]
        worker.cycle()
        events = self.heartbeats()[0]["events"]
        self.assertEqual(len(events), 20)
        self.assertEqual(events[0]["kind"], "boot")
        self.assertTrue(all(len(event["message"]) <= 500 for event in events))
        self.assertEqual(validate_heartbeat(self.heartbeats()[0]), [])


class ConfigTests(AgentCase):
    FULL = {
        "heartbeat": {"intervalSeconds": 30},
        "sync": {"paused": True},
        "reboot": {"enabled": False, "delayMaxSeconds": 10},
        "disk": {"alertPercent": 80},
        "capacity": {"reserveGiB": 0, "perRunnerGiB": 1, "perRunnerCores": 1, "slotMax": 2},
        "runners": {"extraLabels": ["fast", "team-a"], "repositories": ["o/a", "o/b", "o/c"], "enabled": True, "cordoned": False},
    }

    def approved(self, values):
        self.api.role_tokens["ci"] = ROLE_TOKEN
        self.api.values = values
        return self.make(role_token=ROLE_TOKEN)

    def read(self, path):
        return (self.node.run / path).read_text()

    def test_a_config_is_persisted_applied_and_acknowledged_by_revision(self):
        worker = self.approved(self.FULL)
        ok, delay = worker.cycle()
        self.assertTrue(ok, self.logs)
        revision = revision_of(self.FULL)
        cached = json.loads((self.node.state / "config.json").read_text())
        self.assertEqual(cached, {"revision": revision, "values": self.FULL})
        self.assertEqual(json.loads(self.node.applied.read_text()), self.FULL)
        self.assertEqual(json.loads(self.read("config.json")), self.FULL)
        self.assertEqual(self.node.applied.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.read("runner-labels").split(), ["x64", "gpu", "fast", "team-a"])
        self.assertEqual(self.read("slot-count"), "2\n")
        self.assertEqual([self.read(f"assign/slot-{n}").strip() for n in range(1, 9)], ["o/a", "o/b", "o/c", "o/a", "o/b", "o/c", "o/a", "o/b"])
        self.assertTrue(self.run_stub.matching("--no-block", "restart", "fleet-capacity.service"))
        # The interval changed. The next report names the new revision and the server stops sending config.
        ok, delay = worker.cycle()
        self.assertTrue(ok)
        self.assertEqual(delay, 30)
        self.assertEqual(self.heartbeats()[1]["agent"]["configRevision"], revision)
        self.assertTrue(self.heartbeats()[1]["sync"]["paused"])
        self.assertNotIn("config", [k for r in [self.api.requests[-1]] for k in r["body"]])

    def test_the_revision_is_kept_across_a_restart(self):
        self.approved(self.FULL).cycle()
        self.make().cycle()
        self.assertEqual(self.heartbeats()[-1]["agent"]["configRevision"], revision_of(self.FULL))
        self.assertEqual(len(self.api.of("/v1/heartbeat")), 2)

    def test_removing_repositories_removes_the_assignments(self):
        worker = self.approved(self.FULL)
        worker.cycle()
        self.assertTrue((self.node.run / "assign/slot-1").exists())
        self.api.values = {"runners": {"extraLabels": ["fast"]}}
        worker.cycle()
        self.assertEqual(list((self.node.run / "assign").iterdir()), [])
        self.assertEqual(self.read("runner-labels").split(), ["x64", "gpu", "fast"])
        self.assertEqual(self.read("slot-count"), "2\n")

    def test_capacity_keys_override_the_formula_but_never_exceed_the_image(self):
        worker = self.approved({"capacity": {"slotMax": 64, "reserveGiB": 0, "perRunnerGiB": 1, "perRunnerCores": 1}})
        worker.cycle()
        # 4 cores and 16 GiB would allow 4 or more, bounded by the 8 units in the image: 4 here.
        self.assertEqual(self.read("slot-count"), "4\n")
        self.api.values = {"capacity": {"slotMax": 1}}
        worker.cycle()
        self.assertEqual(self.read("slot-count"), "1\n")

    def test_high_mem_threshold_changes_the_runner_label(self):
        worker = self.approved({"capacity": {"highMemGiB": 8}})
        worker.cycle()
        self.assertEqual(self.read("runner-labels").split(), ["x64", "gpu", "high-mem"])

    def test_invalid_and_unknown_keys_are_dropped_and_reserved_labels_ignored(self):
        values = {
            "runners": {"extraLabels": ["ci"], "repositories": ["not a repo"]},
            "sync": {"paused": "yes"},
            "disk": {"alertPercent": 5},
            "bogus": {"x": 1},
            "capacity": {"slotMax": True},
        }
        worker = self.approved(values)
        worker.cycle()
        self.assertEqual(json.loads(self.node.applied.read_text()), {})
        self.assertEqual(self.read("runner-labels").split(), ["x64", "gpu"])
        self.assertEqual(self.read("slot-count"), "2\n")
        cached = json.loads((self.node.state / "config.json").read_text())
        self.assertEqual(cached["revision"], revision_of(values))
        self.assertEqual(cached["values"], {})

    def test_a_malformed_config_block_is_ignored(self):
        worker = self.approved({})
        worker.cycle()
        self.api.script = [(200, {"ok": True, "status": "approved", "config": {"revision": "not hex!", "values": []}})]
        ok, _ = worker.cycle()
        self.assertTrue(ok)
        self.assertTrue(any("invalid shape" in line for line in self.logs))

    def test_heartbeat_interval_from_registration_is_used_until_config_says_otherwise(self):
        self.api.interval = 120
        worker = self.make()
        ok, delay = worker.cycle()
        self.assertEqual(delay, 120)

    def test_busy_slots_are_not_restarted_for_new_labels_and_idle_ones_are(self):
        worker = self.approved({})
        worker.cycle()
        self.run_stub.active = {f"github-runner-slot-{n}.service" for n in range(1, 9)}
        self.node.busy(1)
        self.api.values = {"runners": {"extraLabels": ["fast"]}}
        worker.cycle()
        restarts = [call[-1] for call in self.run_stub.matching("try-restart")]
        self.assertEqual(restarts, ["github-runner-slot-2.service"])
        for call in self.run_stub.matching("try-restart"):
            self.assertIn("--no-block", call)

    def test_an_assignment_change_restarts_only_the_slots_that_changed(self):
        worker = self.approved({"runners": {"repositories": ["o/a", "o/b"]}})
        worker.cycle()
        self.run_stub.active = {f"github-runner-slot-{n}.service" for n in range(1, 9)}
        self.api.values = {"runners": {"repositories": ["o/a", "o/c"]}}
        worker.cycle()
        restarts = sorted(call[-1] for call in self.run_stub.matching("try-restart"))
        self.assertEqual(restarts, ["github-runner-slot-2.service"])

    def test_cordon_drains_without_waiting_and_resume_undoes_it(self):
        worker = self.approved({"runners": {"cordoned": True}})
        worker.cycle()
        launches = self.run_stub.matching("systemd-run")
        self.assertEqual(len(launches), 1)
        self.assertEqual(launches[0], ["systemd-run", "--no-block", "--collect", "--unit=fleet-config-drain",
                                       "--setenv=FLEET_DRAIN_REASON=config", "--", "/test/fleet-drain"])
        self.assertTrue((self.node.run / "agent-drained").exists())
        (self.node.run / "draining").write_text("")
        worker.cycle()
        self.assertEqual(len(self.run_stub.matching("systemd-run")), 1)
        self.api.values = {"runners": {"cordoned": False}}
        worker.cycle()
        self.assertEqual(self.run_stub.matching("systemd-run")[-1][-1], "/test/fleet-resume")
        self.assertTrue((self.node.run / "agent-drained").exists())
        # A successful launch can still fail later. Retain the recovery intent
        # until a later heartbeat observes the gate actually gone.
        (self.node.run / "draining").unlink()
        worker.cycle()
        self.assertFalse((self.node.run / "agent-drained").exists())

    def test_disabled_runners_drain_too_and_a_drain_held_by_another_reason_is_left_alone(self):
        worker = self.approved({"runners": {"enabled": False}})
        worker.cycle()
        self.assertEqual(len(self.run_stub.matching("systemd-run")), 1)
        other = self.make()
        (self.node.run / "agent-drained").unlink()
        (self.node.run / "draining").write_text("")
        for reason in ("update", "low-disk", "manual"):
            (self.node.run / "drain-reasons").mkdir(exist_ok=True)
            (self.node.run / "drain-reasons" / reason).write_text("2026-10-26T00:00:00Z\n")
            other.settings = {}
            other.reconcile()
            self.assertEqual(len(self.run_stub.matching("systemd-run")), 1, reason)
            (self.node.run / "drain-reasons" / reason).unlink()
        (self.node.run / "update-draining").write_text("")
        other.reconcile()
        self.assertEqual(len(self.run_stub.matching("systemd-run")), 1, "an update in progress holds admission")

    def test_a_gate_nobody_holds_is_reopened_and_reported(self):
        # A cordon lifted while its drain was still starting left the gate closed
        # with no owner: the node silently served nothing until it rebooted.
        worker = self.approved({})
        (self.node.run / "draining").write_text("")
        worker.reconcile()
        self.assertEqual(self.run_stub.matching("systemd-run")[-1][-1], "/test/fleet-resume")
        import recovery
        events = recovery.pending(worker.recovery_base)
        self.assertEqual([event["kind"] for event in events], ["gate-reopened"])

    def test_a_manual_drain_is_lifted_only_by_reopen_after_from_fleet(self):
        worker = self.approved({})
        (self.node.run / "draining").write_text("")
        (self.node.run / "drain-reasons").mkdir()
        manual = self.node.run / "drain-reasons" / "manual"
        manual.write_text("2026-10-26T00:00:00Z\n")
        os.utime(manual, (1000, 1000))
        worker.reconcile()
        self.assertEqual(self.run_stub.matching("systemd-run"), [])
        worker.settings = {"runners": {"reopenAfter": 2000}}
        worker.apply_drain({"runners.reopenAfter": 2000}, {})
        self.assertFalse(manual.exists())
        self.assertEqual(self.run_stub.matching("systemd-run")[-1][-1], "/test/fleet-resume")

    def test_an_unfinished_drain_is_retried_no_faster_than_every_fifteen_minutes(self):
        worker = self.approved({"runners": {"cordoned": True}})
        worker.cycle()
        (self.node.run / "draining").write_text("")
        self.run_stub.active = {"github-runner-slot-1.service"}
        worker.cycle()
        self.assertEqual(len(self.run_stub.matching("systemd-run")), 1)
        self.clock.now += agent.DRAIN_RETRY_SECONDS + 1
        worker.cycle()
        self.assertEqual(len(self.run_stub.matching("systemd-run")), 2)

    def test_a_pending_capacity_reconcile_is_retried_every_report(self):
        worker = self.approved({})
        worker.cycle()
        before = len(self.run_stub.matching("fleet-capacity.service"))
        (self.node.run / "capacity-pending").write_text("slot-4\n")
        worker.cycle()
        self.assertEqual(len(self.run_stub.matching("fleet-capacity.service")), before + 1)

    def test_a_failing_step_is_reported_and_does_not_stop_the_rest(self):
        worker = self.approved({"runners": {"extraLabels": ["fast"]}})
        worker.step("write applied config", lambda: 1 / 0)
        self.assertEqual(worker.problems, ["write applied config failed: ZeroDivisionError"])
        worker.cycle()
        self.assertEqual(self.read("runner-labels").split(), ["x64", "gpu", "fast"])
        self.assertEqual(self.heartbeats()[0]["events"][-1]["kind"], "config")

    def test_a_devbox_node_applies_only_the_settings_that_apply_to_it(self):
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        self.node = Node(self.tmp.name, "devbox")
        self.api.role_tokens["devbox"] = ROLE_TOKEN
        self.api.values = {"runners": {"cordoned": True, "repositories": ["o/a"]}, "sync": {"paused": True}}
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        self.assertFalse(self.run_stub.matching("systemd-run"))
        self.assertFalse((self.node.run / "assign").exists())
        self.assertFalse((self.node.run / "slot-count").exists())
        self.assertEqual(json.loads(self.node.applied.read_text())["sync"], {"paused": True})


class OfflineTests(AgentCase):
    def closed_url(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        return f"http://127.0.0.1:{port}"

    def test_an_unreachable_api_keeps_the_cached_config_in_force(self):
        self.node.state.mkdir(parents=True)
        values = {"runners": {"extraLabels": ["fast"], "repositories": ["o/a"]}, "sync": {"paused": True}, "capacity": {"slotMax": 1}}
        (self.node.state / "config.json").write_text(json.dumps({"revision": revision_of(values), "values": values}))
        worker = self.make(url=self.closed_url())
        ok, delay = worker.cycle()
        self.assertFalse(ok)
        self.assertEqual(delay, 60)
        self.assertEqual((self.node.run / "runner-labels").read_text().split(), ["x64", "gpu", "fast"])
        self.assertEqual((self.node.run / "slot-count").read_text(), "1\n")
        self.assertEqual((self.node.run / "assign/slot-1").read_text(), "o/a\n")
        self.assertEqual(fleetconf.get("sync.paused", "false", str(self.node.applied)), "true")
        self.assertTrue(any("unreachable" in line for line in self.logs))
        # It also reports the cached revision once the server is back.
        recovered = self.make()
        recovered.cycle()
        self.assertEqual(self.heartbeats()[0]["agent"]["configRevision"], revision_of(values))
        self.assertTrue(self.heartbeats()[0]["sync"]["paused"])

    def test_failures_back_off_exponentially_up_to_a_cap_and_reset_on_success(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        self.api.script = [(500, {"error": "internal"})] * 8
        delays = [worker.cycle()[1] for _ in range(8)]
        self.assertEqual(delays, [60, 120, 240, 480, 900, 900, 900, 900])
        ok, delay = worker.cycle()
        self.assertTrue(ok)
        self.assertEqual(delay, 60)
        self.assertEqual(worker.failures, 0)

    def test_bad_responses_never_crash_the_loop(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        for answer in (
            (200, b"<html>not json</html>"),
            (200, b"[1, 2, 3]"),
            (200, b""),
            (302, {"error": "redirect"}),
            (429, {"error": "rate_limited"}),
            (400, {"error": "invalid_request", "message": "x"}),
            (200, {"ok": True, "status": "approved", "config": "not a dict"}),
        ):
            self.api.script = [answer]
            ok, delay = worker.cycle()
            self.assertGreater(delay, 0)
        ok, _ = worker.cycle()
        self.assertTrue(ok)

    def test_run_loop_sleeps_between_reports_and_survives_failures(self):
        worker = self.make(url=self.closed_url())
        worker.run_forever(max_cycles=3)
        self.assertEqual(self.sleeps, [60, 120])

    def test_an_unexpected_exception_is_contained(self):
        worker = self.make()
        worker.identity = lambda: 1 / 0
        ok, delay = worker.cycle()
        self.assertFalse(ok)
        self.assertGreater(delay, 0)

    def test_corrupt_state_files_are_ignored(self):
        self.node.state.mkdir(parents=True)
        (self.node.state / "config.json").write_text("{not json")
        (self.node.state / "reported.json").write_text("[1,2")
        (self.node.state / "status.json").write_text("\x00\x01")
        (self.node.state / "node.secret").write_bytes(b"\xff\xfe\x00")
        worker = self.make(role_token=ROLE_TOKEN)
        ok, _ = worker.cycle()
        self.assertTrue(ok, self.logs)
        self.assertEqual(json.loads((self.node.state / "config.json").read_text())["revision"], revision_of({}))
        self.assertIn("boot", [event["kind"] for event in self.heartbeats()[0]["events"]])

    def test_a_missing_node_file_waits_instead_of_crashing(self):
        (self.node.run / "node").unlink()
        ok, delay = self.make().cycle()
        self.assertFalse(ok)
        self.assertEqual(delay, 30)
        self.assertEqual(self.api.requests, [])


class RetireTests(AgentCase):
    def test_retire_tells_the_api_with_the_node_credential(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        self.assertEqual(self.make().retire(), 0)
        retire, = self.api.of("/v1/retire")
        self.assertEqual(retire["headers"]["Authorization"], f"Bearer {MACHINE_ID}.{self.secret()}")
        self.assertEqual(self.api.nodes[MACHINE_ID]["approval"], "retired")

    def test_retire_is_quiet_and_fast_when_there_is_nothing_to_tell(self):
        self.assertEqual(self.make().retire(), 0)
        self.assertEqual(self.api.requests, [])
        self.assertFalse(self.node.state.exists())

    def test_retire_gives_up_without_raising_when_the_api_is_down(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        down = self.make(url=f"http://127.0.0.1:{port}")
        self.assertEqual(down.retire(), 1)


class SecretTests(AgentCase):
    def test_neither_the_secret_nor_the_role_token_is_logged_stored_elsewhere_or_printed(self):
        worker = self.make(role_token=ROLE_TOKEN)
        worker.cycle()
        secret = self.secret()
        self.api.values = {"runners": {"extraLabels": ["fast"]}}
        worker.cycle()
        self.api.script = [(500, {"error": "boom", "message": f"Bearer {MACHINE_ID}.{secret} {ROLE_TOKEN}"})]
        worker.cycle()
        worker.problems.append(f"leak {secret} and {ROLE_TOKEN}")
        worker.cycle()
        worker.retire()
        lines = "\n".join(worker.status_lines())
        everything = "\n".join(self.logs) + lines
        for path in self.node.root.rglob("*"):
            if path.is_file() and path.name not in ("node.secret", "role-token"):
                everything += path.read_text(errors="replace")
        everything += "".join(json.dumps(event) for body in self.heartbeats() for event in body["events"])
        self.assertNotIn(secret, everything)
        self.assertNotIn(ROLE_TOKEN, everything)
        self.assertTrue(self.logs)

    def test_redact_removes_tokens_in_common_shapes(self):
        secret = "ab" * 32
        for text in (
            f"Authorization: Bearer {MACHINE_ID}.{secret}",
            f"secret={secret}",
            '{"roleToken": "abcdef.ghijkl"}',
            "token: hvs.CAESIJlU",
            "AGE-SECRET-KEY-1QQQQQQQQQQQQ",
        ):
            cleaned = agent.redact(text)
            self.assertNotIn(secret, cleaned)
            self.assertNotIn("hvs.CAESIJlU", cleaned)
            self.assertNotIn("abcdef.ghijkl", cleaned)
            self.assertNotIn("1QQQQQ", cleaned)
        self.assertEqual(agent.redact("plain message"), "plain message")
        self.assertEqual(agent.redact("my-odd-token here", ["my-odd-token"]), "[redacted] here")


class CommandLineTests(AgentCase):
    def run_cli(self, command, url=None, extra=None):
        env = {key: value for key, value in os.environ.items() if not key.startswith("FLEET_")}
        env.update(self.node.env(self.api.url if url is None else url))
        env.update(extra or {})
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPTS / "agent.py"), command],
            capture_output=True, text=True, env=env, check=False, timeout=60,
        )

    def test_once_reports_over_real_http_and_status_never_prints_secrets(self):
        self.node.state.mkdir(parents=True)
        (self.node.state / "role-token").write_text(ROLE_TOKEN + "\n")
        done = self.run_cli("once")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("registration: approved", done.stdout)
        self.assertEqual(len(self.heartbeats()), 1)
        again = self.run_cli("status")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("role token: present", again.stdout)
        for text in (done.stdout + done.stderr, again.stdout + again.stderr):
            self.assertNotIn(self.secret(), text)
            self.assertNotIn(ROLE_TOKEN, text)
        self.assertEqual(self.run_cli("retire").returncode, 0)
        self.assertEqual(self.api.nodes[MACHINE_ID]["approval"], "retired")

    def test_once_exits_nonzero_when_the_api_is_unreachable(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        done = self.run_cli("once", url=f"http://127.0.0.1:{port}")
        self.assertEqual(done.returncode, 1)

    def test_an_empty_or_todo_url_disables_the_agent_quietly(self):
        for url in ("", "   ", "https://TODO.example"):
            for command in ("run", "once", "status", "retire"):
                with self.subTest(url=url, command=command):
                    done = self.run_cli(command, url=url)
                    self.assertEqual(done.returncode, 0)
                    self.assertEqual(done.stdout + done.stderr, "")
        self.assertFalse(self.node.state.exists())
        self.assertEqual(self.api.requests, [])

    def test_a_plain_http_url_to_another_host_is_refused(self):
        done = self.run_cli("once", url="http://fleet.example.test")
        self.assertEqual(done.returncode, 0)
        self.assertIn("must be https", done.stderr)
        self.assertFalse(self.node.state.exists())
        for url in ("https://user:pw@fleet.example.test", "https://fleet.example.test/?x=1"):
            with self.assertRaises(ValueError):
                agent.api_base(url)
        self.assertEqual(agent.api_base("https://fleet.example.test/"), "https://fleet.example.test")

    def test_usage_error(self):
        self.assertEqual(self.run_cli("bogus").returncode, 2)


class FleetconfTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, value):
        self.path.write_text(value if isinstance(value, str) else json.dumps(value))

    def cli(self, *args, path=None):
        env = {**os.environ, "FLEET_CONFIG": str(path or self.path)}
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPTS / "fleetconf.py"), *args],
            capture_output=True, text=True, env=env, check=False, timeout=30,
        )

    def test_values_are_printed_in_shell_friendly_form(self):
        self.write({"sync": {"paused": True}, "reboot": {"delayMaxSeconds": 0, "enabled": False},
                    "runners": {"extraLabels": ["a", "b"]}, "disk": {"alertPercent": 85}})
        self.assertEqual(self.cli("get", "sync.paused", "false").stdout, "true\n")
        self.assertEqual(self.cli("get", "reboot.enabled", "true").stdout, "false\n")
        self.assertEqual(self.cli("get", "reboot.delayMaxSeconds", "7200").stdout, "0\n")
        self.assertEqual(self.cli("get", "disk.alertPercent", "90").stdout, "85\n")
        self.assertEqual(self.cli("get", "runners.extraLabels").stdout, "a\nb\n")

    def test_a_missing_or_corrupt_file_gives_the_default_and_exit_zero(self):
        for content in (None, "", "{", "[]", "null", '"text"', "\x00\x01"):
            if content is None:
                self.path.unlink(missing_ok=True)
            else:
                self.write(content)
            with self.subTest(content=content):
                done = self.cli("get", "sync.paused", "false")
                self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "false\n", ""))
                self.assertEqual(self.cli("dump").stdout, "{}\n")

    def test_wrong_types_and_out_of_range_values_give_the_default(self):
        self.write({"sync": {"paused": "true"}, "reboot": {"delayMaxSeconds": -5, "enabled": 1},
                    "disk": {"alertPercent": 100}, "heartbeat": {"intervalSeconds": 1.5},
                    "capacity": {"slotMax": True}, "runners": {"extraLabels": ["ci"], "repositories": ["bad"]}})
        for key, default in (("sync.paused", "false"), ("reboot.delayMaxSeconds", "7200"), ("reboot.enabled", "true"),
                             ("disk.alertPercent", "90"), ("heartbeat.intervalSeconds", "60"), ("capacity.slotMax", "8")):
            with self.subTest(key=key):
                self.assertEqual(self.cli("get", key, default).stdout, default + "\n")
        self.assertEqual(self.cli("dump").stdout, "{}\n")

    def test_repository_names_cannot_climb_out_of_the_api_path(self):
        self.write({"runners": {"repositories": ["../etc", "o/..", "o/ok"]}})
        self.assertEqual(self.cli("dump").stdout, "{}\n")
        self.write({"runners": {"repositories": ["o/ok", "o/also.ok"]}})
        self.assertEqual(self.cli("get", "runners.repositories").stdout, "o/ok\no/also.ok\n")

    def test_unknown_keys_and_the_server_only_section_are_ignored(self):
        self.write({"alerts": {"offlineAfterSeconds": 300}, "sync": {"paused": True, "bogus": 1}, "other": {"x": 1}})
        self.assertEqual(json.loads(self.cli("dump").stdout), {"sync": {"paused": True}})

    def test_usage_error_is_exit_two(self):
        self.assertEqual(self.cli("nope").returncode, 2)

    def test_sanitize_matches_the_server_schema_keys(self):
        schema = (Path(__file__).parents[2] / "fleet-api/src/config/fields.ts")
        if not schema.is_file():
            self.skipTest("fleet-api schema is not present")
        text = schema.read_text()
        block = text[text.index("export const RULES"):text.index("export const SECTIONS")]
        found = set()
        section = None
        depth = 0
        for line in block.splitlines():
            stripped = line.strip()
            opens = re.match(r"^(\w+): \{", stripped)
            if depth == 1 and opens:
                section = opens.group(1)
                found.update(f"{section}.{key}" for key in re.findall(r"(\w+): \{ kind:", stripped))
            elif depth == 2 and opens and section:
                found.add(f"{section}.{opens.group(1)}")
            depth += line.count("{") - line.count("}")
        node_keys = {key for key in found if not key.startswith("alerts.")}
        self.assertEqual(node_keys, set(fleetconf.SPEC))


if __name__ == "__main__":
    unittest.main()
