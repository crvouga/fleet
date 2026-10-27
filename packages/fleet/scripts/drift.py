#!/usr/bin/env python3
"""Compare the running revision with origin/main. Does not build.

A failed run is the lag signal. A node that is off the network cannot
report that fact about itself. TODO: nothing scrapes 127.0.0.1:9101, so
silence is invisible outside the machine.
"""

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def classify(local_rev, main_rev, main_commit_time, now, max_minutes):
    local = (local_rev or "").strip()
    if local == "" or local == "unknown":
        return "not-reporting"
    if local == (main_rev or "").strip():
        return "ok"
    age_minutes = (now - main_commit_time).total_seconds() / 60
    if age_minutes < max_minutes:
        return "within-grace"
    return "behind"


def _git(repo, url, args, check=True):
    command = ["git", "-c", f"safe.directory={repo}"]
    if url.startswith("file:"):
        command.extend(["-c", "protocol.file.allow=always"])
    command.extend(args)
    return subprocess.run(command, check=check, text=True, capture_output=True)


def fetch_main(url, branch, state_dir):
    state = Path(state_dir)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    repo = state / "repo"
    if not (repo / ".git").is_dir():
        _git(repo, url, ["init", "-q", str(repo)])
    removed = _git(repo, url, ["-C", str(repo), "remote", "remove", "origin"], check=False)
    if removed.returncode != 0 and "No such remote" not in removed.stderr:
        raise subprocess.CalledProcessError(removed.returncode, removed.args, removed.stdout, removed.stderr)
    _git(repo, url, ["-C", str(repo), "remote", "add", "origin", url])
    ref = f"refs/heads/{branch}:refs/remotes/origin/{branch}"
    _git(repo, url, ["-C", str(repo), "fetch", "--depth=1", "origin", ref])
    revision = _git(repo, url, ["-C", str(repo), "rev-parse", f"refs/remotes/origin/{branch}"]).stdout.strip()
    committed = _git(
        repo, url, ["-C", str(repo), "log", "-1", "--format=%cI", f"refs/remotes/origin/{branch}"]
    ).stdout.strip()
    return revision, datetime.fromisoformat(committed)


def main():
    url = os.environ.get("REPO_URL", "")
    if "TODO" in url:
        print("drift: repository URL is not configured")
        return 0
    branch = os.environ.get("BRANCH", "main")
    if branch != "main":
        print("drift: BRANCH must be main", file=sys.stderr)
        return 1
    revision_file = Path(os.environ.get("REVISION_FILE", "/etc/fleet/revision"))
    max_minutes = int(os.environ.get("MAX_MINUTES", "30"))
    state_dir = os.environ.get("STATE_DIR", "/nix/fleet-state/drift")
    try:
        local = revision_file.read_text(encoding="utf-8")
    except OSError:
        local = ""
    main_rev, committed = fetch_main(url, branch, state_dir)
    status = classify(local, main_rev, committed, datetime.now(timezone.utc), max_minutes)
    print(status)
    return 0 if status in ("ok", "within-grace") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as err:
        print(err.stderr or err, file=sys.stderr)
        sys.exit(1)
