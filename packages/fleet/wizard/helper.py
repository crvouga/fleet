"""The privileged half. Reads one request file, re-checks everything from
scratch (it trusts nothing the web UI said), does the work, writes a result.

Request and result live in a directory made by the unprivileged server:
  request.json   what to do; renamed to request.claimed.json the moment this starts,
                 so the server can withdraw it (cancel) until then, and knows after
                 that the helper ran
  progress.jsonl one JSON object per line while it runs
  result.json    written last: {"ok": bool, "message": str, "fix": str, "log_tail": [...]}
"""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import traceback
from pathlib import Path

import bootstrap  # noqa: F401
import decide
import diagnostics
import imaging
import leases
import preparation
import fleet_wifi

ACTIONS = ("write-usb", "install-here")
REQUEST, CLAIMED, WITHDRAWN = "request.json", "request.claimed.json", "request.withdrawn.json"
LOG_TAIL = 80


class Withdrawn(Exception):
    """The wizard cancelled before this helper started. Nothing has been touched."""
TOKEN_RE = decide.ENROLL_RE


class Progress:
    def __init__(self, directory):
        self.path = Path(directory) / "progress.jsonl"
        self.failed = False
        self.step = None
        self.checks = []

    def record_checks(self, stage, findings):
        snapshot = diagnostics.check_snapshot(stage, findings)
        self.checks.append(snapshot)
        decide.log("checks " + json.dumps(snapshot))

    def emit(self, step, message="", percent=None):
        if step != "log":
            self.step = step
        row = {"step": step, "message": decide.redact(message), "percent": percent}
        try:
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(row) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            # Progress only feeds the window. Losing it must never stop disk
            # work halfway; the log keeps the full record.
            if not self.failed:
                self.failed = True
                decide.log(f"progress could not be written to {self.path}: {type(exc).__name__}: {exc}", "WARN")


def load_request(directory):
    directory = Path(directory)
    path = directory / CLAIMED
    try:
        os.replace(directory / REQUEST, path)  # atomic: either this claim or the wizard's withdrawal wins
    except FileNotFoundError:
        if (directory / WITHDRAWN).exists():
            raise Withdrawn() from None
        decide.invariant(False, "the helper was started without a request file", directory=str(directory))
    request = json.loads(path.read_text(encoding="utf-8"))
    decide.invariant(isinstance(request, dict) and request.get("action") in ACTIONS, "the request names an unknown action", action=request.get("action") if isinstance(request, dict) else request)
    return request


def verified_iso(request, progress):
    iso = Path(str(request.get("iso") or ""))
    sha = str(request.get("sha256") or "").lower()
    decide.invariant(imaging.SHA_RE.match(sha) is not None, "the request has a malformed sha256", sha=sha)
    decide.invariant(iso.is_file() and iso.stat().st_size > 0, "the installer image named in the request does not exist", iso=str(iso))
    progress.emit("verify", "Checking the installer image before using it")
    actual = imaging.sha256_of(iso)
    decide.invariant(actual == sha, "the installer image changed after it was downloaded", "Run the wizard again so it downloads the image afresh.", want=sha, got=actual)
    return iso, sha


def find_disk(os_name, request):
    path = str(request.get("path") or "")
    decide.invariant(decide.device_ok(path) or os_name == "Windows" and decide.WINDOWS_RE.match(path), "the request names an unusable device path", path=path)
    disks = decide.collect(os_name)
    matches = [disk for disk in disks if disk.get("path") == path]
    decide.invariant(len(matches) == 1, "the chosen disk is not present exactly once", "Unplug and replug the disk, then run the wizard again.", path=path, found=len(matches))
    disk = matches[0]
    decide.invariant(sum(decide.disk_id(d) == request.get("disk_id") for d in disks) == 1,
                     "more than one disk has the chosen identity", "Unplug other identical disks and review again.")
    decide.invariant(decide.disk_id(disk) == request.get("disk_id"), "the disk at that path is not the one that was chosen",
                     "Disks were plugged or unplugged since you chose. Run the wizard again.", path=path)
    return disk


def prep_commands(os_name, disk, mounted_paths=()):
    """The commands that free a USB disk so it can be written. Pure, so tests can read them."""
    path = disk["path"]
    if os_name == "Windows":
        match = re.search(r"PHYSICALDRIVE(\d+)$", path)
        decide.invariant(match is not None, "not a Windows physical drive path", path=path)
        return [("diskpart", f"select disk {int(match.group(1))}\nclean\n")]
    if os_name == "Darwin":
        return [(["diskutil", "unmountDisk", "force", path], None)]
    return [(["umount", mount], None) for mount in mounted_paths]


def raw_target(os_name, disk):
    """The file to write. FLEET_WRITE_TARGET redirects the write to a plain file,
    and is honored only together with the canned disk list, so it can never
    point at a real disk."""
    redirect = os.environ.get("FLEET_WRITE_TARGET")
    decide.invariant(not os.environ.get("FLEET_DISKS_FILE") or redirect,
                     "a canned disk list must never be used to write a real device", "Set FLEET_WRITE_TARGET to a test file.")
    if redirect:
        decide.invariant(bool(os.environ.get("FLEET_DISKS_FILE")), "FLEET_WRITE_TARGET is a test seam and needs FLEET_DISKS_FILE")
        try:
            info = os.lstat(redirect)
        except OSError:
            decide.invariant(False, "the test write target must be an existing regular file", path=redirect)
        decide.invariant(stat.S_ISREG(info.st_mode), "the test write target must be a regular file, never a device or symlink", path=redirect)
        return redirect
    path = disk["path"]
    if os_name == "Darwin" and path.startswith("/dev/disk"):
        return "/dev/r" + path[len("/dev/"):]
    return path


def linux_mounts(path):
    completed = subprocess.run(["lsblk", "-nrpo", "PATH,MOUNTPOINT", path], check=False, capture_output=True, text=True)
    mounts = []
    for line in completed.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip():
            mounts.append(parts[0])
    return mounts


def run_prep(os_name, disk, progress):
    if os.environ.get("FLEET_WRITE_TARGET"):
        return  # a plain file: nothing is mounted
    mounted = linux_mounts(disk["path"]) if os_name == "Linux" and shutil.which("lsblk") else []
    for command, script in prep_commands(os_name, disk, mounted):
        progress.emit("prepare", "Freeing the USB disk")
        if command == "diskpart":
            scratch = imaging.scratch_dir("fleet-diskpart-")
            file = scratch / "script.txt"
            file.write_text(script)
            done = decide.run_logged(["diskpart", "/s", str(file)], capture_output=True, text=True)
            shutil.rmtree(scratch, ignore_errors=True)
        else:
            done = decide.run_logged(command, capture_output=True, text=True)
        decide.invariant(done.returncode == 0, "could not free the USB disk for writing",
                         "Close anything using the USB disk, or unplug and replug it, then run the wizard again.", command=command, code=done.returncode)


def write_usb(request, progress):
    os_name = decide.current_os()
    iso, sha = verified_iso(request, progress)
    disk = find_disk(os_name, request)
    reason = decide.media_block(disk)
    decide.invariant(reason in (None, "mounted"), "refusing to write the installer to this disk", "Choose a USB disk, never an internal one.", reason=reason, path=disk["path"])
    decide.invariant(not disk.get("internal") or disk.get("usb") or disk.get("rm"), "refusing: the disk looks internal", path=disk["path"])
    # Windows preparation includes diskpart clean, which is already destructive.
    # Capacity must be proven before that command, including sector padding.
    imaging.check_capacity(iso.stat().st_size, int(disk.get("size") or 0))
    network = fleet_wifi.discover(os_name, request.get("wifi"))
    private_handoff = network is not None or not os.environ.get("FLEET_WRITE_TARGET")
    if private_handoff:
        imaging.check_capacity(imaging.padded(iso.stat().st_size) + fleet_wifi.TRAILER_SIZE, int(disk.get("size") or 0))
    with leases.DeviceLease(disk["path"]):
        # Recheck after acquiring the lease; preparation is destructive on Windows.
        disk = find_disk(os_name, request)
        decide.invariant(decide.media_block(disk) in (None, "mounted"), "the reserved disk is no longer a USB disk")
        imaging.check_capacity(iso.stat().st_size, int(disk.get("size") or 0))
        run_prep(os_name, disk, progress)
        again = find_disk(os_name, request)
        decide.invariant(decide.media_block(again) in (None, "mounted") and again.get("size") == disk.get("size"),
                         "the USB disk changed while it was being released", "Rescan and review the disk again.", path=disk["path"])
        progress.emit("write", "Writing the installer to the USB disk", 0)
        imaging.write_image(
            iso, raw_target(os_name, disk), int(disk.get("size") or 0), sha,
            lambda done, total: progress.emit("write", "Writing and checking the USB disk", int(done * 100 / total) if total else None),
        )
        if private_handoff:
            progress.emit("network", "Saving and verifying private Wi-Fi settings on the USB")
            fleet_wifi.write_trailer(raw_target(os_name, disk), int(disk["size"]), iso.stat().st_size, network)
    return "The USB disk is ready. Plug it into the new computer and boot from it."


def install_here(request, progress):
    from server import lookup_token_http
    decide.NET.setdefault("probe", lambda: imaging.probe(decide.installer_urls()[0]))
    decide.NET.setdefault("lookup", lookup_token_http)
    os_name = decide.current_os()
    role = str(request.get("role") or "")
    decide.invariant(role in decide.ROLES, "the request names an unknown role", role=role)
    if role == "devbox":
        os.environ["FLEET_DEVBOX_SSH_KEY"] = decide.validate_ssh_key(request.get("ssh_key"))
    decide.invariant(os_name in ("Linux", "Windows") or os.environ.get("FLEET_ALLOW_ANY_OS_INSTALL") == "1", "installing in place is only possible from Linux or Windows", "Make an install USB instead.", os=os_name)
    token = request.get("token") or None
    decide.invariant(token is None or TOKEN_RE.fullmatch(str(token)) is not None, "the enrollment token is malformed")
    iso, sha = verified_iso(request, progress)
    decide.check_installer_readiness(iso, role)
    directory = decide.state_dir()
    chosen = decide.choose_disk(os_name, "install")
    decide.invariant(chosen["ok"], "no single internal disk can be erased", chosen.get("next", ""), chosen=chosen.get("next"))
    decide.invariant(chosen["disk_id"] == request.get("disk_id"), "the internal disk is not the one that was chosen", "Disks changed. Run the wizard again.")
    found = decide.preflight(os_name, role, "install", token, directory, disk_path=chosen["path"], iso_path=str(iso))
    progress.record_checks("helper preflight", found)
    actions = preparation.automatic(os_name, found)
    problems = [item for item in found if item["status"] == "fail" and item["name"] not in actions]
    decide.invariant(not problems, "a check failed in the privileged step",
                     " ".join(dict.fromkeys(item["fix"] for item in problems if item.get("fix"))),
                     failed=[f"{item['name']}: {item['detail']}" for item in problems])
    reinstall = request.get("reinstall", False)
    decide.invariant(isinstance(reinstall, bool), "reinstall must be a boolean")
    if not reinstall and decide.installed_for(role, directory):
        # No restart: the page must not say one is coming.
        return {"message": f"This computer is already installed as {role}. Nothing was changed.", "restart": False}
    with leases.DeviceLease(chosen["path"]):
        again = decide.choose_disk(os_name, "install")
        decide.invariant(again.get("disk_id") == chosen["disk_id"], "the internal disk changed before preparation", "Review the disk again.")
        if preparation.run(os_name, found, progress):
            found = decide.preflight(os_name, role, "install", token, directory, disk_path=chosen["path"], iso_path=str(iso))
            progress.record_checks("helper after preparation", found)
            problems = [item for item in found if item["status"] == "fail"]
            decide.invariant(not problems, "automatic preparation could not make this computer ready",
                             "No partition or boot entry was changed. Make an install USB instead, or resolve the remaining check and reopen the installer.",
                             failed=[item["detail"] for item in problems])
        # The handoff image is shared state too: a second helper must not
        # replace it while the first is loading its kernel or restarting.
        if os_name == "Windows":
            # Windows writes the verified image straight into a new partition; no copy to stage.
            staged = iso
        else:
            staged = Path(directory) / "fleet-installer.iso"
            Path(directory).mkdir(parents=True, exist_ok=True)
            progress.emit("stage", "Copying the verified installer next to the system")
            if not (staged.is_file() and imaging.sha256_of(staged) == sha):
                shutil.copyfile(iso, staged)
            decide.invariant(imaging.sha256_of(staged) == sha, "the staged installer is not the verified image", file=str(staged))
        again = decide.choose_disk(os_name, "install")
        decide.invariant(again.get("disk_id") == chosen["disk_id"], "the internal disk changed before reboot", "Review the disk again.")
        if os_name == "Windows":
            progress.emit("prepare", "Preparing Windows to start the installer: making room on C:, writing the installer "
                                     "partition and setting a one-time boot. Nothing is erased yet, and any failure here is undone.")
        else:
            # kexec starts the installer at once; this is the last message this page can get.
            progress.emit("reboot", "Restarting into the installer. Nothing is erased until its checks pass after the restart.")
        decide.LOG.pop("next", None)
        # Not secrets: they let the installer screen's report name this attempt and wizard build.
        decide.HANDOFF.update(attempt=request.get("attempt") or "", wizard=version())
        try:
            code = decide.perform_install(
                os_name, role, str(staged), token, os.environ.get("FLEET_VAULT_ADDR") or None, directory, chosen,
                lambda done, total: progress.emit("write", "Writing the installer into a new partition and checking it", int(done * 100 / total) if total else None),
                **({"wifi": request["wifi"]} if request.get("wifi") is not None else {}),
            )
        finally:
            decide.HANDOFF.clear()
    # stage_windows says exactly why it stopped ("Next: ..."); keep that, not a generic fix.
    decide.invariant(code == 0, "the restart into the installer was not set up",
                     decide.LOG.get("next") or "Make an install USB instead.", code=code)
    if os_name == "Windows":
        progress.emit("reboot", "Windows restarts into the installer in about 15 seconds.")
    return {"message": f"Restarting into the installer to set up this computer as {role}.", "restart": True}


def version():
    try:
        from _version import VERSION
        return VERSION
    except ImportError:
        return "dev"


def run(directory):
    directory = Path(directory)
    started = time.monotonic()
    progress = Progress(directory)
    decide.start_log(["helper", str(directory.name)])
    decide.LOG["sink"] = lambda message: progress.emit("log", message)
    result = {"ok": False, "message": "", "fix": ""}
    try:
        request = load_request(directory)
        attempt = request.get("attempt", "")
        if isinstance(attempt, str) and re.fullmatch(r"[0-9a-f]{16}", attempt):
            decide.log(f"attempt={attempt} helper started pid={os.getpid()}")
        action = {"write-usb": write_usb, "install-here": install_here}[request["action"]]
        outcome = action(request, progress)
        result.update(outcome if isinstance(outcome, dict) else {"message": outcome})
        result["ok"] = True
    except decide.Invariant as broken:
        decide.log(traceback.format_exc(), "ERROR")
        result["error"] = diagnostics.exception_details(broken)
        result.update(message=f"{broken.what} ({'; '.join(f'{k}={v}' for k, v in broken.context.items())})", fix=broken.fix)
    except imaging.Cancelled:
        result.update(message="Cancelled. Nothing is left half done that running the wizard again cannot redo.", fix="")
    except Withdrawn:
        result.update(message="Cancelled before the administrator step started. Nothing was changed.", fix="", withdrawn=True)
    except Exception as exc:
        decide.log(traceback.format_exc(), "ERROR")
        result["error"] = diagnostics.exception_details(exc)
        result.update(message=f"{type(exc).__name__}: {exc}", fix="This is a bug in the installer. The log has the details.")
    finally:
        for name in (REQUEST, CLAIMED):
            request_file = directory / name
            try:
                if request_file.exists():
                    request_file.write_text("{}")  # the token must not outlive the run
            except OSError as exc:
                decide.log(f"could not clear the request file: {type(exc).__name__}: {exc}", "ERROR")
    result["log"] = decide.LOG["path"]
    result["checks"] = progress.checks
    result["helper"] = {"pid": os.getpid(), "os": decide.current_os(), "arch": decide.machine_arch(),
                        "step": progress.step, "elapsed": round(time.monotonic() - started, 1)}
    # The log carries the outcome too, in case the window cannot read result.json.
    decide.log(f"result ok={result['ok']} message={result['message']} fix={result['fix']}", "INFO" if result["ok"] else "ERROR")
    # The window may not be able to open this log (another account, or root-only), so
    # its end travels with the result for the diagnostic report.
    result["log_tail"] = diagnostics.tail(decide.LOG["path"], LOG_TAIL)
    final = directory / "result.json"
    temporary = directory / "result.json.tmp"
    try:
        temporary.write_text(json.dumps(result), encoding="utf-8")
        os.replace(temporary, final)
        os.chmod(final, 0o644)
    except OSError as exc:
        decide.log(f"could not write {final}: {type(exc).__name__}: {exc}", "ERROR")
        return 2
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1]))
