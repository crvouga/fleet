"""Building blocks for the full-chain test: the real fleet controller started by
packages/fleet-controller/test/e2e/stack.ts and fixtures for a node's /proc,
/run/fleet and /etc/fleet."""
import hashlib
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
CONTROLLER_PACKAGE = ROOT.parent / "fleet-controller"
STACK = CONTROLLER_PACKAGE / "test" / "e2e" / "stack.ts"

def missing_tools():
    """Names of what the full-chain test needs and cannot find."""
    needed = {"bun": "bun", "curl": "curl", "python3": "python3"}
    absent = [name for name, tool in needed.items() if shutil.which(tool) is None]
    return absent


def free_port():
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Stack:
    """The real fleet controller in its own process, with its own throwaway SQLite database."""

    def __init__(self, enrollment_token):
        env = dict(os.environ)
        env.update({"FLEET_E2E_ENROLLMENT_TOKEN": enrollment_token})
        self.process = subprocess.Popen(
            ["bun", str(STACK)],
            cwd=CONTROLLER_PACKAGE,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.output = []
        self.info = self._wait_for_ready()

    def _wait_for_ready(self):
        # TextIOWrapper may read ahead several lines from one pipe write. A
        # subsequent select() sees an empty OS pipe even though readline() has
        # buffered readiness. One reader thread owns the stream throughout.
        lines = queue.Queue()
        threading.Thread(target=self._drain, args=(lines,), daemon=True).start()
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                line = lines.get(timeout=1)
            except queue.Empty:
                continue
            if line is None:
                break
            if line.startswith('{"controllerUrl"'):
                return json.loads(line)
        self.stop()
        raise RuntimeError("the fleet controller stack did not start:\n" + "".join(self.output)[-3000:])

    def _drain(self, lines):
        try:
            for line in self.process.stdout:
                self.output.append(line)
                lines.put(line)
        finally:
            lines.put(None)

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
