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

    def __init__(self, enrollment_token, extra_env=None):
        """`extra_env` reaches only the controller process (for example a loopback
        GitHub API URL and a throwaway App key), never the test's own environment."""
        env = dict(os.environ)
        env.update({"FLEET_E2E_ENROLLMENT_TOKEN": enrollment_token, **(extra_env or {})})
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


# ---- runner_control.py as a node runs it ------------------------------------------

_WRAPPER = '''\
import json, os, runpy, sys, time, urllib.request

sleeps = []
if os.environ.get("E2E_RECORD_SLEEP") == "1":
    time.sleep = lambda seconds: sleeps.append(seconds)
redirect = os.environ.get("E2E_GITHUB_REDIRECT")
if redirect:
    real = urllib.request.urlopen
    def urlopen(request, *args, **kwargs):
        if request.full_url.startswith("https://api.github.com"):
            request.full_url = redirect + request.full_url[len("https://api.github.com"):]
        return real(request, *args, **kwargs)
    urllib.request.urlopen = urlopen
code = 0
try:
    runpy.run_path(os.environ["E2E_SCRIPT"], run_name="__main__")
except SystemExit as stop:
    code = stop.code
finally:
    with open(os.environ["E2E_SLEEP_LOG"], "w") as log:
        json.dump(sleeps, log)
sys.exit(code)
'''

# A node's Python has PyJWT; the machine running the tests may not. This stand-in signs
# RS256 with `openssl` so the legacy direct-GitHub path still makes a genuine JWT.
_JWT_SHIM = '''\
import base64, json, subprocess, tempfile, os

def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def encode(claims, key, algorithm="RS256"):
    assert algorithm == "RS256"
    head = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps(claims).encode())
    with tempfile.TemporaryDirectory() as work:
        private = os.path.join(work, "key.pem")
        with open(private, "w") as stream:
            stream.write(key)
        os.chmod(private, 0o600)
        signature = subprocess.run(["openssl", "dgst", "-sha256", "-sign", private], input=(head + "." + body).encode(),
                                   capture_output=True, check=True).stdout
    return head + "." + body + "." + _b64(signature)
'''


def runner_tools(directory):
    """Writes the wrapper (and a PyJWT stand-in when the real one is missing) outside the
    script directory. Returns (wrapper_path, extra PYTHONPATH entries)."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    wrapper = directory / "run_runner_control.py"
    wrapper.write_text(_WRAPPER)
    try:
        __import__("jwt")
        return wrapper, []
    except ImportError:
        shim = directory / "shim"
        shim.mkdir(exist_ok=True)
        (shim / "jwt.py").write_text(_JWT_SHIM)
        return wrapper, [str(shim)]


class RegisterResult:
    def __init__(self, process, output, sleeps, status_file, used_file):
        self.returncode = process.returncode
        self.stdout = process.stdout
        self.stderr = process.stderr
        self.output = Path(output)
        self.sleeps = sleeps
        self.status_file = Path(status_file)
        self.used_file = Path(used_file)

    @property
    def text(self):
        return self.stdout + self.stderr

    def recorded_status(self):
        return json.loads(self.status_file.read_text()) if self.status_file.exists() else None


def run_runner_control(node, api_url, tools, slot, target, *, label="run", key_path=None, app="", installation="",
                       record_sleep=True, github_redirect=None, env_extra=None, timeout=120):
    """`runner_control.py register repository TARGET APP INSTALL KEY OUTPUT` with the node's own
    environment (only its identity files). The wrapper records the sleeps the script asked for
    (and does not perform them when `record_sleep`), and can point the legacy direct-GitHub path
    at a loopback fake. The node's environment never contains a GitHub App key."""
    wrapper, pythonpath = tools
    work = node.root / "registration" / label
    work.mkdir(parents=True, exist_ok=True)
    output, used, status, sleep_log = work / "tokens" / slot, work / "assign-used" / slot, work / "status.json", work / "sleeps.json"
    env = node.env(api_url)
    env.update({
        "FLEET_SLOT": slot, "FLEET_ASSIGN_USED_FILE": str(used), "FLEET_REGISTER_STATUS": str(status),
        "E2E_SCRIPT": str(ROOT / "scripts" / "runner_control.py"), "E2E_SLEEP_LOG": str(sleep_log),
        "E2E_RECORD_SLEEP": "1" if record_sleep else "0",
    })
    if github_redirect:
        env["E2E_GITHUB_REDIRECT"] = github_redirect
    if pythonpath:
        env["PYTHONPATH"] = os.pathsep.join(pythonpath + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    env.update(env_extra or {})
    process = subprocess.run(
        [sys.executable, str(wrapper), "register", "repository", target, app, installation,
         str(key_path or (work / "no-such-app-key")), str(output)],
        env=env, capture_output=True, text=True, timeout=timeout,
    )
    sleeps = json.loads(sleep_log.read_text()) if sleep_log.exists() else []
    return RegisterResult(process, output, sleeps, status, used)
