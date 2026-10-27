#!/usr/bin/env bash
set -euo pipefail
# Only the image's trusted, public configuration is sourced here.
# shellcheck disable=SC1090
source "${SYNC_ENV:-/etc/fleet/sync.env}"
curl_bin=${FLEET_CURL:-curl}
systemctl=${FLEET_SYSTEMCTL:-systemctl}
healthy=1
"$curl_bin" -fsS --max-time 15 -o /dev/null https://github.com || healthy=0
if [ -n "${CACHE_URL:-}" ]; then
  "$curl_bin" -fsS --max-time 15 -o /dev/null "${CACHE_URL%/}/nix-cache-info" || healthy=0
else
  "$curl_bin" -fsS --max-time 15 -o /dev/null https://cache.nixos.org/nix-cache-info || healthy=0
fi
"$systemctl" is-active --quiet fleet-sync.timer || healthy=0
if [ "$healthy" -eq 1 ]; then
  python3 - "${FLEET_BOOTED_SYSTEM:-/run/booted-system}" "${FLEET_GC_ROOTS:-/nix/var/nix/gcroots}" <<'PY'
import os,sys
from pathlib import Path
current=Path(sys.argv[1]).resolve(strict=True)
roots=Path(sys.argv[2]); roots.mkdir(parents=True,exist_ok=True)
last,previous=roots/'fleet-last-healthy',roots/'fleet-previous-healthy'
def point(path,target):
    temporary=path.with_name(path.name+'.new')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary,path)
if last.is_symlink() and last.resolve()!=current and last.exists():
    point(previous,last.resolve())
point(last,current)
PY
  # The system an update rebooted into came up healthy: nothing to quarantine.
  state=${FLEET_STATE:-/nix/fleet-state}
  if [ -f "$state/sync/pending-boot" ] \
    && grep -qxF "toplevel=$(readlink -f "${FLEET_BOOTED_SYSTEM:-/run/booted-system}")" "$state/sync/pending-boot"; then
    rm -f "$state/sync/pending-boot"
  fi
  echo 'FLEET_BOOT_HEALTHY: update connectivity and timer verified; this boot may be blessed'
  exit 0
fi
state=${FLEET_STATE:-/nix/fleet-state}
install -d -m 0700 "$state/sync"
printf 'mode=boot-health\nFLEET_BOOT_HEALTH_FAILED: GitHub/cache connectivity or the update timer is unavailable. The boot was not blessed.\n' > "$state/sync/health-failure"
echo 'FLEET_BOOT_HEALTH_FAILED: refusing to bless a boot without a working update recovery channel' >&2
status=$("${FLEET_BLESS:-/run/current-system/systemd/lib/systemd/systemd-bless-boot}" status 2>/dev/null || true)
generations=$(python3 - "${FLEET_BOOT_ENTRIES:-/boot/loader/entries}" <<'PY'
import re,sys
from pathlib import Path
found={m[1] for p in Path(sys.argv[1]).glob('nixos-generation-*.conf') if (m:=re.match(r'nixos-generation-(\d+)',p.name))}
print(len(found))
PY
)
if [[ "$status" = indeterminate || "$status" = dirty ]] && [ "$generations" -gt 1 ]; then
  echo 'FLEET_BOOT_FALLBACK: retrying the counted boot; systemd-boot will fall back when its tries are exhausted' >&2
  "$systemctl" reboot
else
  echo 'FLEET_BOOT_WAITING: keeping this system running and retrying health; no safe counted fallback is available' >&2
fi
exit 1
