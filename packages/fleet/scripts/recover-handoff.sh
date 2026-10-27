#!/usr/bin/env bash
# A boot back into the source OS proves the staged conversion did not finish.
# This path never erases a disk and never revives an intentional removal.
set -euo pipefail
state=${FLEET_STATE:-/nix/fleet-state}
run=${FLEET_BUSY_DIR:-/run/fleet}
restore=$(python3 - "$state" <<'PY'
import sys
from pathlib import Path
root=Path(sys.argv[1])
def fields(name):
    try:
        return dict(line.split('=',1) for line in (root/name).read_text().splitlines() if '=' in line)
    except OSError:
        return {}
handoff, withdrawn=fields('handoff'),fields('withdrawn')
if handoff.get('status')=='staged' and handoff.get('restore_ci')=='1' and withdrawn.get('status')=='withdrawn' and withdrawn.get('role')=='ci':
    print('restore')
PY
)
if [ "$restore" = restore ]; then
  install -d -m 0755 "$run"
  printf 'recover failed installer boot\n' > "$run/draining"
  printf 'recover failed installer boot\n' > "$run/agent-drained"
  rm -f "$state/withdrawn"
  "${FLEET_RESUME:-fleet-resume}"
  echo 'FLEET_RECOVERED: installer did not replace the source system; original runner services restored'
fi
rm -f "$state/handoff"
