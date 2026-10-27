#!/bin/bash
# (Re)create a "USB stick": a real loop block device with a mounted FAT
# filesystem holding a file that must not survive being written over.
# Prints the device path. Usage: make-stick.sh [size-MB]
set -euo pipefail
size=${1:-128}
umount /mnt/stick 2>/dev/null || true
for old in $(losetup -j /work/stick.img -O NAME -n 2>/dev/null); do losetup -d "$old" || true; done
rm -f /work/stick.img && truncate -s "${size}M" /work/stick.img
dev=$(losetup --show -f /work/stick.img)
mkfs.vfat "$dev" >/dev/null
mount "$dev" /mnt/stick
echo "precious data" > /mnt/stick/precious.txt
sync
echo "$dev"
