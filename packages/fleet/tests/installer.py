#!/usr/bin/env python3
"""Run independent installer contracts concurrently on each native platform."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
# Each check takes under 2 minutes on the slowest runner. A hung one fails here,
# with its output so far, instead of silently using up the job's time limit.
CHECK_TIMEOUT = int(os.environ.get("FLEET_INSTALLER_CHECK_TIMEOUT", "300"))


def commands(version, native_nix=False):
    checks = {
        "Wizard unit tests": [sys.executable, "-B", "tests/run.py", "--pattern", "test_wizard*.py"],
        "Wizard browser contracts": ["node", "wizard/ui-e2e.cjs"],
        "Packaged installer and self-test": [sys.executable, "wizard/build.py", "--version", version],
    }
    if sys.platform == "win32":
        checks["Windows release trust contracts"] = [sys.executable, "-B", "tests/run.py", "--pattern", "test_windows_signing.py"]
    if native_nix:
        checks["Native Nix installer"] = ["nix", "build", "--no-write-lock-file", "-o", "result-native", ".#fleet-installer"]
    return checks


def stop(process):
    """Kill the check and everything it started (browsers, wizard servers)."""
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, check=False)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        process.kill()


def execute(command, directory, timeout=None):
    # The contracts inspect their temporary request files. Sharing an OS temp
    # directory would make simultaneous, otherwise isolated checks interfere.
    timeout = timeout or CHECK_TIMEOUT
    with tempfile.TemporaryDirectory(prefix="fleet-installer-check-") as temporary:
        env = {**os.environ, "TMPDIR": temporary, "TEMP": temporary, "TMP": temporary}
        group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=directory, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors="replace", **group)
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop(process)
            output, _ = process.communicate()
            output = (output or "") + f"\nTIMED OUT after {timeout}s; the check and its processes were killed.\n"
            return subprocess.CompletedProcess(command, 124, output), time.monotonic() - started
        return subprocess.CompletedProcess(command, process.returncode, output), time.monotonic() - started


def run_checks(checks, directory):
    failed = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {}
        for name, command in checks.items():
            print(f"started: {name}", flush=True)
            pending[pool.submit(execute, command, directory)] = name
        for future in as_completed(pending):
            name = pending[future]
            try:
                result, seconds = future.result()
                print(f"\n--- {name} ({seconds:.0f}s, exit {result.returncode}) ---\n{result.stdout}", flush=True)
                if result.returncode:
                    failed.append(name)
            except OSError as error:
                print(f"{name}: {error}", file=sys.stderr, flush=True)
                failed.append(name)
    if failed:
        print(f"FAILED installer checks: {', '.join(sorted(failed))}", file=sys.stderr, flush=True)
    return int(bool(failed))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--native-nix", action="store_true")
    args = parser.parse_args()
    return run_checks(commands(args.version, args.native_nix), ROOT)


if __name__ == "__main__":
    sys.exit(main())
