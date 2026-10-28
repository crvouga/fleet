#!/usr/bin/env bash
# Install the role-less base system from the live image. The USB ISO that CI
# built contains it. This machine picks the disk and installs; the Fleet
# controller assigns the role afterwards (ARCHITECTURE.md). No work computer,
# Nix build, SSH key or role choice is required. The node creates its own age
# identity on first boot; this installer never handles one.
# FLEET_ALLOW_UNPRIVILEGED=1 is a unit-test seam. A real install is root.
set -euo pipefail

if [ "$(id -u)" -ne 0 ] && [ "${FLEET_ALLOW_UNPRIVILEGED:-}" != 1 ]; then
  exec sudo -n --preserve-env=FLEET_AUTO,FLEET_CMDLINE,FLEET_KEY_DIR,FLEET_MANIFEST,FLEET_ENROLL_TOKEN,FLEET_GIT_CREDENTIAL_FILE,FLEET_LIVE,FLEET_LIVE_STATE -- "$0" "$@"
fi

# One timestamped line per step, kept on the live image and copied to the
# installed node at the end (/nix/fleet-state/logs/install.log). Never a secret.
log=${FLEET_INSTALL_LOG:-/run/fleet-install.log}
note() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$log" 2>/dev/null || true; }
# An automatic install shows the person one screen per step: what is happening,
# whether anything is erased and what to do (scripts/live_console.py). A screen
# never stops the install, and manual or test runs without the tool only log.
live_step() {
  note "step $1"
  if [ "${FLEET_AUTO:-}" = 1 ] && command -v "${FLEET_LIVE:-fleet-live}" >/dev/null 2>&1; then
    "${FLEET_LIVE:-fleet-live}" step "$1" >/dev/null 2>&1 || true
  fi
}
set -E
report_pid=""
stop_reporter() {
  if [ -n "$report_pid" ]; then
    kill "$report_pid" 2>/dev/null || true
    wait "$report_pid" 2>/dev/null || true
    report_pid=""
  fi
}
on_error() {
  stop_reporter
  printf 'FLEET_INSTALL_FAILED: installer exited %s at line %s. Disk work may have started; check Fleet installation events.\n' "$1" "$2" > "$log.diagnostic"
  note "FAIL exit $1 at line $2: $3"
  printf 'FLEET-FAIL fleet-install stopped at line %s (exit %s): %s\nLog: %s\n' "$2" "$1" "$3" "$log" >&2
  if [ -n "${toplevel:-}" ] && [ -n "${token_file:-}" ] && command -v fleet-bootstrap-report >/dev/null 2>&1; then
    fleet-bootstrap-report "$toplevel" "$token_file" "FLEET_INSTALL_FAILED: installer exited $1 at line $2. Review this node's installation event and copy its diagnostic report." || true
  fi
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

if [ "${FLEET_ALLOW_UNPRIVILEGED:-}" != 1 ]; then
  if [ "$(uname -m)" != x86_64 ] || [ ! -d /sys/firmware/efi ]; then
    echo 'Next: this installer requires x86-64 hardware booted in UEFI mode. Enable UEFI and disable legacy/CSM boot. Nothing was wiped.' >&2
    exit 2
  fi
fi

if [ "$#" -gt 0 ]; then
  echo 'usage: fleet-install' >&2
  echo 'It installs the Fleet base system. The role is assigned in the Fleet app after approval.' >&2
  exit 2
fi

cmdline_value() {
  local name=$1 file=${FLEET_CMDLINE:-/proc/cmdline}
  [ -r "$file" ] || return 0
  awk -v name="$name" '
    {
      for (i = 1; i <= NF; i++) {
        if (index($i, name "=") == 1) { last = substr($i, length(name) + 2) }
      }
    }
    END { printf "%s", last }
  ' "$file"
}

# An older image's boot entry still passes fleet.role=. The installer has no
# role: the Fleet controller assigns it after approval.
old_role=$(cmdline_value fleet.role)
if [ -n "$old_role" ]; then
  note "ignoring fleet.role=$old_role from an older boot entry; the role is assigned in Fleet"
fi

key_dir=${FLEET_KEY_DIR:-}
mounted_key=0
cleanup() {
  stop_reporter
  if [ "$mounted_key" -eq 1 ]; then
    umount "$key_dir" || true
    rmdir "$key_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# An optional FLEET-KEY volume may hold enrollment.token, git-read-key or
# git-read-token. It is only read.
if [ -z "${FLEET_KEY_DIR:-}" ] && [ -e /dev/disk/by-label/FLEET-KEY ]; then
  key_dir=$(mktemp -d)
  mount -o ro /dev/disk/by-label/FLEET-KEY "$key_dir"
  mounted_key=1
fi

# Public identifiers that tie this install to the wizard run that sent it. The
# installed node keeps this log, so its own console report can name them too.
note "handoff from=$(cmdline_value fleet.from) wizard=$(cmdline_value fleet.wizard) attempt=$(cmdline_value fleet.attempt) wifi=$(cmdline_value fleet.wifi)"
live_step network
# Connect with the carried profile before registering or wiping anything. The
# helper never prints passwords or places them in arguments.
if command -v fleet-wifi-ready >/dev/null 2>&1; then
  note 'checking automatic Wi-Fi connection before installation'
  if fleet-wifi-ready; then
    note 'Wi-Fi preflight ready'
  else
    network_status=$?
    note "network preflight exited $network_status; no disk changes"
    exit "$network_status"
  fi
fi
live_step approval

# The optional enrollment token lets Fleet approve this node without a person.
# It comes from the private handoff initrd (in-place conversion), a FLEET-KEY
# volume (USB) or FLEET_ENROLL_TOKEN (a manual run), never from the kernel
# command line. It stays beside this live boot's node credential, never printed.
enroll_dir=${FLEET_ENROLLED_DIR:-/run/fleet-enrolled}
token_file=$enroll_dir/enrollment-token
install -d -m 0700 "$enroll_dir"
token_source=""
token=${FLEET_ENROLL_TOKEN:-}
handoff_token=${FLEET_ENROLLMENT_HANDOFF:-/run/fleet-enrollment/token}
if [ -n "$token" ]; then
  token_source=environment
elif [ -s "$handoff_token" ]; then
  read -r token < "$handoff_token" || true
  token_source='the private handoff'
elif [ -n "$key_dir" ] && [ -s "$key_dir/enrollment.token" ]; then
  read -r token < "$key_dir/enrollment.token" || true
  token_source='the FLEET-KEY volume'
fi
if [ -n "$token_source" ]; then
  # Bash regular expressions cap a repetition at 255; check the length apart.
  token_pattern='^[A-Za-z0-9._-]+$'
  if [[ ! "$token" =~ $token_pattern ]] || [ "${#token}" -lt 8 ] || [ "${#token}" -gt 512 ]; then
    unset token
    note "enrollment token from $token_source is malformed; nothing wiped"
    echo "Next: the enrollment token from $token_source is malformed (8 to 512 letters, digits, '.', '_' or '-'). Replace it, or remove it and approve this computer in the Fleet app. Nothing was wiped." >&2
    exit 2
  fi
  ( umask 077; printf '%s\n' "$token" > "$token_file.new" )
  mv "$token_file.new" "$token_file"
  note "enrollment token: from $token_source"
else
  rm -f "$token_file"
  note 'enrollment token: none; a person approves this node in the Fleet app'
fi
unset token

manifest=${FLEET_MANIFEST:-/iso/fleet-install-manifest}
if [ ! -f "$manifest" ]; then
  echo 'fleet-install: no Fleet system on this boot.' >&2
  echo 'Boot the USB image from the Fleet workflow artifact. A netboot ramdisk does not carry it.' >&2
  exit 1
fi

toplevel=$(awk '$1 == "base" { print $2 }' "$manifest")
disko=$(awk '$1 == "disko" { print $2 }' "$manifest")
if [ -z "$toplevel" ] || [ ! -d "$toplevel" ]; then
  echo 'fleet-install: the base system is not on this image. Download the current Fleet installer.' >&2
  exit 1
fi
if [ -z "$disko" ] || [ ! -x "$disko" ]; then
  echo 'fleet-install: disko script is missing on this image' >&2
  exit 1
fi

# A fleet that follows a private Git repository (bootstrap.json repoAuth "ssh"
# or "token") needs its read credential on the node: base has no SOPS secrets.
# It comes from FLEET_GIT_CREDENTIAL_FILE (a manual run), the private handoff
# initrd (in-place conversion) or a FLEET-KEY volume (git-read-key or
# git-read-token), never from the kernel command line, and is never printed.
# Without a matching one, nothing is erased.
git_staged=$enroll_dir/git-credential
rm -f "$git_staged"
refuse_git() {
  printf '%s\n' "$1" > "$log.diagnostic"
  printf '%s\n' "$1" >&2
  note "${1%%:*}: refused; nothing wiped"
  exit 2
}
repo_auth=$(python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        value = json.load(handle).get("repoAuth", "none")
except (OSError, ValueError, AttributeError):
    value = "none"  # fleet-bootstrap-ready reports a missing or broken file
print(value if value in ("none", "ssh", "token") else "invalid")
' "$toplevel/etc/fleet/bootstrap.json")
if [ "$repo_auth" = invalid ]; then
  refuse_git 'FLEET_METADATA_INVALID: the installer bootstrap metadata names an unknown repo.auth. Download the current Fleet installer. Nothing was wiped.'
fi
git_source=""
git_path=""
git_named=""
handoff_git=${FLEET_GIT_CREDENTIAL_HANDOFF:-/run/fleet-git-credential/credential}
if [ -n "${FLEET_GIT_CREDENTIAL_FILE:-}" ]; then
  git_path=$FLEET_GIT_CREDENTIAL_FILE
  git_source=environment
elif [ -s "$handoff_git" ]; then
  git_path=$handoff_git
  git_source='the private handoff'
elif [ -n "$key_dir" ]; then
  # Prefer the kind this fleet uses; the other kind is refused below.
  if [ "$repo_auth" = token ]; then names='git-read-token git-read-key'; else names='git-read-key git-read-token'; fi
  for name in $names; do
    if [ -s "$key_dir/$name" ]; then
      git_path=$key_dir/$name
      git_named=token
      if [ "$name" = git-read-key ]; then git_named=ssh; fi
      git_source='the FLEET-KEY volume'
      break
    fi
  done
fi
if [ -n "$git_source" ] && [ "$repo_auth" = none ]; then
  note "git read credential: from $git_source ignored; this fleet's repository is public (repo.auth = none)"
elif [ -n "$git_source" ]; then
  # Validated and normalized by Python; it prints only the kind, never the value.
  git_kind=$( umask 077; python3 -c '
import re, sys
TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{8,1024}")
LINE = re.compile(r"[A-Za-z0-9+/=]+")
BEGIN, END = "-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----"
try:
    with open(sys.argv[1], "rb") as handle:
        raw = handle.read(16 * 1024 + 1)
    text = raw.decode("ascii")
except (OSError, UnicodeDecodeError):
    sys.exit(1)
if len(raw) > 16 * 1024:
    sys.exit(1)
stripped = text.strip()
lines = stripped.replace("\r\n", "\n").split("\n")
if TOKEN.fullmatch(stripped):
    kind, body = "token", stripped + "\n"
elif len(lines) >= 3 and lines[0] == BEGIN and lines[-1] == END and all(LINE.fullmatch(line) for line in lines[1:-1]):
    kind, body = "ssh", "\n".join(lines) + "\n"
else:
    sys.exit(1)
with open(sys.argv[2], "w", encoding="ascii") as handle:
    handle.write(body)
print(kind)
' "$git_path" "$git_staged.new" 2>/dev/null ) || git_kind=""
  if [ -z "$git_kind" ]; then
    rm -f "$git_staged.new"
    refuse_git "FLEET_GIT_CREDENTIAL_INVALID: the Git read credential from $git_source is malformed (one token line of 8 to 1024 letters, digits or '._~+/=-', or one OpenSSH private key of at most 16 KiB). Replace it. Nothing was wiped."
  fi
  if [ -n "$git_named" ] && [ "$git_named" != "$git_kind" ]; then
    # git-read-key must hold a key and git-read-token a token.
    git_kind=$git_named-mismatch
  fi
  if [ "$git_kind" != "$repo_auth" ]; then
    rm -f "$git_staged.new"
    refuse_git "FLEET_GIT_CREDENTIAL_WRONG_KIND: this fleet follows a private repository (repo.auth = $repo_auth), but the Git read credential from $git_source is not of that kind. Supply its $repo_auth read credential with --git-credential-file or a FLEET-KEY volume. Nothing was wiped."
  fi
  mv "$git_staged.new" "$git_staged"
  note "git read credential: $git_kind from $git_source"
fi
if [ "$repo_auth" != none ] && [ ! -s "$git_staged" ]; then
  refuse_git "FLEET_GIT_CREDENTIAL_MISSING: this fleet follows a private repository (repo.auth = $repo_auth). Supply its read credential with --git-credential-file or a FLEET-KEY volume."
fi

select_disk=${FLEET_SELECT_DISK:-select-disk}
ssh_keygen=${FLEET_SSH_KEYGEN:-ssh-keygen}
nixos_install=${FLEET_NIXOS_INSTALL:-nixos-install}
mnt=${FLEET_MNT:-/mnt}
recorded=${FLEET_RECORDED:-/run/fleet-install-disk}

live_step checks
if command -v fleet-bootstrap-ready >/dev/null 2>&1; then
  note 'checking platform configuration, the update source and Fleet approval before disk changes'
  if fleet-bootstrap-ready "$toplevel" "$token_file" 2> "$log.diagnostic"; then
    rm -f "$log.diagnostic"
    note 'integration preflight passed'
    if command -v fleet-bootstrap-report >/dev/null 2>&1; then
      fleet-bootstrap-report "$toplevel" "$token_file" 'installation in progress' "$$" &
      report_pid=$!
    fi
  else
    status=$?
    # The preflight helper emits public error codes only, never a credential.
    # Retain its bounded diagnostic for the offline QR and log.
    head -c 2048 "$log.diagnostic" >&2
    head -c 2048 "$log.diagnostic" >> "$log"
    note "integration preflight exited $status; no disk changes"
    exit "$status"
  fi
fi

live_step disk
device=$("$select_disk")
[[ "$device" =~ ^/dev/[A-Za-z0-9._/:-]+$ ]] || {
  echo 'select-disk returned an unexpected path' >&2
  exit 2
}
install -d -m 0755 "$(dirname "$recorded")"
printf '%s\n' "$device" > "$recorded"
again=$("$select_disk")
[ "$again" = "$device" ] || {
  echo 'Disk selection changed. Nothing was wiped.' >&2
  exit 1
}

note "disk=$device auto=${FLEET_AUTO:-0}"
echo 'Installing: the Fleet base system (its role is assigned in Fleet afterwards)' >&2
echo "Disk: $device" >&2
if [ "${FLEET_AUTO:-}" = 1 ]; then
  echo 'Wiping that disk. Any Windows or Linux on it is erased.' >&2
else
  if [ ! -t 0 ]; then
    echo 'Refusing to wipe a disk without a terminal. Nothing was wiped.' >&2
    exit 2
  fi
  echo 'This erases that disk, including Windows or any other OS.' >&2
  echo 'Type the disk path to continue:' >&2
  read -r answer
  [ "$answer" = "$device" ] || {
    echo 'Disk path did not match. Nothing was changed.' >&2
    exit 1
  }
fi

live_step erase
touch "${FLEET_INSTALL_LOG:-/run/fleet-install.log}.erasing"
note "partitioning with disko"
"$disko"
note "disko done"
live_step install

if command -v fleet-wifi-persist >/dev/null 2>&1; then
  fleet-wifi-persist "$mnt"
  note 'private Wi-Fi settings preserved for first boot'
fi

if [ -s "$token_file" ]; then
  install -d -m 0700 "$mnt/nix/fleet-state/agent"
  install -m 0600 "$token_file" "$mnt/nix/fleet-state/agent/enrollment-token"
  cmp -s "$token_file" "$mnt/nix/fleet-state/agent/enrollment-token" || {
    echo 'FLEET-FAIL: the installed enrollment token did not read back correctly.' >&2
    exit 1
  }
  note 'enrollment token: installed'
fi

# The node reads its Git read credential from this fixed path (repo.auth).
if [ -s "$git_staged" ]; then
  git_name=git-read-key
  if [ "$repo_auth" = token ]; then git_name=git-read-token; fi
  install -d -m 0700 "$mnt/nix/fleet-state/secrets"
  install -m 0600 "$git_staged" "$mnt/nix/fleet-state/secrets/$git_name"
  cmp -s "$git_staged" "$mnt/nix/fleet-state/secrets/$git_name" || {
    echo 'FLEET-FAIL: the installed Git read credential did not read back correctly.' >&2
    exit 1
  }
  rm -f "$git_staged"
  note "git read credential: installed as $git_name"
fi

node_secret=$enroll_dir/agent/node.secret
if [ -f "$node_secret" ]; then
  install -d -m 0700 "$mnt/nix/fleet-state/agent"
  install -m 0600 "$node_secret" "$mnt/nix/fleet-state/agent/node.secret"
  cmp -s "$node_secret" "$mnt/nix/fleet-state/agent/node.secret" || {
    echo 'FLEET-FAIL: the Fleet registration credential did not read back correctly.' >&2
    exit 1
  }
fi

ssh_dir=$mnt/nix/fleet-state/ssh
install -d -m 0700 "$ssh_dir"
if [ ! -s "$ssh_dir/ssh_host_ed25519_key" ]; then
  "$ssh_keygen" -t ed25519 -N "" -f "$ssh_dir/ssh_host_ed25519_key"
  chmod 0600 "$ssh_dir/ssh_host_ed25519_key"
fi

note "nixos-install of $toplevel"
"$nixos_install" --no-root-passwd --root "$mnt" --system "$toplevel"
note "nixos-install done"

# A finished install. A later run of the node program sees this and does not wipe again.
printf 'status=installed\n' > "$mnt/nix/fleet-state/installed"
chmod 0644 "$mnt/nix/fleet-state/installed"

note 'installed the Fleet base system'
install -d -m 0700 "$mnt/nix/fleet-state/logs"
install -m 0600 "$log" "$mnt/nix/fleet-state/logs/install.log" 2>/dev/null || true

echo 'installed the Fleet base system' >&2
if [ -s "$ssh_dir/ssh_host_ed25519_key.pub" ]; then
  "$ssh_keygen" -lf "$ssh_dir/ssh_host_ed25519_key.pub" >&2
fi
echo 'Remove the USB and reboot. The node console then shows its status and its SSH fingerprint. Assign its role in the Fleet app.' >&2
