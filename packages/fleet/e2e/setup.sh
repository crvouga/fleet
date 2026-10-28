#!/bin/bash
# Runs inside the container as root. Builds the world the wizard will meet.
set -euo pipefail
mkdir -p /work /srv/release /mnt/stick /mnt/verify /var/e2e-state
cd /work

# A real ISO9660 image made by a real mastering tool, laid out like the installer ISO.
rm -rf iso && mkdir -p iso/isolinux iso/boot
head -c 3000000 /dev/urandom > iso/boot/bzImage
head -c 5000000 /dev/urandom > iso/boot/initrd
# One entry: the installer installs the role-less base system.
printf 'DEFAULT boot\nLABEL boot\nLINUX /boot/bzImage\nAPPEND init=/nix/store/fleet/init\nINITRD /boot/initrd\n' > iso/isolinux/isolinux.cfg
printf '{"version":2,"blocked":[]}\n' > iso/fleet-readiness.json
xorriso -as mkisofs -quiet -R -J -V FLEET_E2E -o /srv/release/fleet-installer.iso iso
(cd /srv/release && sha256sum fleet-installer.iso > fleet-installer.iso.sha256)

# A state directory on a real ext4 filesystem (the installer refuses to stage on anything else).
if ! mountpoint -q /var/e2e-state; then
  truncate -s 512M /work/state.img && mkfs.ext4 -q -F /work/state.img && mount -o loop /work/state.img /var/e2e-state
fi

# Static servers
pkill -f release_server.py || true
: > /work/kexec.log
nohup python3 /e2e/release_server.py > /work/release.log 2>&1 &
cp /e2e/kexec-shim.sh /opt/kexec-shim.sh && chmod +x /opt/kexec-shim.sh

# The shipped artifact, built in this Linux: PyInstaller one-file, then its own selftest.
if [ ! -x /opt/fleet-installer/fleet-installer ]; then
  /opt/venv/bin/python /repo/packages/fleet/wizard/build.py --version e2e --out /work/dist
  mkdir -p /opt/fleet-installer && tar -xzf /work/dist/fleet-installer-linux-x64.tar.gz -C /opt/fleet-installer
fi
echo setup-done
