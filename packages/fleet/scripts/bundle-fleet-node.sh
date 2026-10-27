#!/usr/bin/env bash
# Rebuild scripts/fleet-node.sh so the downloaded file contains decide.py.
set -euo pipefail
cd "$(dirname "$0")/.."
out=scripts/fleet-node.sh
tmp=$(mktemp)
{
  cat <<'WRAPPER'
#!/usr/bin/env bash
# Download this one file and run it. No Nix, no git checkout, no just.
# The Python program and the agent runbook are embedded below so the file runs by itself.
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)

# The runbook needs no Python, so it works on a machine that has none yet.
if [ "${1:-}" = guide ]; then
  if [ -f "$here/../docs/agent-install.md" ]; then
    cat "$here/../docs/agent-install.md"
  else
    sed -n '/^# __GUIDE_MD__$/,/^# __GUIDE_END__$/p' "$0" | sed '1d;$d;s/^#$//;s/^# //'
  fi
  exit 0
fi

# A name that is on PATH may still not run: Windows ships python3.exe and python.exe stubs that only
# open the Microsoft Store. Take the first one that really starts Python 3.8 or newer.
py=""
for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    py=$candidate
    break
  fi
done
if [ -z "$py" ]; then
  echo 'Next: Python 3 is not installed, so nothing was written. Install Python 3 and run this program again.' >&2
  exit 1
fi

payload=$(mktemp -d)
cleanup() { rm -rf "$payload"; }
trap cleanup EXIT

if [ -f "$here/decide.py" ]; then
  cp "$here/decide.py" "$payload/decide.py"
else
  sed -n '/^# __DECIDE_PY__$/,/^# __DECIDE_END__$/p' "$0" | sed '1d;$d;s/^#$//;s/^# //' > "$payload/decide.py"
fi

sed -n '/^# __FLEET_WIFI_PY__$/,/^# __FLEET_WIFI_END__$/p' "$0" | sed '1d;$d;s/^#$//;s/^# //' > "$payload/fleet_wifi.py"
sed -n '/^# __WIFI_CAPTURE_PY__$/,/^# __WIFI_CAPTURE_END__$/p' "$0" | sed '1d;$d;s/^#$//;s/^# //' > "$payload/wifi_capture.py"
"$py" "$payload/decide.py" "$@"
WRAPPER
  printf '%s\n' '# __DECIDE_PY__'
  sed 's/^/# /;s/^# $/#/' scripts/decide.py
  printf '%s\n' '# __DECIDE_END__'
  printf '%s\n' '# __FLEET_WIFI_PY__'
  sed 's/^/# /;s/^# $/#/' wizard/fleet_wifi.py
  printf '%s\n' '# __FLEET_WIFI_END__'
  printf '%s\n' '# __WIFI_CAPTURE_PY__'
  sed 's/^/# /;s/^# $/#/' wizard/wifi_capture.py
  printf '%s\n' '# __WIFI_CAPTURE_END__'
  printf '%s\n' '# __GUIDE_MD__'
  sed 's/^/# /;s/^# $/#/' docs/agent-install.md
  printf '%s\n' '# __GUIDE_END__'
} > "$tmp"
mv "$tmp" "$out"
chmod +x "$out"
