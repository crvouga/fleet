"""Bounded preparation after disk consent, before partitioning or boot changes.

The planner only describes work. The privileged helper recomputes it from fresh
findings; the browser never supplies commands, package names or drive letters.
"""
import os
import shutil
import subprocess

import bootstrap  # noqa: F401
import decide


def linux_boot_commands():
    # Native Nix launchers already include kexec. Never install a second tool
    # to satisfy an explicitly overridden executable or mutate NixOS with apt.
    if decide.os_boot_tool("Linux") != "kexec" or os.path.exists("/etc/NIXOS"):
        return []
    for tool, commands in (
        ("apt-get", [["update"], ["install", "--yes", "--no-install-recommends", "kexec-tools"]]),
        ("dnf", [["install", "--assumeyes", "kexec-tools"]]),
        ("zypper", [["--non-interactive", "install", "kexec-tools"]]),
        ("pacman", [["--sync", "--needed", "--noconfirm", "kexec-tools"]]),
    ):
        path = shutil.which(tool)
        if path:
            return [[path, *args] for args in commands]
    return []


def automatic(os_name, findings):
    """Names of failed checks for which one bounded preparation is available."""
    failed = {item["name"] for item in findings if item["status"] == "fail"}
    actions = {}
    if os_name == "Linux" and "boot-tool" in failed and linux_boot_commands():
        actions["boot-tool"] = "Install the missing Linux boot tool using this system's package manager."
    if os_name == "Windows" and "shrink" in failed:
        actions["shrink"] = "Consolidate free space once, then measure again before changing partitions."
    return actions


def review_findings(os_name, findings):
    actions = automatic(os_name, findings)
    return [
        {**item, "status": "info", "detail": actions[item["name"]], "fix": "", "automatic": True}
        if item["name"] in actions else item
        for item in findings
    ]


def execute(command, timeout=1800):
    decide.invariant(not os.environ.get("FLEET_DISKS_FILE"),
                     "simulated disks must never trigger real system preparation")
    fix = "Automatic preparation stopped before partitioning. Use the installer's USB option instead."
    try:
        done = decide.run_logged(command, capture_output=True, text=True, timeout=timeout,
                                 stdin=subprocess.DEVNULL,
                                 env={**os.environ, "DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l"})
    except (OSError, subprocess.TimeoutExpired) as exc:
        decide.invariant(False, "automatic preparation could not run or timed out", fix,
                         tool=command[0], reason=str(exc))
    decide.invariant(done.returncode == 0, "automatic preparation could not finish",
                     fix, tool=command[0], code=done.returncode, error=(done.stderr or done.stdout or "")[-300:])


def run(os_name, findings, progress):
    """Run each available preparation at most once; the caller must recheck."""
    actions = automatic(os_name, findings)
    if "boot-tool" in actions:
        progress.emit("prepare", "Installing the Linux boot tool automatically")
        for command in linux_boot_commands():
            execute(command)
    if "shrink" in actions:
        facts = decide.windows_facts(fresh=True)
        progress.emit("prepare", "Consolidating Windows free space automatically; this can take several minutes")
        # /X consolidates free space without deleting files, restore points,
        # encryption protectors or the hibernation/page files.
        # https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/defrag
        execute(["defrag.exe", decide.ps_letter(facts["Letter"]) + ":", "/X"], timeout=7200)
        decide.WINDOWS["facts"] = None
    return bool(actions)
