#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for script in scripts/*.sh; do bash -n "$script"; done
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/*.sh
else
  echo 'ShellCheck unavailable; shell syntax checks still run'
fi
# The downloadable file embeds decide.py and the agent runbook. A stale copy
# would ship old behavior to every new machine.
rebuilt=$(mktemp)
cp scripts/fleet-node.sh "$rebuilt"
bash scripts/bundle-fleet-node.sh
cmp scripts/fleet-node.sh "$rebuilt" || { echo 'scripts/fleet-node.sh is stale; it was rebuilt, commit it' >&2; rm -f "$rebuilt"; exit 1; }
rm -f "$rebuilt"
python3 -m py_compile wizard/*.py
if command -v node >/dev/null 2>&1; then node --check wizard/ui-e2e.cjs; fi
if command -v actionlint >/dev/null 2>&1; then
  actionlint -config-file actionlint.yaml workflows/*.yml ../../.github/workflows/*.yml
else
  echo 'actionlint unavailable; run the pinned Nix devShell checks on Linux'
fi
python3 - <<'CHECK'
import json
from pathlib import Path
lock = json.loads(Path('flake.lock').read_text())
for name in ('nixpkgs', 'disko', 'sops-nix'):
    pinned = lock['nodes'][name]['locked']
    assert len(pinned['rev']) == 40 and pinned['narHash'].startswith('sha256-')
assert not list(Path('secrets').glob('*.key'))
assert not list(Path('secrets').glob('*.pem'))
CHECK
python3 scripts/cattle.py check .
# roles.json is the one definition of a role; every copy must match it.
python3 scripts/fleet_roles.py check
