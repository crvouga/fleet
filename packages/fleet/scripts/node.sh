#!/usr/bin/env bash
# Emergency access is read-only. No changes are ever made over SSH.
# Bootstrap is the one-time install, and it wipes the disk. After that,
# every change is a commit on main.
set -euo pipefail
cd "$(dirname "$0")/.."
operation=${1:?operation required}
node=${2:?SSH host required}
# Restrict host arguments to avoid SSH option injection and remote shell expansion.
[[ "$node" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Use a DNS name or IPv4 address' >&2; exit 2; }
case "$operation" in
  status)
    # Read-only. Changing a node is a git commit, not an SSH command.
    ssh "root@$node" 'printf "revision=%s\n" "$(cat /etc/fleet/revision 2>/dev/null || echo unknown)"; printf "system=%s\n" "$(readlink /run/current-system)"; systemctl is-active fleet-sync.timer || true; systemctl --no-pager --failed; echo "--- health"; cat /run/fleet/health-failure 2>/dev/null || echo none; echo "--- disk"; cat /run/fleet/disk-alert 2>/dev/null || echo none'
    ;;
  *)
    echo 'Git is the only control surface. Bootstrap once with: just bootstrap ROLE IP. After that, change nodes by merging to main.' >&2
    exit 2
    ;;
esac
