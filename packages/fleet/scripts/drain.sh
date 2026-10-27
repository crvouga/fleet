#!/usr/bin/env bash
set -euo pipefail
# Close local admission first. Attempt GitHub label removal, but an expired
# credential must not prevent the OS update that repairs it. The local gate and
# busy markers are authoritative for whether stopping listeners is safe.
timeout="${1:-7200}"
[[ "$timeout" =~ ^[0-9]+$ ]] || { echo 'timeout must be seconds' >&2; exit 2; }
install -d -m 0755 /run/fleet
# Serialize with the job-start hook so no workflow reaches project code after drain begins.
exec 9>/run/fleet/gate
flock 9
touch /run/fleet/draining
# Why admission is closed (docs/resilience.md). Each holder clears only its own
# reason, and admission reopens when none is left: a drain is never orphaned.
reason=${FLEET_DRAIN_REASON:-manual}
[[ "$reason" =~ ^[a-z-]{1,30}$ ]] || reason=manual
install -d -m 0755 /run/fleet/drain-reasons
date -u +%Y-%m-%dT%H:%M:%SZ > "/run/fleet/drain-reasons/$reason"
flock -u 9
host=""
if [ -r /run/fleet/node ]; then
  host=$(awk -F= '$1 == "runner_prefix" { print $2 }' /run/fleet/node)
fi
host=${host:-$(hostname)}
end=$((SECONDS + timeout))
result=0
drain_one() {
  local remaining
  remaining=$((end - SECONDS))
  (( remaining > 0 )) || { echo 'Drain timed out; runner labels remain removed.' >&2; exit 1; }
  set +e
  runner-control drain "$1" "$2" "$FLEET_APP_ID" "$FLEET_INSTALLATION_ID" \
    /run/secrets/github-app-key "$host" "$remaining"
  result=$?
  set -e
}
read -r -a targets <<< "$FLEET_TARGETS"
for target in "${targets[@]}"; do
  drain_one "$FLEET_SCOPE" "$target"
  if (( result != 0 && result != 3 )); then
    echo "FLEET_GITHUB_DRAIN_DEGRADED: remote drain failed (exit $result); waiting for local jobs behind the closed admission gate" >&2
  fi
done
# Repositories the fleet API assigned to slots (recorded at registration in
# /run/fleet/assign-used). A runner there is drained like any other. One that
# GitHub cannot be asked about must not block updates; the job markers below
# are the check that does not depend on GitHub.
repo_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
for used in /run/fleet/assign-used/*; do
  [ -s "$used" ] || continue
  read -r repo < "$used" || continue
  [[ "$repo" =~ $repo_pattern ]] || continue
  if [ "$FLEET_SCOPE" = repository ] && [[ " $FLEET_TARGETS " == *" $repo "* ]]; then continue; fi
  drain_one repository "$repo"
  if (( result != 0 && result != 3 )); then echo "drain: repository $repo could not be checked (exit $result); using the local job markers" >&2
  fi
done
# A running job is a file under /run/fleet/<slot>/busy. Minimal Nix Bash does
# not include the readline-dependent compgen builtin.
has_busy_jobs() {
  local marker
  for marker in /run/fleet/*/busy; do
    [ ! -e "$marker" ] || return 0
  done
  return 1
}
while true; do
  flock 9
  if ! has_busy_jobs; then
    read -r -a runner_units <<< "$FLEET_UNITS"
    systemctl stop "${runner_units[@]}"
    flock -u 9
    break
  fi
  flock -u 9
  (( SECONDS < end )) || { echo 'Drain timed out; runner labels remain removed.' >&2; exit 1; }
  remaining=$((end - SECONDS))
  if (( remaining > 5 )); then remaining=5; fi
  sleep "$remaining"
done
echo "All runners drained and stopped. /run/fleet/draining remains until fleet-resume."
