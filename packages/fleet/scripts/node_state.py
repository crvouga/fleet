#!/usr/bin/env python3
"""Nodes are stateless: everything they keep is a cache (ARCHITECTURE.md).

Root is tmpfs; /nix is the only disk a node writes. It holds three things:

  system    /nix/store and /nix/var: Nix's own, garbage collected.
  identity  the IDENTITY entries of /nix/fleet-state below: who this node is
            (credential, age identity, SSH host keys, Wi-Fi), what it was told
            (target) and what keeps updates safe across power loss (sync,
            recovery). They survive a role change.
  cache     everything else: workspaces, CI caches and job records, the
            applied settings, and anything a future module writes without
            declaring it here.

A role is an epoch. When a machine boots into a role other than the one that
wrote its cache, `epoch` wipes the cache before any service uses it, so no
role ever sees another role's data. The list is an allow-list on purpose:
data nobody declared is wiped, never kept by accident.

  python3 node_state.py epoch [ROOT]    at boot, before tmpfiles and services
  python3 node_state.py show [ROOT]     what a role change would keep and wipe
"""
import os
import shutil
import sys
from pathlib import Path

import recovery

# /nix entries that are not cache. lost+found belongs to the filesystem.
SYSTEM = frozenset(("store", "var", "fleet-state", "lost+found"))
# /nix/fleet-state entries that are the node's identity, not a role's data.
IDENTITY = frozenset((
    "agent",         # node credential, enrollment token, desired-state cache
    "secrets",       # age identity, bootstrap Git read credential
    "ssh",           # host keys: the node's SSH identity
    "network",       # Wi-Fi the installer carried over
    "target",        # desired role and closure (the controller's, or fleet-target's)
    "sync",          # update safety: pending boot, quarantine, Git cache
    "recovery",      # durable outbox and boot records
    "drift",         # how far behind main this node is
    "logs",          # install log
    "installed",     # install marker
    "handoff",       # recovery after an installer boot fell back
    "withdrawn",     # fleet-remove: never start runners again
    "role-epoch",    # this file's own record
))
EPOCH = "role-epoch"
BASE_ROLE = "base"


def read_role(conf):
    for line in Path(conf).read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        if key.strip() == "role":
            value = value.strip().strip("'\"")
            if value and value.replace("-", "").isalnum() and value.islower():
                return value
    raise ValueError("node.conf names no role")


def recorded_role(state):
    try:
        return read_role(state / EPOCH)
    except (OSError, ValueError):
        return None


def cache_entries(nix):
    """Every path a role change wipes, in a stable order."""
    entries = [nix / name for name in sorted(os.listdir(nix)) if name not in SYSTEM]
    state = nix / "fleet-state"
    if state.is_dir():
        entries += [state / name for name in sorted(os.listdir(state)) if name not in IDENTITY]
    return entries


def remove(path):
    """Remove one entry without following links or crossing into another mount."""
    if os.path.ismount(path):
        raise OSError(f"{path} is a mount point; not wiped")
    if path.is_symlink() or not path.is_dir():
        path.unlink()
        return
    shutil.rmtree(path)


def guard(root):
    nix = Path(root) / "nix"
    # A wrong root must never be wiped: require the shape of an installed node.
    for required in (nix / "store", nix / "var", nix / "fleet-state"):
        if not required.is_dir() or required.is_symlink():
            raise SystemExit(f"node-state: {required} is missing; refusing to wipe anything")
    return nix


def epoch(root="/", queue=recovery.queue):
    nix = guard(root)
    state = nix / "fleet-state"
    role = read_role(Path(root) / "etc/fleet/node.conf")
    previous = recorded_role(state)
    if previous is None:
        # First boot after installation or after the upgrade that added this
        # record: there is no other role's cache to remove.
        recovery.durable_write(state / EPOCH, f"role={role}\n", 0o644)
        print(f"node-state: role {role} recorded")
        return 0
    if previous == role:
        return 0
    failed = []
    wiped = []
    for path in cache_entries(nix):
        try:
            remove(path)
            wiped.append(str(path.relative_to(root)))
        except OSError as error:
            failed.append(f"{path.relative_to(root)}: {error.strerror or error}")
    if failed:
        # No new record: the next boot tries again before services start.
        for line in failed:
            print("node-state: could not wipe " + line, file=sys.stderr)
        return 1
    recovery.durable_write(state / EPOCH, f"role={role}\n", 0o644)
    message = f"role changed from {previous} to {role}; wiped {len(wiped)} cache entries"
    print("node-state: " + message)
    try:
        queue("state-wiped", "info", f"state-wiped:{previous}:{role}:{recovery.boot_id() or 'unknown'}"[:120], message,
              {"from": previous, "to": role, "entries": len(wiped)})
    except (OSError, ValueError) as error:
        print(f"node-state: the event was not queued: {error}", file=sys.stderr)
    return 0


def show(root="/"):
    nix = guard(root)
    for path in cache_entries(nix):
        print("wipe " + str(path.relative_to(root)))
    for name in sorted(IDENTITY):
        if (nix / "fleet-state" / name).exists():
            print("keep nix/fleet-state/" + name)
    return 0


def main(argv):
    if argv and argv[0] in ("epoch", "show") and len(argv) <= 2:
        root = argv[1] if len(argv) == 2 else "/"
        return epoch(root) if argv[0] == "epoch" else show(root)
    print("usage: node_state.py epoch|show [ROOT]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
