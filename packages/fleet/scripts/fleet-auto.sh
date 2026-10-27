#!/usr/bin/env bash
# Boot the USB image, or a handoff from the wizard, and this installs the role
# from the kernel command line. Windows, Linux, or an empty disk are the same:
# the internal disk is wiped. The netboot ramdisk has no manifest and leaves the
# disk alone.
#
# The person at the console always has a screen that says what is happening and
# what to do (scripts/live_console.py, `fleet-live`): one per step, a wait with
# its reason, a stop with recovery steps and a QR code for a pre-filled GitHub
# issue, and the restart. Temporary failures before erasing (exit 75) are
# retried here, inside one run of the unit. Retrying through systemd's Restart=
# failed the unit's start job between attempts, which let getty log in over the
# installer and left a bare prompt with no explanation.
# FLEET_SKIP_REBOOT=1 is the unit-test seam.
set -euo pipefail

if [ "$(id -u)" -ne 0 ] && [ "${FLEET_ALLOW_UNPRIVILEGED:-}" != 1 ]; then
  exec sudo -n --preserve-env=FLEET_AUTO,FLEET_ROLE,FLEET_CMDLINE,FLEET_KEY_DIR,FLEET_MANIFEST,FLEET_SKIP_REBOOT,FLEET_INSTALL,FLEET_LIVE,FLEET_LIVE_STATE -- "$0" "$@"
fi

manifest=${FLEET_MANIFEST:-/iso/fleet-install-manifest}
if [ ! -f "$manifest" ]; then
  echo 'No installer on this boot. The disk was not changed.' >&2
  exit 0
fi

if command -v udevadm >/dev/null 2>&1; then
  udevadm settle --timeout=30 || true
fi

export FLEET_AUTO=1
install=${FLEET_INSTALL:-fleet-install}
systemctl=${FLEET_SYSTEMCTL:-systemctl}
live=${FLEET_LIVE:-fleet-live}
log=${FLEET_INSTALL_LOG:-/run/fleet-install.log}
started_file=${FLEET_AUTO_STATE:-/run/fleet-auto-started}
state=${FLEET_LIVE_STATE:-/run/fleet-live}
attempt_log=$state/attempt.log
wait_limit=${FLEET_NETWORK_WAIT_SECONDS:-600}
retry_seconds=${FLEET_RETRY_SECONDS:-30}
return_seconds=${FLEET_RETURN_SECONDS:-120}
console_input=${FLEET_CONSOLE_INPUT:-/dev/console}

screen() {
  if command -v "$live" >/dev/null 2>&1; then
    "$live" "$@" || true
  fi
}
monotonic() { python3 -c 'import time; print(int(time.monotonic()))'; }

# A handoff from the wizard or fleet-node.sh carries fleet.from= (older ones
# only fleet.enroll=). Its original system is still on the disk until erasing
# starts, and the firmware boots it next, so a stop before erasing returns there.
handoff=no
if grep -Eq '(^|[[:space:]])fleet\.(from|enroll)=' "${FLEET_CMDLINE:-/proc/cmdline}" 2>/dev/null; then
  handoff=yes
fi

# One line every 30 seconds during long steps, so a busy screen never looks frozen.
ticker=""
stop_ticker() {
  if [ -n "$ticker" ]; then
    kill "$ticker" 2>/dev/null || true
    wait "$ticker" 2>/dev/null || true
    ticker=""
  fi
}
trap stop_ticker EXIT
# It draws on the console only; its own output must not hold the unit's pipes open.
( while sleep "${FLEET_TICK_SECONDS:-30}"; do screen tick; done ) </dev/null >/dev/null 2>&1 &
ticker=$!

# Enter at the console keeps the live system instead of returning. Keys pressed
# before the countdown are discarded first, so an early Enter cannot stay.
stay_requested() {
  local left=$1 code
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    read -r -t 0.05 _ 2>/dev/null < "$console_input" || break
  done
  while [ "$left" -gt 0 ]; do
    code=0
    read -r -t 1 _ 2>/dev/null < "$console_input" || code=$?
    if [ "$code" -eq 0 ]; then
      return 0
    fi
    # A timeout already took the second; EOF or a missing device returns at once.
    if [ "$code" -le 128 ]; then
      sleep 1
    fi
    left=$((left - 1))
  done
  return 1
}

mkdir -p "$state"
if [ ! -f "$started_file" ]; then
  monotonic > "$started_file"
fi
attempt=0
while :; do
  attempt=$((attempt + 1))
  # A reason left by an earlier attempt must not explain this one.
  rm -f "$log.diagnostic"
  set +e
  "$install" 2>&1 | tee "$attempt_log"
  status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -eq 0 ]; then
    break
  fi
  if [ "$status" -eq 75 ] && [ -e "$log.erasing" ]; then
    echo 'FLEET_INSTALL_STOPPED: disk operations began; automatic pre-wipe retries are disabled. Review the reported installation failure.' | tee -a "$attempt_log" >&2
    status=2
  fi
  if [ "$status" -ne 75 ]; then
    break
  fi
  started=0
  read -r started < "$started_file" || true
  now=$(monotonic)
  [[ "$started" =~ ^[0-9]+$ ]] || started=$now
  [[ "$wait_limit" =~ ^[0-9]+$ ]] || wait_limit=600
  remaining=$((wait_limit - (now - 10#$started)))
  if [ "$remaining" -le 0 ]; then
    echo "FLEET_NETWORK_WAIT_EXPIRED: the checks before erasing were still not ready after $((wait_limit / 60)) minutes. Nothing was erased." | tee -a "$attempt_log" >&2
    status=2
    break
  fi
  echo "Not ready before erasing (attempt $attempt); trying again in $retry_seconds seconds, for up to $remaining more seconds." >&2
  screen wait --attempt "$attempt" --remaining "$remaining" --retry "$retry_seconds"
  sleep "$retry_seconds"
done
stop_ticker

if [ "$status" -eq 0 ]; then
  echo 'Installed. If firmware boots this USB before the disk, pull the stick.' >&2
  screen 'done'
  if [ "${FLEET_SKIP_REBOOT:-}" = 1 ]; then
    exit 0
  fi
  sleep "${FLEET_DONE_SECONDS:-10}"
  exec "$systemctl" reboot
fi

# A staged conversion keeps the original OS until all integration checks pass.
# On a permanent pre-wipe failure, boot it again instead of stranding the person
# in the live image, unless they press Enter to stay. Never retry or reboot after
# disk work starts: the screen says how to report and recover.
returning=0
if [ ! -e "$log.erasing" ] && [ "$handoff" = yes ] && [ "${FLEET_SKIP_REBOOT:-}" != 1 ]; then
  returning=$return_seconds
fi
screen stopped --status "$status" --returning "$returning"
if [ "$returning" -gt 0 ]; then
  echo "FLEET-FAIL: installation stopped before disk changes. Returning to the original system in $returning seconds unless Enter is pressed at the console." >&2
  if stay_requested "$returning"; then
    echo 'Staying in the live installer at the person'"'"'s request.' >&2
    screen stayed
    exit "$status"
  fi
  exec "$systemctl" reboot
fi
exit "$status"
