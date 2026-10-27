"""Exercise the installed CLI inside NixOS; all disks/firmware/boot are stand-ins.

Called by the NixOS native VM (tests/native.nix), where nix-ld is disabled. No real disk is opened.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import iso_fixture


def verify(boot, control):
    with tempfile.TemporaryDirectory(prefix="fleet-native-reinstall-") as directory:
        root = Path(directory)
        state = root / "state"
        state.mkdir()
        busy = root / "busy/slot-1"
        busy.mkdir(parents=True)
        iso = root / "fixture.iso"
        iso.write_bytes(iso_fixture.build(iso_fixture.installer_tree()))
        Path(str(iso) + ".sha256").write_text(hashlib.sha256(iso.read_bytes()).hexdigest() + "  fixture.iso\n")
        (root / "disks.json").write_text(json.dumps([{
            "path": "/dev/nvme0n1", "tran": "nvme", "rm": False, "hotplug": False,
            "usb": False, "internal": True, "mounted": True, "whole": True,
            "size": 500_000_000_000, "model": "VM stand-in", "serial": "VM-ONLY",
        }]))
        (state / "installed").write_text("role=ci\nstatus=installed\n")
        (root / "node.conf").write_text("role=ci\n")
        (root / "runner.conf").write_text("scope=repository\napp_id=123\ninstallation_id=456\ntarget=example/private\n")
        (root / "credential").write_text("vm-only-not-a-key")
        actions = root / "actions"
        env = {**os.environ, "FLEET_STATE": str(state), "FLEET_DISKS_FILE": str(root / "disks.json"),
               "FLEET_NODE_CONF": str(root / "node.conf"), "FLEET_RUNNER_CONF": str(root / "runner.conf"),
               "FLEET_CREDENTIAL": str(root / "credential"), "FLEET_BUSY_DIR": str(busy.parent),
               "FLEET_HOSTNAME": "ci-test", "FLEET_KEXEC": boot, "FLEET_RUNNER_CONTROL": control,
               "FLEET_EFI_DIR": str(root), "FLEET_ISO_FS": "ext4", "FLEET_NO_ENROLL": "1",
               "FLEET_ENROLL_TOKEN": "", "FLEET_ENROLL_TOKEN_FILE": "",
               "FLEET_INSTALLER_URL": iso.as_uri(), "FLEET_INSTALLER_SHA256_URL": iso.as_uri() + ".sha256",
               "FLEET_TEST_ACTIONS": str(actions)}

        def invoke(flags, expected):
            result = subprocess.run(["fleet-node", "ci", *flags], env=env, capture_output=True, text=True, timeout=30)
            if result.returncode != expected:
                raise RuntimeError(result.stdout + result.stderr)
            return result.stdout + result.stderr

        if "already installed as ci" not in invoke(["--yes"], 0):
            raise RuntimeError("normal invocation did not preserve the existing node")
        invoke(["--reinstall", "--plan"], 0)
        if actions.exists():
            raise RuntimeError("normal invocation or preview performed a boot operation")
        (busy / "busy").write_text("running\n")
        invoke(["--reinstall", "--yes"], 2)
        if actions.exists():
            raise RuntimeError("a busy node was withdrawn or rebooted")
        (busy / "busy").unlink()
        invoke(["--reinstall", "--yes"], 0)
        lines = actions.read_text().splitlines()
        if not (len(lines) == 3 and lines[0].startswith("runner withdraw ")
                and lines[1].startswith("boot --load ") and "fleet.role=ci" in lines[1]
                and lines[2] == "boot -e"):
            raise RuntimeError("withdraw, verified kernel load and boot did not occur in order")
        if (busy.parent / "draining").read_text() != "reinstall\n":
            raise RuntimeError("new job admission was not closed")
        print("NATIVE REINSTALL OK: normal no-op, preview, busy refusal, explicit same-role handoff")


if __name__ == "__main__":
    verify(*sys.argv[1:])
