#!/usr/bin/env bash
# Install one role from the live image. The USB ISO that CI built already
# contains every installer role in roles.json. This machine picks the disk, generates
# the age key, and installs. No work computer, Nix build, or SSH key is required.
# FLEET_ALLOW_UNPRIVILEGED=1 is a unit-test seam. A real install is root.
set -euo pipefail

# The installer roles in roles.json; rewritten by scripts/fleet_roles.py sync.
installer_roles=(ci devbox)
is_installer_role() {
  local candidate
  for candidate in "${installer_roles[@]}"; do
    [ "$candidate" = "$1" ] && return 0
  done
  return 1
}

if [ "$(id -u)" -ne 0 ] && [ "${FLEET_ALLOW_UNPRIVILEGED:-}" != 1 ]; then
  exec sudo -n --preserve-env=FLEET_AUTO,FLEET_ROLE,FLEET_CMDLINE,FLEET_KEY_DIR,FLEET_MANIFEST,FLEET_ENROLL_TOKEN,FLEET_VAULT_ADDR,FLEET_DEVBOX_SSH_KEY_FILE,FLEET_LIVE,FLEET_LIVE_STATE -- "$0" "$@"
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
  if [ -n "${toplevel:-}" ] && [ -n "${api_token_file:-}" ] && command -v fleet-bootstrap-report >/dev/null 2>&1; then
    fleet-bootstrap-report "$toplevel" "$role" "$api_token_file" "FLEET_INSTALL_FAILED: installer exited $1 at line $2. Review this node's installation event and copy its diagnostic report." || true
  fi
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

if [ "${FLEET_ALLOW_UNPRIVILEGED:-}" != 1 ]; then
  if [ "$(uname -m)" != x86_64 ] || [ ! -d /sys/firmware/efi ]; then
    echo 'Next: this installer requires x86-64 hardware booted in UEFI mode. Enable UEFI and disable legacy/CSM boot. Nothing was wiped.' >&2
    exit 2
  fi
fi

usage() {
  echo "usage: fleet-install $(IFS='|'; echo "${installer_roles[*]}")" >&2
  echo 'The boot menu sets fleet.role= and the image installs that role.' >&2
  echo 'ci-gpu is not on this image.' >&2
}

# The last fleet.role= wins. A specialisation appends its role after the
# default, and both end up on the kernel command line.
role_from_cmdline() {
  local file=$1
  [ -r "$file" ] || return 0
  awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^fleet\.role=/) {
          value = $i
          sub(/^fleet\.role=/, "", value)
          last = value
        }
      }
    }
    END { printf "%s", last }
  ' "$file"
}

role=${1:-}
if [ -z "$role" ]; then
  role=${FLEET_ROLE:-}
fi
if [ -z "$role" ]; then
  role=$(role_from_cmdline "${FLEET_CMDLINE:-/proc/cmdline}")
fi
if [ "$role" = ci-gpu ]; then
  echo "ci-gpu is not on the shared installer image. This image has: ${installer_roles[*]}." >&2
  exit 2
fi
if ! is_installer_role "$role"; then
  usage
  exit 2
fi

key_dir=${FLEET_KEY_DIR:-}
mounted_key=0
verified_age_key=""
cleanup() {
  stop_reporter
  if [ -n "$verified_age_key" ]; then
    rm -f "$verified_age_key"
  fi
  if [ "$mounted_key" -eq 1 ]; then
    umount "$key_dir" || true
  fi
}
trap cleanup EXIT

if [ -z "${FLEET_KEY_DIR:-}" ] && [ -e /dev/disk/by-label/FLEET-KEY ]; then
  key_dir=$(mktemp -d)
  mount /dev/disk/by-label/FLEET-KEY "$key_dir"
  mounted_key=1
fi

if [ -n "$key_dir" ] && [ -d "$key_dir" ]; then
  roles=("${installer_roles[@]}")
  for ((i = 0; i < ${#roles[@]}; i++)); do
    for ((j = i + 1; j < ${#roles[@]}; j++)); do
      left=$key_dir/${roles[$i]}.age
      right=$key_dir/${roles[$j]}.age
      if [ -f "$left" ] && [ -f "$right" ] && cmp -s "$left" "$right"; then
        echo "Role age keys must differ: ${roles[$i]} and ${roles[$j]}" >&2
        exit 2
      fi
      if [ -f "$left" ] && [ -f "$right" ]; then
        # Comments do not change an identity. Compare the actual recipients,
        # not just private-key file bytes, before any disk is touched.
        if ! left_pub=$("${FLEET_AGE_KEYGEN:-age-keygen}" -y "$left" 2>/dev/null) \
          || ! right_pub=$("${FLEET_AGE_KEYGEN:-age-keygen}" -y "$right" 2>/dev/null) \
          || [[ ! "$left_pub" =~ ^age1[0-9a-z]+$ || ! "$right_pub" =~ ^age1[0-9a-z]+$ ]]; then
          echo "Next: each FLEET-KEY role file must contain one valid age identity. Check $left and $right. Nothing was wiped." >&2
          exit 2
        fi
        if [ "$left_pub" = "$right_pub" ]; then
          echo "Role age keys must differ: ${roles[$i]} and ${roles[$j]} have the same recipient" >&2
          exit 2
        fi
      fi
    done
  done
fi

# fleet.enroll= is a single-use Vault wrapping token that holds this role's age
# key. It is unwrapped before the disk is touched, so a bad or spent token
# leaves every disk as it was. The key is kept on the live tmpfs so a retry in
# the same boot does not need a second token.
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

enrolled=""
# Public identifiers that tie this install to the wizard run that sent it. The
# installed node keeps this log, so its own console report can name them too.
note "handoff from=$(cmdline_value fleet.from) wizard=$(cmdline_value fleet.wizard) attempt=$(cmdline_value fleet.attempt) wifi=$(cmdline_value fleet.wifi)"
live_step network
# Connect with the carried profile before consuming a one-time token or wiping
# anything. The helper never prints passwords or places them in arguments.
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
# Prove SSH access before consuming a token or touching a disk. This public
# key is carried by kexec, a FLEET-KEY volume, or the console for a USB boot.
devbox_key_file=""
if [ "$role" = devbox ]; then
  devbox_key_file=$(mktemp)
  if [ -n "${FLEET_DEVBOX_SSH_KEY_FILE:-}" ]; then
    cat "$FLEET_DEVBOX_SSH_KEY_FILE" > "$devbox_key_file"
  elif [ -n "$key_dir" ] && [ -f "$key_dir/devbox.pub" ]; then
    cat "$key_dir/devbox.pub" > "$devbox_key_file"
  elif [ -n "$(cmdline_value fleet.ssh)" ]; then
    python3 -I -c 'import base64,sys; print(base64.b64decode(sys.argv[1], altchars=b"-_", validate=True).decode())' "$(cmdline_value fleet.ssh)" > "$devbox_key_file"
  elif [ -r /dev/tty ] && [ -t 0 ]; then
    echo 'Remote devbox: paste ONE SSH public key from your .pub file (never a private key):' >&2
    read -r public_key
    printf '%s\n' "$public_key" > "$devbox_key_file"
    unset public_key
  elif [ "${FLEET_AUTO:-}" = 1 ] && [ -c /dev/console ]; then
    echo 'Remote devbox: paste ONE SSH public key from your .pub file (never a private key):' > /dev/console
    read -r public_key < /dev/console
    printf '%s\n' "$public_key" > "$devbox_key_file"
    unset public_key
  fi
  if ! python3 -I -c '
import base64,sys
parts=open(sys.argv[1]).read().strip().split()
if len(parts)<2 or parts[0] not in ("ssh-ed25519","ssh-rsa","ecdsa-sha2-nistp256","ecdsa-sha2-nistp384","ecdsa-sha2-nistp521"): raise ValueError("public key type")
wire=base64.b64decode(parts[1],validate=True)
if wire[4:4+int.from_bytes(wire[:4],"big")]!=parts[0].encode(): raise ValueError("public key wire type")
open(sys.argv[1],"w").write(" ".join(parts[:2])+"\n")
' "$devbox_key_file" 2>/dev/null || ! "${FLEET_SSH_KEYGEN:-ssh-keygen}" -lf "$devbox_key_file" >/dev/null 2>&1; then
    rm -f "$devbox_key_file"
    echo 'Next: a valid SSH public key is required for a devbox. Nothing was wiped. Use your .pub file in the wizard, or devbox.pub on a FLEET-KEY volume.' >&2
    exit 2
  fi
fi
if [ -z "$key_dir" ] || [ ! -f "$key_dir/$role.age" ]; then
  enroll_dir=${FLEET_ENROLLED_DIR:-/run/fleet-enrolled}
  retained=$enroll_dir/$role.age
  token=${FLEET_ENROLL_TOKEN:-$(cmdline_value fleet.enroll)}
  if [ -s "$retained" ]; then
    enrolled=$retained
  elif [ -n "$token" ]; then
    vault=${FLEET_VAULT_ADDR:-$(cmdline_value fleet.vault)}
    vault=${vault:-${FLEET_VAULT_ADDR:-}}
    [ -n "$vault" ] || { echo "FLEET_VAULT_ADDR is required for wrapped enrollment" >&2; exit 1; }
    curl_bin=${FLEET_CURL:-curl}
    install -d -m 0700 "$enroll_dir"
    header=$(mktemp "$enroll_dir/header.XXXXXX")
    printf 'X-Vault-Token: %s\n' "$token" > "$header"
    reply=$(mktemp "$enroll_dir/reply.XXXXXX")
    if ! "$curl_bin" -fsS --max-time 30 -X POST -H "@$header" -o "$reply" "$vault/v1/sys/wrapping/unwrap" 2>/dev/null; then
      rm -f "$header" "$reply"
      note 'enrollment token refused, expired, or Vault unreachable; nothing wiped'
      echo 'Next: the enrollment token was refused or expired, or Vault is unreachable. Nothing was wiped. Mint a new single-use token and run this program again.' >&2
      exit 1
    fi
    rm -f "$header"
    key=$(python3 -I -c '
import json, sys
data = json.load(open(sys.argv[1])).get("data") or {}
data = data.get("data") if isinstance(data.get("data"), dict) else data
key = str(data.get("age_key") or "").strip()
print(key if key.startswith("AGE-SECRET-KEY-") and key.isprintable() and " " not in key else "")
' "$reply" 2>/dev/null || true)
    # Optional: the role token that lets this node register with the fleet API
    # without a person. A document without it is fine. Never printed or logged.
    api_token=$(python3 -I -c '
import json, re, sys
data = json.load(open(sys.argv[1])).get("data") or {}
data = data.get("data") if isinstance(data.get("data"), dict) else data
token = data.get("api_token")
print(token if isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9._-]{8,512}", token) else "")
' "$reply" 2>/dev/null || true)
    rm -f "$reply"
    if [ -n "$api_token" ]; then
      ( umask 077; printf '%s\n' "$api_token" > "$enroll_dir/$role.api" )
    fi
    unset api_token
    if [ -z "$key" ]; then
      note "enrollment token held no age key for $role; nothing wiped"
      echo "Next: the enrollment token did not hold an age key for $role. Nothing was wiped." >&2
      exit 1
    fi
    ( umask 077; printf '%s\n' "$key" > "$retained" )
    unset key
    enrolled=$retained
  fi
  unset token
fi

# Kept next to the unwrapped key, so a retry in the same boot reuses it.
api_token_file=${FLEET_ENROLLED_DIR:-/run/fleet-enrolled}/$role.api

manifest=${FLEET_MANIFEST:-/iso/fleet-install-manifest}
if [ ! -f "$manifest" ]; then
  echo 'fleet-install: no role systems on this boot.' >&2
  echo 'Boot the USB image from the Fleet workflow artifact. A netboot ramdisk does not carry them.' >&2
  exit 1
fi

toplevel=$(awk -v role="$role" '$1 == role { print $2 }' "$manifest")
disko=$(awk '$1 == "disko" { print $2 }' "$manifest")
if [ -z "$toplevel" ] || [ ! -d "$toplevel" ]; then
  echo "fleet-install: $role is not a directory on this image" >&2
  exit 1
fi
if [ -z "$disko" ] || [ ! -x "$disko" ]; then
  echo 'fleet-install: disko script is missing on this image' >&2
  exit 1
fi

select_disk=${FLEET_SELECT_DISK:-select-disk}
age_keygen=${FLEET_AGE_KEYGEN:-age-keygen}
ssh_keygen=${FLEET_SSH_KEYGEN:-ssh-keygen}
nixos_install=${FLEET_NIXOS_INSTALL:-nixos-install}
mnt=${FLEET_MNT:-/mnt}
recorded=${FLEET_RECORDED:-/run/fleet-install-disk}

source_age_key=""
age_origin=""
if [ -n "$key_dir" ] && [ -f "$key_dir/$role.age" ]; then
  source_age_key=$key_dir/$role.age
  age_origin="the FLEET-KEY volume"
elif [ -n "$enrolled" ]; then
  source_age_key=$enrolled
  age_origin="the enrollment token"
fi
if [ -n "$source_age_key" ]; then
  # Validate a stable snapshot on the live filesystem. A bad key, or removing
  # the key USB during installation, must not strand an already erased node.
  verified_age_key=$(mktemp)
  install -m 0600 "$source_age_key" "$verified_age_key"
  if ! recipient=$("$age_keygen" -y "$verified_age_key" 2>/dev/null) || [[ ! "$recipient" =~ ^age1[0-9a-z]+$ ]]; then
    if [ "$age_origin" = "the enrollment token" ]; then rm -f "$enrolled"; fi
    note 'invalid supplied age identity; nothing wiped'
    echo "Next: the age key from $age_origin is invalid. Replace the FLEET-KEY role key, or fix the vault input and mint a fresh enrollment token. Nothing was wiped." >&2
    exit 2
  fi
fi

live_step checks
if command -v fleet-bootstrap-ready >/dev/null 2>&1; then
  note 'checking platform configuration, role secrets, GitHub registration and automatic Fleet approval before disk changes'
  if fleet-bootstrap-ready "$toplevel" "$role" "$verified_age_key" "$api_token_file" 2> "$log.diagnostic"; then
    rm -f "$log.diagnostic"
    note 'integration preflight passed'
    if command -v fleet-bootstrap-report >/dev/null 2>&1; then
      fleet-bootstrap-report "$toplevel" "$role" "$api_token_file" 'installation in progress' "$$" &
      report_pid=$!
    fi
  else
    status=$?
    # The preflight helper emits public error codes only, never decrypted
    # values. Retain its bounded diagnostic for the offline QR and log.
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

note "role=$role disk=$device auto=${FLEET_AUTO:-0}"
echo "Role: $role" >&2
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

if [ "$role" = devbox ]; then
  install -d -m 0700 "$mnt/nix/fleet-state/devbox"
  install -m 0600 "$devbox_key_file" "$mnt/nix/fleet-state/devbox/authorized_keys"
  cmp -s "$devbox_key_file" "$mnt/nix/fleet-state/devbox/authorized_keys" || {
    echo 'FLEET-FAIL: the installed devbox SSH public key did not read back correctly.' >&2
    exit 1
  }
  rm -f "$devbox_key_file"
  note 'devbox SSH access: validated and installed for user dev'
fi

secret=$mnt/nix/fleet-state/secrets
install -d -m 0700 "$secret"
dest=$secret/age.key
if [ -n "$verified_age_key" ]; then
  note "age key: from $age_origin"
  install -m 0600 "$verified_age_key" "$dest"
  cmp -s "$verified_age_key" "$dest" || {
    echo 'FLEET-FAIL: the installed age key did not read back correctly.' >&2
    exit 1
  }
else
  note "age key: generated on this machine (no token, no FLEET-KEY volume)"
  "$age_keygen" -o "$dest"
  chmod 0600 "$dest"
  if [ -n "$key_dir" ]; then
    install -d -m 0700 "$key_dir"
    install -m 0600 "$dest" "$key_dir/$role.age"
  fi
fi
pub=$("$age_keygen" -y "$dest")
printf '%s\n' "$pub" > "$secret/age.pub"
chmod 0644 "$secret/age.pub"

if [ -s "$api_token_file" ]; then
  api_token=""
  read -r api_token < "$api_token_file" || true
  api_token_pattern='^[A-Za-z0-9._-]+$'
  if [[ "$api_token" =~ $api_token_pattern ]] && [ "${#api_token}" -ge 8 ] && [ "${#api_token}" -le 512 ]; then
    install -d -m 0700 "$mnt/nix/fleet-state/agent"
    ( umask 077; printf '%s\n' "$api_token" > "$mnt/nix/fleet-state/agent/role-token.new" )
    mv "$mnt/nix/fleet-state/agent/role-token.new" "$mnt/nix/fleet-state/agent/role-token"
    cmp -s "$api_token_file" "$mnt/nix/fleet-state/agent/role-token" || {
      echo 'FLEET-FAIL: the installed fleet API role token did not read back correctly.' >&2
      exit 1
    }
    note 'fleet API role token: installed'
  else
    note 'fleet API role token: ignored (not a valid token)'
  fi
  unset api_token
fi

node_secret=${FLEET_ENROLLED_DIR:-/run/fleet-enrolled}/$role.agent/node.secret
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
printf 'role=%s\nstatus=installed\n' "$role" > "$mnt/nix/fleet-state/installed"
chmod 0644 "$mnt/nix/fleet-state/installed"

note "installed role=$role"
install -d -m 0700 "$mnt/nix/fleet-state/logs"
install -m 0600 "$log" "$mnt/nix/fleet-state/logs/install.log" 2>/dev/null || true

echo "installed role=$role" >&2
echo 'age public key:' >&2
printf '%s\n' "$pub" >&2
if [ -s "$ssh_dir/ssh_host_ed25519_key.pub" ]; then
  "$ssh_keygen" -lf "$ssh_dir/ssh_host_ed25519_key.pub" >&2
fi
echo 'Remove the USB and reboot. The node console then shows its status, its age public key and its SSH fingerprint.' >&2
