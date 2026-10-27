#!/usr/bin/env python3
"""Bounded job identity from runner hooks; never collect a job's environment or output."""
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SLOT = re.compile(r"slot-([1-9]|[1-5][0-9]|6[0-4])")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
RUN_ID = re.compile(r"[1-9][0-9]{0,19}")
JOB_NAME = re.compile(r"[A-Za-z0-9_. /:()@+-]{1,120}")


def timestamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def identity(env):
    repository = env.get("GITHUB_REPOSITORY", "")
    if len(repository) > 120 or not REPOSITORY.fullmatch(repository) or any(part in (".", "..") for part in repository.split("/")):
        repository = None
    run_id = env.get("GITHUB_RUN_ID", "")
    job = env.get("GITHUB_JOB", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    return {"repository": repository, "runId": run_id if RUN_ID.fullmatch(run_id) else None,
            "runAttempt": attempt if re.fullmatch(r"[1-9][0-9]{0,4}", attempt) else None,
            "jobName": job if JOB_NAME.fullmatch(job) else None}


def boot_id(env):
    try:
        return (Path(env.get("FLEET_PROC", "/proc")) / "sys/kernel/random/boot_id").read_text().strip() or None
    except OSError:
        return None


def durable(directory, name, value):
    """A record that survives power loss (scripts/recovery.py reads it at boot)."""
    fd, temporary = tempfile.mkstemp(prefix=".job-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, directory / name)
        temporary = None
        sync(directory)
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def sync(directory):
    handle = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def remember(event, value, env):
    """Keep the job durably while it runs. A job stopped part way moves to its
    own interrupted-*.json, so the slot's next job cannot overwrite the evidence."""
    slot = env.get("FLEET_SLOT", "")
    root = env.get("FLEET_JOB_STATE_ROOT")
    if not root:
        return
    directory = Path(root) / slot
    if not directory.is_dir() or directory.is_symlink():
        return
    current = directory / "job.json"
    if event == "started":
        durable(directory, "job.json", dict(value, bootId=boot_id(env)))
        return
    if event == "stopped":
        stamp = re.sub(r"[^0-9]", "", value.get("startedAt") or timestamp())
        durable(directory, f"interrupted-{stamp}.json", dict(value, bootId=boot_id(env)))
        clear_cache(env, slot)
    try:
        current.unlink()
        sync(directory)
    except FileNotFoundError:
        pass


def clear_cache(env, slot):
    """A job that stopped part way can leave a half-written cache; the next job starts clean.
    Only the slot's own cache directory, checked by name."""
    cache = env.get("CI_CACHE_DIR", "")
    if cache != f"/nix/ci-cache/{slot}" and not (env.get("FLEET_CACHE_ROOT") and cache == f"{env['FLEET_CACHE_ROOT']}/{slot}"):
        return
    folder = Path(cache)
    if not folder.is_dir() or folder.is_symlink():
        return
    for entry in folder.iterdir():
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        except OSError:
            continue


def record(event, env=None):
    env = os.environ if env is None else env
    slot = env.get("FLEET_SLOT", "")
    if not SLOT.fullmatch(slot) or event not in ("started", "completed", "stopped"):
        return False
    directory = Path(env.get("FLEET_RUN", "/run/fleet")) / slot
    path = directory / "job.json"
    previous = {}
    try:
        flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
                raise ValueError()
            previous = json.loads(handle.read(8193))
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError, RecursionError):
        pass
    if event == "stopped" and (not previous.get("startedAt") or previous.get("finishedAt")):
        return True
    now = timestamp()
    if event == "started":
        value = dict(identity(env), startedAt=now, finishedAt=None, result=None)
    else:
        # Preserve the identity captured at start; a completed hook does not
        # prove success/failure, which must be read from the GitHub run.
        value = {name: previous.get(name) for name in ("repository", "runId", "runAttempt", "jobName", "startedAt")}
        value.update(finishedAt=now, result="interrupted" if event == "stopped" else "completed")
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".job-", dir=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
        temporary = None
    except OSError:
        return False
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
    try:
        remember(event, value, env)
    except OSError:
        pass  # the tmpfs record above still serves telemetry
    return True


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        available = len(argv) == 1 and record(argv[0])
    except Exception:
        # These files are controlled by an unprivileged runner. Diagnostic
        # failure must neither stop project work nor print raw exception data.
        available = False
    if not available:
        print("fleet-runner-job: job diagnostic metadata unavailable", file=sys.stderr)
    # Best-effort reporting must never stop a runner from doing its job.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
