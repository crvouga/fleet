#!/usr/bin/env bash
# Optional remote keyboard for a machine that is already in the live image.
# The install and the disk choice happen on that machine. This computer does
# not build Nix, choose a role or read a credential.
set -euo pipefail

ip=${1:?IP address required}
[ "$#" -eq 1 ] || { echo 'usage: bootstrap.sh IP (the installer takes no role; assign it in the Fleet app)' >&2; exit 2; }
[[ "$ip" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Use a DNS name or IPv4 address' >&2; exit 2; }

if [ ! -t 0 ]; then
  echo 'Refusing to install without a terminal. On the machine, run: fleet-install' >&2
  exit 2
fi

echo 'The machine runs fleet-install. This session only forwards the keyboard.' >&2
exec ssh -t -o StrictHostKeyChecking=accept-new -o BatchMode=yes "root@${ip}" "FLEET_AUTO=1 fleet-install"
