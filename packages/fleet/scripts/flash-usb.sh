#!/usr/bin/env bash
# Write the installer ISO to a USB disk. Never run automatically.
# Linux takes /dev/disk/by-id/usb-*. macOS takes /dev/diskN from
# `diskutil list external physical`. FLEET_OS overrides uname in tests.
set -euo pipefail
iso=${1:?ISO path required}
device=${2:?USB whole-disk path required}
os=${FLEET_OS:-$(uname -s)}
[ -f "$iso" ] || { echo 'ISO is missing' >&2; exit 2; }

confirm() {
  echo "DESTRUCTIVE: writes $iso to $device. Type the full device path:" >&2
  if [ ! -t 0 ]; then
    echo 'Refusing to flash without a terminal.' >&2
    exit 2
  fi
  read -r answer
  [ "$answer" = "$device" ] || { echo 'Device path did not match. Nothing was written.' >&2; exit 1; }
}

case "$os" in
  Linux)
    [[ "$device" = /dev/disk/by-id/usb-* ]] || { echo 'Require /dev/disk/by-id/usb-*' >&2; exit 2; }
    real=$(readlink -f "$device")
    lsblk --paths --output NAME,TYPE,TRAN,SIZE,MODEL,SERIAL,MOUNTPOINTS "$real"
    [[ $(lsblk -dn -o TYPE "$real") = disk && $(lsblk -dn -o TRAN "$real") = usb ]] || {
      echo 'Require a whole USB disk' >&2
      exit 2
    }
    if lsblk -nr -o MOUNTPOINTS "$real" | grep -q '[^[:space:]]'; then
      echo 'Device or descendants mounted; unmount explicitly and retry' >&2
      exit 1
    fi
    confirm
    sudo dd if="$iso" of="$real" bs=4M conv=fsync status=progress
    sync
    ;;
  Darwin)
    [[ "$device" =~ ^/dev/disk[0-9]+$ ]] || {
      echo 'Require /dev/diskN from diskutil list external physical' >&2
      exit 2
    }
    info=$(diskutil info "$device")
    printf '%s\n' "$info"
    printf '%s\n' "$info" | grep -q 'Protocol:.*USB' || { echo 'Not a USB disk' >&2; exit 2; }
    printf '%s\n' "$info" | grep -q 'Internal:.*No' || { echo 'Refusing an internal disk' >&2; exit 2; }
    printf '%s\n' "$info" | grep -q 'Whole:.*Yes' || { echo 'Require the whole disk, not a partition' >&2; exit 2; }
    confirm
    diskutil unmountDisk "$device"
    raw=/dev/r${device#/dev/}
    sudo dd if="$iso" of="$raw" bs=4m
    sync
    ;;
  *)
    echo "No flash support for $os" >&2
    exit 2
    ;;
esac
