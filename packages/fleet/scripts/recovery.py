#!/usr/bin/env python3
"""What a node remembers across power loss, and the recovery events it owes Fleet.

Everything here is durable: written to /nix/fleet-state/recovery with fsync on
the file and its directory, so a power cut leaves the old record or the new
one, never half of either. docs/resilience.md lists the failure modes.

  boot       at every boot, before runners and the agent (fleet-recovery.service):
             notes whether the previous boot ended cleanly, recovers jobs that a
             power loss interrupted, and records this boot as not yet ended.
  shutdown   the same unit's ExecStop: this boot ended cleanly.
  jobs       recover interrupted job records (the agent calls this every cycle).
  event KIND SEVERITY KEY MESSAGE
             queue one recovery event (fleet-sync.sh uses this).
  status     print the recovery facts the agent reports, as JSON.

The outbox holds events until Fleet accepts them. Each has a stable key, so a
retried heartbeat cannot record an event twice: the server ignores a key it has
seen (packages/fleet-api, insertEvents). Delivery is therefore at least once from
the node and once in Fleet. Nothing here reads a secret.
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

KEY = re.compile(r"[A-Za-z0-9:._-]{1,120}")
KIND = re.compile(r"[a-z][a-z-]{1,39}")
SLOT = re.compile(r"slot-([1-9]|[1-5][0-9]|6[0-4])")
SEVERITIES = ("info", "warn", "error")
MAX_OUTBOX = 200  # oldest dropped first; a node that cannot report for weeks keeps the newest
MAX_TEXT = 500


def state_dir():
    return Path(os.environ.get("FLEET_RECOVERY_STATE") or "/nix/fleet-state/recovery")


def job_state_root():
    """Each slot's durable job record (runner_job.py). Written by the slot user, so untrusted."""
    return Path(os.environ.get("FLEET_JOB_STATE_ROOT") or "/nix/ci-state")


def cache_root():
    return Path(os.environ.get("FLEET_CACHE_ROOT") or "/nix/ci-cache")


def proc():
    return Path(os.environ.get("FLEET_PROC") or "/proc")


def boot_id():
    try:
        return (proc() / "sys/kernel/random/boot_id").read_text().strip() or None
    except OSError:
        return None


def now():
    return int(time.time())


def iso(seconds):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))


def durable_write(path, text, mode=0o600):
    """Old content or new content after a power cut, never a torn or empty file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        sync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def sync_directory(directory):
    try:
        handle = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(handle)
    except OSError:
        pass
    finally:
        os.close(handle)


def durable_remove(path):
    path = Path(path)
    try:
        path.unlink()
    except FileNotFoundError:
        return
    sync_directory(path.parent)


def read_json(path, limit=65536):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.loads(handle.read(limit))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, RecursionError):
        return None


def clip(text, limit=MAX_TEXT):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---- the outbox ---------------------------------------------------------------------

def outbox(base=None):
    return Path(base or state_dir()) / "outbox"


def queue(kind, severity, key, message, data=None, base=None):
    """Queue one event under a stable key. Queuing the same key again replaces it."""
    if not KIND.fullmatch(kind) or severity not in SEVERITIES or not KEY.fullmatch(key):
        raise ValueError("invalid recovery event")
    record = {"kind": kind, "severity": severity, "key": key, "message": clip(message),
              "at": iso(now()), "data": data or {}}
    name = key.replace(":", "_") + ".json"
    durable_write(outbox(base) / name, json.dumps(record, sort_keys=True) + "\n")
    trim(base)


def pending(base=None):
    """Queued events, oldest first."""
    folder = outbox(base)
    try:
        files = sorted(folder.glob("*.json"), key=lambda path: (path.stat().st_mtime, path.name))
    except OSError:
        return []
    events = []
    for path in files:
        record = read_json(path, 8192)
        if record and KIND.fullmatch(str(record.get("kind"))) and KEY.fullmatch(str(record.get("key"))) \
                and record.get("severity") in SEVERITIES:
            events.append(record)
        else:
            durable_remove(path)  # a torn or foreign file must not block the rest
    return events


def acknowledge(keys, base=None):
    """Fleet accepted these keys: forget them."""
    for key in keys:
        if KEY.fullmatch(str(key)):
            durable_remove(outbox(base) / (str(key).replace(":", "_") + ".json"))


def trim(base=None):
    events = pending(base)
    for record in events[:max(0, len(events) - MAX_OUTBOX)]:
        durable_remove(outbox(base) / (record["key"].replace(":", "_") + ".json"))


# ---- boots --------------------------------------------------------------------------

def pstore_records():
    """Crash records the firmware kept across the reset (names only). systemd-pstore
    moves them from /sys/fs/pstore to /var/lib/systemd/pstore early in boot."""
    folders = [os.environ["FLEET_PSTORE"]] if os.environ.get("FLEET_PSTORE") else ["/sys/fs/pstore", "/var/lib/systemd/pstore"]
    names = []
    for folder in folders:
        try:
            names += [path.name for path in Path(folder).iterdir()]
        except OSError:
            continue
    return sorted(names)[:8]


def on_boot():
    """Compare with the record the previous boot left, then start this boot's record."""
    current = boot_id()
    record_path = state_dir() / "boot.json"
    previous = read_json(record_path)
    result = {"previousBootId": None, "previousClean": None}
    if previous and previous.get("bootId") and previous.get("bootId") != current:
        result["previousBootId"] = previous["bootId"]
        clean = previous.get("cleanAt") is not None
        result["previousClean"] = clean
        if not clean:
            crashes = pstore_records()
            cause = ("The kernel left a crash record (pstore: " + ", ".join(crashes) + "), so a kernel panic or "
                     "watchdog reset is likely." if crashes else
                     "No crash record was kept, so the cause is not known here: power loss, a hard reset, a "
                     "watchdog reset or a kernel panic all look the same.")
            queue("unclean-shutdown", "warn", f"unclean:{previous['bootId']}",
                  f"The previous boot (started {previous.get('startedAt', 'at an unknown time')}) ended without a "
                  f"clean shutdown. {cause}",
                  {"bootId": previous["bootId"], "startedAt": previous.get("startedAt"), "pstore": ", ".join(crashes) or None})
        history = state_dir() / "boots.json"
        boots = (read_json(history) or {}).get("boots") or []
        boots = (boots + [{"bootId": previous["bootId"], "startedAt": previous.get("startedAt"),
                           "endedAt": previous.get("cleanAt"), "clean": clean}])[-20:]
        durable_write(history, json.dumps({"boots": boots}) + "\n", 0o644)
    if current and (not previous or previous.get("bootId") != current):
        durable_write(record_path, json.dumps({"bootId": current, "startedAt": iso(now()), "cleanAt": None}) + "\n", 0o644)
    recover_jobs(at_boot=True)
    return result


def on_shutdown():
    record_path = state_dir() / "boot.json"
    record = read_json(record_path) or {}
    if record.get("bootId") == boot_id():
        record["cleanAt"] = iso(now())
        durable_write(record_path, json.dumps(record) + "\n", 0o644)


def last_boot(base=None):
    """The facts the agent reports about the boot before this one."""
    boots = (read_json(Path(base or state_dir()) / "boots.json") or {}).get("boots") or []
    last = boots[-1] if boots else None
    unclean = sum(1 for item in boots if item.get("clean") is False)
    return {"previousClean": last.get("clean") if last else None,
            "previousEndedAt": last.get("endedAt") if last else None,
            "uncleanOfLast": [unclean, len(boots)]}


# ---- jobs ---------------------------------------------------------------------------

def slot_dirs():
    try:
        return sorted(path for path in job_state_root().iterdir() if SLOT.fullmatch(path.name))
    except OSError:
        return []


def wipe_cache(slot):
    """A job that died part way can leave a half-written cache. The next job starts clean."""
    folder = cache_root() / slot
    if not SLOT.fullmatch(slot) or not folder.is_dir() or folder.is_symlink():
        return False
    for entry in folder.iterdir():
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        except OSError:
            return False
    return True


def job_records(folder):
    """(path, record, cause) for each job this slot did not finish.

    job.json is the slot's current job. Left unfinished from an earlier boot, a
    reset cut it off. interrupted-*.json are jobs the slot itself saw stopped
    (runner_job.py "stopped"), kept apart so the next job cannot overwrite them."""
    current = boot_id()
    found = []
    record = read_json(folder / "job.json", 8192)
    if record and record.get("startedAt") and not record.get("finishedAt") \
            and record.get("bootId") and record.get("bootId") != current:
        found.append((folder / "job.json", record, "reset"))
    for path in sorted(folder.glob("interrupted-*.json"))[:16]:
        record = read_json(path, 8192)
        if record:
            found.append((path, record, "stopped"))
        else:
            durable_remove(path)
    return found


def recover_jobs(at_boot=False, base=None):
    """Turn jobs that never finished into interrupted-job events.

    The records are written by the job's own user, so every field is validated
    and treated as a claim, not a fact. A job is never re-run here: GitHub marks
    it failed, and only a person knows whether repeating it is safe."""
    found = 0
    for folder in slot_dirs():
        records = job_records(folder)
        wiped = wipe_cache(folder.name) if at_boot and records else False
        for path, record, cause in records:
            repository = record.get("repository") if isinstance(record.get("repository"), str) \
                and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", record.get("repository")) else None
            run_id = str(record.get("runId")) if re.fullmatch(r"[1-9][0-9]{0,19}", str(record.get("runId") or "")) else None
            attempt = str(record.get("runAttempt")) if re.fullmatch(r"[1-9][0-9]{0,4}", str(record.get("runAttempt") or "")) else "1"
            job = clip(record.get("jobName") or "unknown job", 120)
            how = "a reset or power loss" if cause == "reset" else "its runner being stopped"
            link = f"https://github.com/{repository}/actions/runs/{run_id}" if repository and run_id else None
            message = (f"A CI job on {folder.name} was interrupted by {how}: {repository or 'unknown repository'} "
                       f"run {run_id or 'unknown'}, job {job}. GitHub marks it failed; it was not re-run automatically."
                       + (f" Re-run it at {link} if it is safe to repeat." if link else "")
                       + (" The slot's cache was cleared." if wiped else ""))
            key = re.sub(r"[^A-Za-z0-9:._-]", "-", f"job:{repository or 'unknown'}:{run_id or record.get('startedAt')}:{attempt}:{job}")[:120]
            queue("job-interrupted", "warn", key, message,
                  {"slot": folder.name, "repository": repository, "runId": run_id, "runAttempt": attempt,
                   "job": job, "cause": cause, "url": link, "startedAt": record.get("startedAt"), "cacheCleared": wiped},
                  base=base)
            durable_remove(path)
            found += 1
    return found


# ---- what the agent reports -----------------------------------------------------------

def quarantine(sync=None):
    record = read_json(Path(sync or os.environ.get("FLEET_SYNC_STATE") or "/nix/fleet-state/sync") / "quarantine.json")
    if not record:
        return None
    return {key: record.get(key) for key in ("revision", "toplevel", "boot", "at", "reason")}


def gate(run=None):
    """Why runner admission is closed, if it is (/run/fleet, scripts/drain.sh)."""
    run = Path(run or os.environ.get("FLEET_RUN") or "/run/fleet")
    try:
        reasons = sorted(path.name for path in (run / "drain-reasons").iterdir() if re.fullmatch(r"[a-z-]{1,30}", path.name))
    except OSError:
        reasons = []
    return {"closed": (run / "draining").exists(), "reasons": reasons}


def status(base=None, run=None, sync=None):
    return {"boot": last_boot(base), "quarantine": quarantine(sync), "gate": gate(run), "outbox": len(pending(base))}


def main(argv):
    command = argv[0] if argv else ""
    if command == "boot":
        print(json.dumps(on_boot()))
    elif command == "shutdown":
        on_shutdown()
    elif command == "jobs":
        print(recover_jobs())
    elif command == "event" and len(argv) == 5:
        queue(argv[1], argv[2], argv[3], argv[4])
    elif command == "status":
        print(json.dumps(status(), sort_keys=True))
    else:
        print("usage: recovery.py boot|shutdown|jobs|status|event KIND SEVERITY KEY MESSAGE", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
