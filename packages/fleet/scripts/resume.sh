#!/usr/bin/env bash
set -euo pipefail
run=${FLEET_BUSY_DIR:-/run/fleet}
runtime=${FLEET_SYSTEMD_RUNTIME:-/run/systemd/system}
systemctl=${FLEET_SYSTEMCTL:-systemctl}

update_in_progress() {
  [ -e "$run/update-draining" ] || return 1
  local state
  state=$("$systemctl" show --property=ActiveState --value fleet-sync.service) || return 0
  case "$state" in active|activating|reloading) return 0 ;; esac
  rm -f "$run/update-draining"
  return 1
}
if update_in_progress; then
  echo 'FLEET_UPDATE_DRAIN_ACTIVE: preserving admission until the update commits or recovers'
  exit 75
fi
reasons=$run/drain-reasons
if [ -e "$reasons/low-disk" ]; then
  echo 'FLEET_LOW_DISK: keeping the drain gate until fleet-cache-clean measures enough free space again'
  exit 0
fi
enabled=$("${FLEETCONF:?}" get runners.enabled true)
cordoned=$("$FLEETCONF" get runners.cordoned false)
if [ "$enabled" = false ] || [ "$cordoned" = true ]; then
  echo 'Keeping the drain gate: runners remain disabled or cordoned by Fleet configuration'
  exit 0
fi
rm -f "$runtime"/github-runner-*.service.d/drain.conf
"$systemctl" daemon-reload
count=$(tr -d '[:space:]' < "$run/slot-count")
case "$count" in
  ""|*[!0-9]*) echo 'FLEET_RUNNER_CAPACITY_INVALID: slot count is not a number' >&2; exit 1 ;;
esac
if [ "$count" -lt 1 ] || [ "$count" -gt "${FLEET_SLOT_MAX:-64}" ]; then
  echo 'FLEET_RUNNER_CAPACITY_INVALID: slot count is outside the configured capacity' >&2
  exit 1
fi
units=()
n=1
while [ "$n" -le "$count" ]; do
  units+=("github-runner-slot-$n.service")
  n=$((n + 1))
done
for unit in "${units[@]}"; do
  if "$systemctl" is-failed --quiet "$unit"; then
    "$systemctl" reset-failed "$unit"
  fi
done
for unit in "${units[@]}"; do
  slot=${unit#github-runner-}
  slot=${slot%.service}
  # Re-register removed labels on idle listeners; busy ephemeral listeners
  # finish their current job and register again without being interrupted.
  (
    exec 9>"$run/gate"
    flock 9
    if update_in_progress; then exit 75; fi
    if [ ! -e "$run/$slot/busy" ]; then
      "$systemctl" stop "$unit"
    fi
  )
done
(
  exec 9>"$run/gate"
  flock 9
  if update_in_progress; then exit 75; fi
  # Conditions are evaluated when systemd processes StartUnit. Queueing starts
  # before removing this file can silently skip them instead of recovering.
  rm -f "$run/draining"
  # Resuming answers every reason but low disk, which returned above.
  rm -f "$reasons/config" "$reasons/update" "$reasons/manual" "$reasons/unknown"
  if ! "$systemctl" --no-block start "${units[@]}"; then
    touch "$run/draining"
    printf 'recover failed runner start\n' > "$run/agent-drained"
    echo 'FLEET_RUNNER_RESUME_FAILED: listener start failed; admission remains closed and the agent will retry' >&2
    exit 1
  fi
)
