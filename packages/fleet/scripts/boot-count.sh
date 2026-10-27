#!/usr/bin/env bash
# Give the newest systemd-boot entry a tries-left count.
# nixpkgs 7c8764b7 has no boot-counting option. boot.loader.systemd-boot.graceful
# only passes --graceful to bootctl install. It does not select the previous
# generation. The count lives in the entry filename (Boot Loader Specification).
# systemd-boot decrements it before starting the kernel. systemd-bless-boot
# removes it once userspace is up. A generation that never gets that far is
# sorted after the previous generation.
set -euo pipefail

esp=${FLEET_ESP:-/boot}
tries=${FLEET_BOOT_TRIES:-3}
loader="$esp/loader/loader.conf"
entries="$esp/loader/entries"

if [ ! -f "$loader" ]; then
  echo "boot-count: $loader is missing" >&2
  exit 1
fi

case "$tries" in
  ''|*[!0-9]*)
    echo "boot-count: tries must be a number" >&2
    exit 1
    ;;
esac
if [ "$tries" -lt 1 ]; then
  echo "boot-count: tries must be at least 1" >&2
  exit 1
fi

default=$(awk '$1 == "default" { print $2; exit }' "$loader")
if [ -z "${default:-}" ]; then
  echo "boot-count: loader.conf has no default" >&2
  exit 1
fi

base=${default%.conf}
base=${base%%+*}
plain="${base}.conf"
marked="${base}+${tries}.conf"
source=""

if [ -f "$entries/$plain" ]; then
  source="$entries/$plain"
elif [ -f "$entries/$marked" ]; then
  source="$entries/$marked"
else
  for candidate in "$entries/${base}"+*.conf; do
    if [ -f "$candidate" ]; then
      source=$candidate
      break
    fi
  done
fi

if [ -z "$source" ] || [ ! -f "$source" ]; then
  echo "boot-count: default entry $default is missing" >&2
  exit 1
fi

tmp=$(mktemp "$entries/.boot-count.XXXXXX")
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT
cp "$source" "$tmp"
rm -f "$entries/$plain"
find "$entries" -maxdepth 1 -type f -name "${base}+*.conf" -exec rm -f {} +
mv "$tmp" "$entries/$marked"
trap - EXIT

loader_tmp=$(mktemp "$esp/loader/.loader.XXXXXX")
cleanup_loader() {
  rm -f "$loader_tmp"
}
trap cleanup_loader EXIT
awk -v marked="$marked" '
  $1 == "default" { print "default " marked; next }
  { print }
' "$loader" > "$loader_tmp"
mv "$loader_tmp" "$loader"
trap - EXIT
