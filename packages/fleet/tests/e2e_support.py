"""Building blocks for the full-chain test: the real fleet API started by
packages/fleet-api/test/e2e/stack.ts, a Vault that speaks the parts of the
real API the fleet uses (OIDC login, wrapped reads, lookup, unwrap, userpass),
and fixtures for a node's /proc, /run/fleet and /etc/fleet."""
import hashlib
import json
import os
import secrets
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
API_PACKAGE = ROOT.parent / "fleet-api"
STACK = API_PACKAGE / "test" / "e2e" / "stack.ts"

AGE_KEY = "AGE-SECRET-KEY-1CHAINTESTNOTREALKEYMATERIAL000000000000000000000"


def missing_tools():
    """Names of what the full-chain test needs and cannot find."""
    needed = {"bun": "bun", "atlas": "atlas", "curl": "curl", "python3": "python3"}
    absent = [name for name, tool in needed.items() if shutil.which(tool) is None]
    candidates = [shutil.which("initdb")]
    for pattern in ("/usr/lib/postgresql/*/bin/initdb", "/opt/homebrew/opt/postgresql@*/bin/initdb"):
        candidates.extend(str(path) for path in Path("/").glob(pattern.lstrip("/")))
    if not any(candidates):
        absent.append("postgres (initdb)")
    return absent


def free_port():
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ChainVault:
    """The slice of Vault the fleet touches: GitHub OIDC login, a wrapped read
    of secret/data/fleet/<role>, sys/wrapping lookup and unwrap, and userpass."""

    def __init__(self, role_token):
        self.password = secrets.token_urlsafe(24)
        self.documents = {"ci": {"age_key": AGE_KEY, "api_token": role_token}}
        self.wrapped = {}
        self.spent = set()
        self.calls = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def reply(self, code, payload=None):
                body = b"" if payload is None else json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def body(self):
                length = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(length) or b"{}")

            def do_GET(self):
                parsed = urlparse(self.path)
                outer.calls.append(("GET", parsed.path))
                if parsed.path == "/oidc":
                    if self.headers.get("Authorization") != "bearer request-token":
                        return self.reply(401, {})
                    return self.reply(200, {"value": "github-oidc-jwt"})
                if parsed.path.startswith("/v1/secret/data/fleet/"):
                    return self.read_secret(parsed.path.rsplit("/", 1)[1])
                self.reply(404, {})

            def read_secret(self, role):
                if self.headers.get("X-Vault-Token") != "workflow-client-token":
                    return self.reply(403, {})
                if role not in outer.documents:
                    return self.reply(404, {"errors": []})
                if not self.headers.get("X-Vault-Wrap-TTL"):
                    # The real policy refuses an unwrapped read. Fail loudly here too.
                    return self.reply(403, {"errors": ["wrapping required"]})
                with outer.lock:
                    token = f"hvs.wrapped-{role}-{len(outer.wrapped) + 1:04d}"
                    outer.wrapped[token] = (role, outer.documents[role])
                self.reply(200, {"wrap_info": {"token": token, "ttl": 3600, "creation_path": f"secret/data/fleet/{role}"}})

            def do_POST(self):
                path = urlparse(self.path).path
                outer.calls.append(("POST", path))
                data = self.body()
                if path == "/v1/auth/jwt/login":
                    ok = data.get("role") == "fleet-enroll" and data.get("jwt") == "github-oidc-jwt"
                    return self.reply(200, {"auth": {"client_token": "workflow-client-token"}}) if ok else self.reply(403, {})
                if path == "/v1/sys/wrapping/lookup":
                    entry = outer.wrapped.get(data.get("token"))
                    if entry is None or data["token"] in outer.spent:
                        return self.reply(400, {"errors": ["wrapping token is not valid or does not exist"]})
                    return self.reply(200, {"data": {"creation_path": f"secret/data/fleet/{entry[0]}", "creation_ttl": 3600}})
                if path == "/v1/sys/wrapping/unwrap":
                    return self.unwrap(self.headers.get("X-Vault-Token") or data.get("token"))
                if path.startswith("/v1/auth/userpass/login/"):
                    ok = data.get("password") == outer.password
                    policies = ["admin", "default"] if path.endswith("/crvouga") else ["default"]
                    return self.reply(200, {"auth": {"client_token": "user-token", "policies": policies}}) if ok else self.reply(400, {})
                if path == "/v1/auth/token/revoke-self":
                    return self.reply(204)
                self.reply(404, {})

            def unwrap(self, token):
                with outer.lock:
                    entry = outer.wrapped.get(token)
                    if entry is None or token in outer.spent:
                        return self.reply(400, {"errors": ["wrapping token is not valid or does not exist"]})
                    outer.spent.add(token)
                self.reply(200, {"data": {"data": entry[1], "metadata": {"version": 1}}})

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.http.server_address[1]}"

    def close(self):
        self.http.shutdown()
        self.http.server_close()


class Stack:
    """The real fleet API in its own process, with its own throwaway Postgres."""

    def __init__(self, role_token, vault_addr, image=None):
        env = dict(os.environ)
        env.update({"FLEET_E2E_ROLE_TOKEN": role_token, "VAULT_ADDR": vault_addr})
        if image:
            env["FLEET_E2E_IMAGE"] = image
        self.process = subprocess.Popen(
            ["bun", str(STACK)],
            cwd=API_PACKAGE,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.output = []
        self.info = self._wait_for_ready()

    def _wait_for_ready(self):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.process.stdout], [], [], 1)
            if ready:
                line = self.process.stdout.readline()
                if not line:
                    break
                self.output.append(line)
                if line.startswith('{"apiUrl"'):
                    threading.Thread(target=self._drain, daemon=True).start()
                    return json.loads(line)
            elif self.process.poll() is not None:
                break
        self.stop()
        raise RuntimeError("the fleet API stack did not start:\n" + "".join(self.output)[-3000:])

    def _drain(self):
        for line in self.process.stdout:
            self.output.append(line)

    def stop(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.send_signal(signal.SIGTERM)
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.process.kill()
        return self.process.returncode


def sha256_hex(text):
    return hashlib.sha256(text.encode()).hexdigest()


class NodeFiles:
    """A node's view of the world, as plain files the agent reads through its path seams."""

    def __init__(self, root, hostname, role, machine_id, slots=None):
        self.root = Path(root)
        self.hostname = hostname
        self.role = role
        self.machine_id = machine_id
        for sub in ("proc/sys/kernel/random", "run/fleet", "etc/fleet", "sys", "nix", "boot", "bin"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        (self.root / "proc/uptime").write_text("86400.50 1000.00\n")
        (self.root / "proc/loadavg").write_text("0.42 0.40 0.39 1/200 1234\n")
        (self.root / "proc/meminfo").write_text("MemTotal: 33554432 kB\nMemAvailable: 25165824 kB\n")
        (self.root / "proc/cpuinfo").write_text("processor : 0\nmodel name : Test CPU 9000\nprocessor : 1\nmodel name : Test CPU 9000\n")
        (self.root / "proc/sys/kernel/random/boot_id").write_text("5b0f0000-0000-4000-8000-000000000001\n")
        (self.root / "etc/fleet/revision").write_text("9f3c2a1e00000000000000000000000000000000\n")
        (self.root / "etc/fleet/node.conf").write_text(
            f"role={role}\nflake_attr={role}\nreserve_gib=4\nper_runner_gib=6\nper_runner_cores=2\nslot_max=8\nhigh_mem_gib=60\n"
        )
        self.write_identity(slots)
        self.systemctl_log = self.root / "systemctl.log"
        for name in ("systemctl", "systemd-run", "fleet-drain", "fleet-resume"):
            script = self.root / "bin" / name
            script.write_text(f'#!/bin/sh\nprintf \'{name} %s\\n\' "$*" >> "{self.systemctl_log}"\n')
            script.chmod(0o755)

    def write_identity(self, slots):
        node = (
            f"hostname={self.hostname}\nrole={self.role}\nid={self.machine_id[:4]}\nmachine_id={self.machine_id}\n"
            "capabilities=\narch=x86_64\n"
        )
        (self.root / "run/fleet/node").write_text(node)
        if slots is not None:
            (self.root / "run/fleet/slot-count").write_text(f"{slots}\n")

    @property
    def state(self):
        return self.root / "nix/fleet-state/agent"

    def env(self, api_url):
        bin_dir = self.root / "bin"
        return {
            **os.environ,
            "FLEET_API_URL": api_url,
            "FLEET_AGENT_STATE": str(self.state),
            "FLEET_RUN": str(self.root / "run/fleet"),
            "FLEET_ETC": str(self.root / "etc/fleet"),
            "FLEET_PROC": str(self.root / "proc"),
            "FLEET_SYS": str(self.root / "sys"),
            "FLEET_NIX_MOUNT": str(self.root / "nix"),
            "FLEET_BOOT_MOUNT": str(self.root / "boot"),
            "FLEET_SYSTEMCTL": str(bin_dir / "systemctl"),
            "FLEET_SYSTEMD_RUN": str(bin_dir / "systemd-run"),
            "FLEET_DRAIN": str(bin_dir / "fleet-drain"),
            "FLEET_RESUME": str(bin_dir / "fleet-resume"),
        }

    def agent(self, api_url, command, timeout=90):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "agent.py"), command],
            env=self.env(api_url),
            capture_output=True,
            text=True,
            timeout=timeout,
        )


def query(url):
    return parse_qs(urlparse(url).query)
