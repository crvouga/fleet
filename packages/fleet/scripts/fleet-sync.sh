#!/usr/bin/env bash
# Converge this node to its assigned closure (ARCHITECTURE.md).
# The target is /nix/fleet-state/target (written by fleet-agent from the
# controller's desired state, or by fleet-target in local mode); without it,
# the running image's own ROLE/FLAKE_ATTR. Fetch origin/main, refuse a target
# the fetched roles.json does not define or whose secrets this node cannot
# decrypt, build it with bounded local jobs and switch to it.
# A kernel, initrd, module or role change drains first, then waits, then
# reboots. A failed build, a failed drain or a refused target leaves the
# running generation in place. The timer retries.
# After a switch, the node must still reach the binary cache and the sync unit
# must still load. A failed check restores the previous generation and does
# not reboot. Every run ends by writing /run/fleet/reconcile.json, which the
# agent reports as the node's convergence phase.
set -euo pipefail

env_file=${SYNC_ENV:-/etc/fleet/sync.env}
# shellcheck disable=SC1090
source "$env_file"

: "${ROLE:?}"
: "${FLAKE_ATTR:?}"
: "${BRANCH:?}"
: "${REPO_URL:?}"
: "${FLAKE_DIR:?}"
: "${DELAY_MAX:?}"

role_pattern='^[a-z][a-z0-9]{0,15}$'
attr_pattern='^[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,16}){0,4}$'

# ---- convergence verdict (/run/fleet/reconcile.json) -------------------------
# Written on every exit. phase is converged, progressing or blocked; issues are
# public sentences that tell a person what blocks convergence.
reconcile_path=${RECONCILE:-/run/fleet/reconcile.json}
reconcile_phase=""
reconcile_issues=()
record_success=1
set_phase() {
  reconcile_phase=$1
  shift
  reconcile_issues=("$@")
}
write_reconcile() {
  local phase=$1
  shift
  "${PYTHON:-python3}" - "$reconcile_path" "$phase" "${ROLE:-}" "${FLAKE_ATTR:-}" "${revision:-}" "$@" <<'RECONCILE' \
    || echo 'sync: could not write the convergence verdict' >&2
import json, os, sys, tempfile, time
path, phase, role, closure, revision, *issues = sys.argv[1:]
issues = [" ".join(issue.split()) for issue in issues]
issues = [issue if len(issue) <= 500 else issue[:497] + "..." for issue in issues if issue][:8]
record = {"phase": phase, "issues": issues, "role": role or None, "closure": closure or None,
          "revision": revision or None, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
folder = os.path.dirname(path) or "."
os.makedirs(folder, mode=0o755, exist_ok=True)
fd, temporary = tempfile.mkstemp(dir=folder, prefix=".reconcile-")
with os.fdopen(fd, "w") as stream:
    json.dump(record, stream)
os.chmod(temporary, 0o644)
os.replace(temporary, path)
RECONCILE
}
# The verdict for an exit that did not name one: a failure blocks with its
# reason; anything else is still on its way.
finish_reconcile() {
  local status=$1 phase=$reconcile_phase
  local issues=(${reconcile_issues[@]+"${reconcile_issues[@]}"})
  if [ -z "$phase" ]; then
    if [ "$status" -ne 0 ]; then
      phase=blocked
      local reason=${failure_reason:-the update failed}
      case "$reason" in
        FLEET_*) issues=("$reason") ;;
        *) issues=("FLEET_UPDATE_FAILED: $reason. The running system is unchanged; the next poll retries.") ;;
      esac
    else
      phase=progressing
    fi
  fi
  write_reconcile "$phase" ${issues[@]+"${issues[@]}"}
}
trap 'finish_reconcile $?' EXIT

# ---- what this node runs and what it should run -------------------------------
# The running system's own identity: node.conf of /etc, else its sync.env.
running_role=$ROLE
running_attr=$FLAKE_ATTR
node_conf=${NODE_CONF:-/etc/fleet/node.conf}
if [ -r "$node_conf" ]; then
  while IFS='=' read -r name value; do
    case "$name" in
      role) [[ "$value" =~ $role_pattern ]] && running_role=$value ;;
      flake_attr) [[ "$value" =~ $attr_pattern ]] && running_attr=$value ;;
    esac
  done < "$node_conf"
fi
# The assigned target. It is data: a role name and a flake attribute, checked
# here by shape and below against the fetched roles.json. A malformed file is
# ignored, never half used.
target_file=${TARGET:-/nix/fleet-state/target}
read_target() {
  local line role="" closure="" count=0
  while IFS= read -r line || [ -n "$line" ]; do
    count=$((count + 1))
    if [ "$count" -gt 4 ]; then
      echo 'it has more than two settings'
      return 1
    fi
    case "$line" in
      role=*) role=${line#role=} ;;
      closure=*) closure=${line#closure=} ;;
      "") ;;
      *) echo 'it holds a line that is neither role= nor closure='; return 1 ;;
    esac
  done < "$target_file"
  if ! [[ "$role" =~ $role_pattern ]]; then
    echo 'its role is not a lowercase role name or base'
    return 1
  fi
  if ! [[ "$closure" =~ $attr_pattern ]]; then
    echo 'its closure is not a flake attribute name'
    return 1
  fi
  printf '%s %s\n' "$role" "$closure"
}
if [ -e "$target_file" ]; then
  if parsed=$(read_target 2>/dev/null); then
    ROLE=${parsed% *}
    FLAKE_ATTR=${parsed#* }
  else
    echo "sync: ignoring $target_file because ${parsed:-it cannot be read}; using this image's role $ROLE ($FLAKE_ATTR)" >&2
  fi
fi
role_change=0
if [ "$ROLE" != "$running_role" ]; then
  role_change=1
  echo "sync: assigned role $ROLE ($FLAKE_ATTR) differs from the running role $running_role ($running_attr)" >&2
fi

if [[ "$REPO_URL" == *TODO* ]]; then
  echo 'sync: repository URL is not configured; the running system is unchanged' >&2
  set_phase blocked 'FLEET_REPOSITORY_UNCONFIGURED: the Git source for automatic updates is not configured; the running system is unchanged.'
  exit 0
fi

if [ "$BRANCH" != "main" ]; then
  echo 'sync: BRANCH must be main' >&2
  set_phase blocked 'FLEET_UPDATE_FAILED: the update branch must be main.'
  exit 1
fi

# Dynamic settings from the fleet controller (scripts/fleetconf.py). The fleet works
# without them: a missing or unreadable setting gives the value built into this
# image, and a failing reader never stops a sync.
conf() {
  local value
  if [ -n "${FLEETCONF:-}" ] && value=$("$FLEETCONF" get "$1" "$2" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$2"
  fi
}

if [ "$(conf sync.paused false)" = true ]; then
  echo 'sync: paused by the fleet configuration (sync.paused); the running system is unchanged' >&2
  set_phase blocked 'FLEET_UPDATES_PAUSED: automatic updates are paused in Fleet settings (sync.paused); the node does not converge until they are resumed.'
  exit 0
fi

reboot_disabled=0
if [ "$(conf reboot.enabled true)" = false ]; then
  reboot_disabled=1
fi
delay_max=$(conf reboot.delayMaxSeconds "$DELAY_MAX")
case "$delay_max" in
  ""|*[!0-9]*) delay_max=$DELAY_MAX ;;
esac
DELAY_MAX=$delay_max

nix=${FLEET_NIX:-nix}
nix_env=${FLEET_NIX_ENV:-nix-env}
systemctl=${FLEET_SYSTEMCTL:-systemctl}
git=${FLEET_GIT:-git}
profile=${FLEET_PROFILE:-/nix/var/nix/profiles/system}
booted=${BOOTED_SYSTEM:-/run/booted-system}
state_dir=${STATE_DIR:-/nix/fleet-state/sync}
repo=$state_dir/repo
branch=$BRANCH

install -d -m 0700 "$state_dir"
# Share one open-file-description lock with our children. A power loss releases
# it automatically; another invocation cannot race a live Git/activation step.
exec 9>"$state_dir/update.lock"
if "${PYTHON:?}" - <<'PY'
import fcntl,sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)
PY
then
  :
else
  status=$?
  if [ "$status" -eq 75 ]; then
    echo 'sync: another update is running; the timer will retry'
    exit 0
  fi
  exit "$status"
fi
# This checkout is only an update cache. With no live writer, Git lock files
# left by an interrupted fetch/checkout are stale and safe to discard.
"${PYTHON:?}" - "$repo/.git" <<'PY'
from pathlib import Path
import sys
for path in Path(sys.argv[1]).rglob('*.lock'):
    if path.is_file():
        path.unlink()
PY
g() {
  if [[ "$REPO_URL" == file:* ]]; then
    "$git" -c "safe.directory=$repo" -c protocol.file.allow=always "$@"
  else
    "$git" -c "safe.directory=$repo" "$@"
  fi
}

if [ ! -d "$repo/.git" ]; then
  g init -q "$repo"
fi

askpass=""
drained=0
reboot_requested=0
failure_reason='could not fetch the configured repository'
reported_failure=0
report_path=${FLEET_REPORT:-/run/fleet/health-failure}
cleanup() {
  local status=$?
  if [ -n "$askpass" ]; then
    rm -f "$askpass" || true
  fi
  if [ "$drained" -eq 1 ] && [ "$reboot_requested" -eq 0 ]; then
    rm -f "$(dirname "$report_path")/update-draining"
    echo 'sync: update did not reboot; restoring runner admission and services' >&2
    if [ -z "${RESUME_COMMAND:-}" ] || ! bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$RESUME_COMMAND"; then
      install -d -m 0755 "$(dirname "$report_path")"
      printf 'recover failed sync\n' > "$(dirname "$report_path")/agent-drained"
      echo 'FLEET-FAIL sync: runner recovery failed; fleet-resume must succeed before this node can accept jobs' >&2
      status=1
    fi
  fi
  if [ "$status" -ne 0 ] && [ "$reported_failure" -eq 0 ]; then
    install -d -m 0755 "$(dirname "$report_path")"
    printf 'mode=sync\n%s (exit %s)\n' "$failure_reason" "$status" > "$report_path"
    cp "$report_path" "$state_dir/health-failure"
    echo "FLEET-FAIL sync: $failure_reason (exit $status); the running generation was kept" >&2
  fi
  if [ "$status" -eq 0 ] && [ "$record_success" -eq 1 ]; then
    printf '%s\n' "${revision:-unknown}" > "$state_dir/last-success"
    rm -f "$state_dir/pending-generation"
  fi
  finish_reconcile "$status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A private repository needs the read credential the installer placed at a
# fixed path (modules/sync.nix). Without it no fetch can ever succeed, so say
# exactly that instead of reporting a fetch failure on every poll.
case "${REPO_AUTH:-none}" in
  ssh|token)
    credential_file=${GIT_KEY:-}
    [ "$REPO_AUTH" = token ] && credential_file=${GIT_TOKEN:-}
    if [ -z "$credential_file" ] || [ ! -s "$credential_file" ]; then
      issue="FLEET_GIT_CREDENTIAL_MISSING: this fleet follows a private repository (repo.auth = $REPO_AUTH) and ${credential_file:-the read credential} is missing. Reinstall with --git-credential-file; nodes are stateless."
      echo "sync: $issue" >&2
      set_phase blocked "$issue"
      record_success=0
      exit 0
    fi
    ;;
esac

if [ -n "${GIT_KEY:-}" ] && [ -f "$GIT_KEY" ]; then
  known=${GIT_KNOWN_HOSTS:-/etc/fleet/git-known-hosts}
  quoted_key=$(printf '%q' "$GIT_KEY")
  quoted_known=$(printf '%q' "$known")
  GIT_SSH_COMMAND="ssh -i ${quoted_key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quoted_known}"
  export GIT_SSH_COMMAND
elif [ -n "${GIT_TOKEN:-}" ] && [ -f "$GIT_TOKEN" ]; then
  askpass=$(mktemp)
  chmod 700 "$askpass"
  cat > "$askpass" <<EOF
#!/bin/sh
case "\$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) cat $(printf '%q' "$GIT_TOKEN") ;;
esac
EOF
  chmod 700 "$askpass"
  export GIT_ASKPASS=$askpass
  export GIT_TERMINAL_PROMPT=0
fi

g -C "$repo" remote remove origin 2>/dev/null || true
g -C "$repo" remote add origin "$REPO_URL"
bounded() {
  local duration=$1
  shift
  timeout --kill-after="${FLEET_TIMEOUT_KILL_AFTER:-30}" "$duration" "$@"
}

# ---- kernel quarantine (docs/resilience.md) ----------------------------------
# A kernel update reboots into a counted boot entry. If that system does not
# come up healthy, systemd-boot falls back to the previous one after its tries.
# Without this, the next run saw the old kernel, installed the same failing
# kernel again and rebooted into it: a drain-and-reboot loop that never ended.
# pending-boot records which boot asked for which system. A later boot that is
# running something else fell back: quarantine that kernel, keep the system
# that works, and never reboot into the same kernel again until a new kernel
# arrives or a person asks to retry (sync.retryBootAfter in Fleet).
pending_boot=$state_dir/pending-boot
quarantine_file=$state_dir/quarantine.json
boot_id=$(cat "${FLEET_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}" 2>/dev/null || true)

boot_identity() {
  local system=$1
  printf '%s %s %s' "$(readlink -f "$system/kernel" 2>/dev/null || true)" \
    "$(readlink -f "$system/initrd" 2>/dev/null || true)" \
    "$(readlink -f "$system/kernel-modules" 2>/dev/null || true)"
}

recovery_event() {
  # Best effort: a full disk must not turn a recovery into a failed sync.
  if [ -n "${RECOVERY_PY:-}" ]; then
    "${PYTHON:?}" "$RECOVERY_PY" event "$@" || echo 'sync: could not queue the recovery event' >&2
  fi
}

quarantine_kernel() {
  local system=$1 from_revision=$2 reason=$3
  "${PYTHON:?}" - "$quarantine_file" "$system" "$from_revision" "$(boot_identity "$system")" "$reason" <<'QUARANTINE'
import json, os, sys, tempfile, time
path, system, revision, identity, reason = sys.argv[1:]
record = {"toplevel": system, "revision": revision or None, "boot": identity, "reason": reason,
          "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "atEpoch": int(time.time())}
folder = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(dir=folder, prefix=".quarantine-")
with os.fdopen(fd, "w") as stream:
    json.dump(record, stream)
    stream.flush()
    os.fsync(stream.fileno())
os.replace(temporary, path)
handle = os.open(folder, os.O_RDONLY)
os.fsync(handle)
os.close(handle)
QUARANTINE
  local fingerprint
  fingerprint=$(printf '%s' "$(boot_identity "$system")" | cksum | awk '{print $1}')
  recovery_event update-quarantined error "quarantine:${fingerprint}:${boot_id:-unknown}" \
    "The update to revision ${from_revision:-unknown} did not boot healthily, so the node fell back to the system it was running before. Its kernel is quarantined: the node keeps working on the previous kernel and will not reboot into this one again until a newer kernel is published or Retry the update is pressed in Fleet. ${reason}"
}

# The quarantined boot identity, RETRY when Fleet asked to retry it after it
# was quarantined, or nothing.
quarantined_identity() {
  [ -f "$quarantine_file" ] || return 0
  "${PYTHON:?}" - "$quarantine_file" "$(conf sync.retryBootAfter 0)" <<'QUARANTINE'
import json, sys
try:
    record = json.load(open(sys.argv[1]))
    retry = int(sys.argv[2]) if sys.argv[2].isdigit() else 0
except (OSError, ValueError):
    sys.exit(0)
print("RETRY" if retry > int(record.get("atEpoch") or 0) else record.get("boot") or "")
QUARANTINE
}

detect_fallback() {
  [ -f "$pending_boot" ] || return 0
  local asked_boot="" asked_system="" asked_revision="" now_system
  while IFS='=' read -r name value; do
    case "$name" in
      boot_id) asked_boot=$value ;;
      toplevel) asked_system=$value ;;
      revision) asked_revision=$value ;;
    esac
  done < "$pending_boot"
  # Still the boot that asked for the reboot: nothing has happened yet.
  if [ -z "$asked_boot" ] || [ "$asked_boot" = "$boot_id" ]; then
    return 0
  fi
  now_system=$(readlink -f "$booted" || true)
  if [ "$now_system" = "$asked_system" ]; then
    return 0  # it came up; boot-health removes pending-boot once the boot is blessed
  fi
  echo 'sync: this boot is not running the system the update asked for; quarantining that kernel' >&2
  quarantine_kernel "$asked_system" "$asked_revision" \
    "The cause is not certain: a kernel that cannot start, a system that cannot reach GitHub or the cache in its first boots, and a network outage during those boots all end in the same fallback."
  # Make the system that works the default again, so the next reboot does not
  # select the failing entry either.
  if [ -n "$now_system" ] && [ -x "$now_system/bin/switch-to-configuration" ]; then
    bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$nix_env" -p "$profile" --set "$now_system" || true
    bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$now_system/bin/switch-to-configuration" boot || true
  fi
  rm -f "$pending_boot"
}
detect_fallback
bounded "${FLEET_FETCH_TIMEOUT:-120}" "$git" -c "safe.directory=$repo" -C "$repo" fetch --depth=1 origin "refs/heads/${branch}:refs/remotes/origin/${branch}"
g -C "$repo" checkout --detach --force "refs/remotes/origin/${branch}"

revision=$(g -C "$repo" rev-parse HEAD)
# roles.json at this revision decides what this machine may be. A retired role
# or a removed closure is never published again: report exactly that instead
# of a cache miss on every run. base always exists. A revision without the
# registry predates it.
registry="$repo/$FLAKE_DIR/roles.json"
if [ -f "$registry" ]; then
  if ! placement=$("$PYTHON" -I "${FLEET_ROLES_PY:?}" placement "$registry" "$ROLE" "$FLAKE_ATTR" 2>&1); then
    failure_reason=${placement:-roles.json at this revision could not be read}
    echo "sync: $failure_reason" >&2
    exit 1
  fi
  # Secrets gate: a role whose SOPS file this node cannot decrypt would fail
  # activation. Do not build or switch; tell the operator which recipient to
  # add. The first poll after the re-encrypted file is merged converges.
  age_pub=${AGE_PUB:-/nix/fleet-state/secrets/age.pub}
  if ! secrets_file=$("$PYTHON" -I "$FLEET_ROLES_PY" secrets "$registry" "$ROLE" 2>&1); then
    failure_reason=${secrets_file:-roles.json at this revision could not be read}
    echo "sync: $failure_reason" >&2
    exit 1
  fi
  recipient=""
  if [ -f "$age_pub" ]; then
    recipient=$(head -n 1 "$age_pub" | tr -d '[:space:]')
  fi
  # Rotation (secrets.rotateAgeKeyAfter): fleet-agent created a next identity
  # and reports it. Promote it once the target role's file lists it, or at once
  # for a role without secrets. Until then the current identity keeps working.
  age_dir=$(dirname "$age_pub")
  next=""
  if [ -s "$age_dir/age.next.key" ] && [ -s "$age_dir/age.next.pub" ]; then
    next=$(head -n 1 "$age_dir/age.next.pub" | tr -d '[:space:]')
  fi
  if [[ "$next" =~ ^age1[02-9ac-hj-np-z]{58}$ ]] && { [ -z "$secrets_file" ] || [ ! -f "$repo/$FLAKE_DIR/$secrets_file" ] \
    || grep -qF -- "$next" "$repo/$FLAKE_DIR/$secrets_file"; }; then
    mv "$age_dir/age.next.key" "$age_dir/age.key"
    mv "$age_dir/age.next.pub" "$age_pub"
    date +%s > "$age_dir/age.created"
    echo "sync: promoted the rotated age identity $next (was ${recipient:-none})" >&2
    recovery_event age-rotated info "age-rotated:${next:4:24}" "the node now uses its rotated age identity $next; remove ${recipient:-the old recipient} from the role's secrets"
    recipient=$next
  fi
  if [ -n "$secrets_file" ] && [ -f "$repo/$FLAKE_DIR/$secrets_file" ] && [ -n "$recipient" ] \
    && ! grep -qF -- "$recipient" "$repo/$FLAKE_DIR/$secrets_file"; then
    issue="FLEET_SECRETS_RECIPIENT_MISSING: $recipient is not a recipient of $secrets_file at ${revision:0:7}. Re-encrypt it for this node (GET /v1/recipients) and merge."
    echo "sync: $issue" >&2
    set_phase blocked "$issue"
    record_success=0
    exit 0
  fi
else
  echo "sync: revision $revision has no roles.json; the build decides whether $FLAKE_ATTR exists" >&2
fi
# A path flake loses self.rev. Keep the exact Git revision in local builds.
# Pin the Git source and revision exactly, including the monorepo directory.
flake="git+file://${repo}?shallow=1&rev=${revision}&dir=${FLAKE_DIR}#nixosConfigurations.${FLAKE_ATTR}.config.system.build.toplevel"
failure_reason='the requested revision could not be built; inspect the build log and upstream Nix cache connectivity'
if ! toplevel=$(bounded "${FLEET_BUILD_TIMEOUT:-3600}" "$nix" build --no-write-lock-file --max-jobs 2 --cores 2 --option connect-timeout 15 --option stalled-download-timeout 60 --option narinfo-cache-negative-ttl 0 --no-link --print-out-paths "$flake"); then
  echo 'sync: local system build failed; keeping the current generation' >&2
  exit 1
fi
[ -n "$toplevel" ] && [ -d "$toplevel" ]
toplevel=$(readlink -f "$toplevel")

need_reboot=0
if [ -e "$booted/kernel" ] && [ -e "$toplevel/kernel" ]; then
  if [ "$(readlink -f "$booted/kernel")" != "$(readlink -f "$toplevel/kernel")" ] \
    || [ "$(readlink -f "$booted/initrd")" != "$(readlink -f "$toplevel/initrd")" ] \
    || [ "$(readlink -f "$booted/kernel-modules")" != "$(readlink -f "$toplevel/kernel-modules")" ]; then
    need_reboot=1
  fi
fi
# Another role is never switched to live: its services, users and secrets
# change together. It is a reboot-class change like a kernel update.
if [ "$role_change" -eq 1 ]; then
  need_reboot=1
fi

previous=""
if [ -e "$profile" ]; then
  previous=$(readlink -f "$profile" || true)
fi
roots=${FLEET_GC_ROOTS:-/nix/var/nix/gcroots}
rollback_root=$roots/fleet-update-previous
# The profile can already name an unverified candidate after a power loss.
# Keep the saved previous generation rather than overwriting its recovery root.
if [ -e "$rollback_root" ] && { \
  { [ "$previous" = "$toplevel" ] \
    && [ "$(cat "$state_dir/last-success" 2>/dev/null || true)" != "$revision" ]; } \
  || [ "$previous" = "$(cat "$state_dir/pending-generation" 2>/dev/null || true)" ]; }; then
  saved_previous=$(readlink -f "$rollback_root" || true)
  if [ -n "$saved_previous" ] && [ "$saved_previous" != "$toplevel" ] \
    && [ -x "$saved_previous/bin/switch-to-configuration" ]; then
    previous=$saved_previous
  fi
fi
if [ -n "$previous" ] && { [[ "$previous" == /nix/store/* ]] || [ -n "${FLEET_GC_ROOTS:-}" ]; }; then
  install -d -m 0755 "$roots"
  ln -sfn "$previous" "$rollback_root"
fi

apply() {
  # Persist before profile selection, so a later main commit cannot turn an
  # interrupted, unverified candidate into the next update's rollback target.
  printf '%s\n' "$toplevel" > "$state_dir/pending-generation.next"
  mv -f "$state_dir/pending-generation.next" "$state_dir/pending-generation"
  if ! bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$nix_env" -p "$profile" --set "$toplevel"; then
    rollback "$1" 'FLEET_PROFILE_FAILED: could not select the requested generation'
  fi
  if ! bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$toplevel/bin/switch-to-configuration" "$1"; then
    rollback "$1" 'FLEET_ACTIVATION_FAILED: generation activation failed before health verification'
  fi
}

# Timer/service checks always run. FLEET_HEALTH replaces only the external
# connectivity/signature probes in isolated tests.
health_check() {
  "$systemctl" cat fleet-sync.service >/dev/null || return 1
  if ! "$systemctl" is-active --quiet fleet-sync.timer; then
    echo 'sync: fleet-sync.timer is not active' >&2
    return 1
  fi
  if ! "$systemctl" is-enabled --quiet fleet-sync.timer; then
    echo 'sync: fleet-sync.timer is not enabled for the next boot' >&2
    return 1
  fi
  if [ -n "${FLEET_HEALTH:-}" ]; then
    "$FLEET_HEALTH"
    return
  fi
  local curl_bin=${FLEET_CURL:-curl}
  local target_cache=${CACHE_URL:-https://cache.nixos.org}
  target_cache=${target_cache:-https://cache.nixos.org}
  local target_key=""
  # Verify the new generation's recovery configuration, not the old process's
  # environment: a bad new cache URL/key must roll back while repair is possible.
  if [ -f "$toplevel/etc/fleet/bootstrap.json" ]; then
    local cache_config
    cache_config=$("${PYTHON:?}" - "$toplevel/etc/fleet/bootstrap.json" <<'PY'
import json,sys
from urllib.parse import urlparse
document=json.load(open(sys.argv[1]))
if document.get('updateMode') == 'local':
    print('https://cache.nixos.org'); print('-')
    sys.exit(0)
url,key=document['cacheUrl'],document['cachePublicKey']
parsed=urlparse(url)
if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not isinstance(key,str) or '\n' in key:
    sys.exit(1)
print(url); print(key)
PY
    ) || return 1
    target_cache=${cache_config%%$'\n'*}
    target_key=${cache_config#*$'\n'}
    if [ "$target_key" != "-" ]; then
      bounded 45 "$nix" store verify --store "$target_cache" --no-contents --sigs-needed 1 \
        --option trusted-public-keys "$target_key" --option narinfo-cache-negative-ttl 0 "$toplevel" || return 1
    fi
  fi
  # guard runs this in a conditional, where set -e does not apply.
  "$curl_bin" -fsS --max-time 20 -o /dev/null "${target_cache%/}/nix-cache-info" || return 1
}

pending_path=${FLEET_REBOOT_PENDING:-/run/fleet/reboot-pending}

report_failure() {
  reported_failure=1
  local mode=$1
  local reason=$2
  install -d -m 0755 "$(dirname "$report_path")" "$state_dir"
  {
    printf 'mode=%s\n' "$mode"
    printf 'previous=%s\n' "${previous:-none}"
    printf 'toplevel=%s\n' "$toplevel"
    printf '%s\n' "$reason"
  } > "$report_path"
  cp "$report_path" "$state_dir/health-failure"
  # The node agent reports this safe persisted failure through the Fleet controller.
}

clear_failure() {
  rm -f "$report_path" "$state_dir/health-failure"
}

rollback() {
  local mode=$1
  local reason=$2
  echo 'sync: update failed; rolling back to the previous generation' >&2
  printf '%s\n' "$reason" >&2
  set_phase blocked "FLEET_UPDATE_ROLLED_BACK: the new system failed its health check and the previous generation was restored: $reason"
  report_failure rollback-pending "$reason"
  if [ -n "$previous" ] && [ "$previous" != "$toplevel" ] && [ -x "$previous/bin/switch-to-configuration" ]; then
    if bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$nix_env" -p "$profile" --set "$previous" \
      && bounded "${FLEET_ACTIVATION_TIMEOUT:-300}" "$previous/bin/switch-to-configuration" "$mode"; then
      report_failure "$mode" "$reason"
    else
      report_failure rollback-failed "FLEET_ROLLBACK_FAILED: $reason; restoring the previous generation also failed. Automatic sync will retry."
    fi
  else
    echo 'sync: no previous generation to restore' >&2
    report_failure rollback-failed "FLEET_ROLLBACK_UNAVAILABLE: $reason; no previous generation can be restored. Automatic sync will retry."
  fi
  exit 1
}

# Run after apply. A failure restores the generation captured before --set
# and must not fall through to reboot.
guard() {
  local mode=$1
  local reason=""
  if ! reason=$(health_check 2>&1); then
    rollback "$mode" "$reason"
  fi
  clear_failure
}

if [ "$need_reboot" -eq 0 ] && [ "$previous" = "$toplevel" ] \
  && [ "$(cat "$state_dir/last-success" 2>/dev/null || true)" = "$revision" ] \
  && [ ! -e "$state_dir/health-failure" ]; then
  failure_reason='the running revision could not verify GitHub/cache connectivity or the update timer'
  health_check || exit 1
  clear_failure
  echo "sync: already running revision $revision"
  set_phase converged
  exit 0
fi

quarantined=""
if [ "$need_reboot" -eq 1 ]; then
  quarantined=$(quarantined_identity)
  if [ "$quarantined" = RETRY ]; then
    echo 'sync: retrying the quarantined kernel because Fleet asked to (sync.retryBootAfter)' >&2
    rm -f "$quarantine_file"
    recovery_event update-retry info "retry:${boot_id:-unknown}:$(conf sync.retryBootAfter 0)" \
      "Retrying the quarantined kernel because Retry the update was pressed in Fleet."
    quarantined=""
  elif [ -n "$quarantined" ] && [ "$quarantined" != "$(boot_identity "$toplevel")" ]; then
    # A different kernel arrived: the quarantine no longer applies.
    rm -f "$quarantine_file"
    quarantined=""
  fi
fi

quarantine_issue="FLEET_UPDATE_QUARANTINED: an earlier boot into this kernel fell back to the previous one; the node will not reboot into it until a newer kernel is published or Retry the update is pressed in Fleet."
if [ "$need_reboot" -eq 1 ] && [ -n "$quarantined" ] && [ "$role_change" -eq 1 ]; then
  # A role is never switched to live, and its boot is quarantined: wait.
  echo "sync: not changing to role $ROLE; its kernel is quarantined after an earlier failed boot" >&2
  set_phase blocked "$quarantine_issue"
  record_success=0
  exit 0
elif [ "$need_reboot" -eq 1 ] && [ -n "$quarantined" ]; then
  # The new userspace still applies; only the reboot into the quarantined
  # kernel is withheld. The node keeps serving jobs on the kernel that works.
  apply switch
  guard switch
  install -d -m 0755 "$(dirname "$pending_path")"
  printf 'toplevel=%s\nreason=quarantined\n' "$toplevel" > "$pending_path"
  echo 'sync: switched without rebooting; the new kernel is quarantined after an earlier failed boot' >&2
  set_phase blocked "$quarantine_issue"
elif [ "$need_reboot" -eq 1 ] && [ "$reboot_disabled" -eq 1 ] && [ "$role_change" -eq 1 ]; then
  # reboot.enabled is false and the role changes. The new role is installed
  # for the next boot only; nothing is drained, switched live or rebooted.
  apply boot
  guard boot
  install -d -m 0755 "$(dirname "$pending_path")"
  printf 'toplevel=%s\nreason=role-change\n' "$toplevel" > "$pending_path"
  echo "sync: role $ROLE ($FLAKE_ATTR) is installed for the next boot; a reboot is pending because reboot.enabled is false" >&2
  set_phase progressing "FLEET_REBOOT_PENDING: role $ROLE ($FLAKE_ATTR) is installed for the next boot; reboot.enabled is false, so the node waits for a reboot."
elif [ "$need_reboot" -eq 1 ] && [ "$reboot_disabled" -eq 1 ]; then
  # reboot.enabled is false. The new system is switched to and nothing is
  # drained or rebooted. The kernel change waits, and the agent reports it.
  apply switch
  guard switch
  install -d -m 0755 "$(dirname "$pending_path")"
  printf 'toplevel=%s\n' "$toplevel" > "$pending_path"
  echo 'sync: switched; a reboot is pending because reboot.enabled is false' >&2
  set_phase progressing "FLEET_REBOOT_PENDING: a new kernel is switched to and waits for a reboot; reboot.enabled is false."
elif [ "$need_reboot" -eq 1 ]; then
  delay=0
  if [ "$DELAY_MAX" -gt 0 ]; then
    # Resolve the id before draining. A missing id must not stop runners
    # and then fail to reboot.
    id=$("${PYTHON:?}" "${CATTLE_PY:?}" print-id) || {
      echo 'sync: stable id failed; not rebooting' >&2
      exit 1
    }
    seed=$(printf '%s' "$id" | cksum | awk '{print $1}')
    delay=$((seed % DELAY_MAX))
  fi
  # Keep serving work during the rollout jitter. Drain only immediately before
  # applying the boot generation, rather than leaving a node idle for hours.
  failure_reason='update was interrupted before the reboot was committed'
  if [ "$DELAY_MAX" -gt 0 ]; then
    sleep "$delay"
  fi
  if [ -n "${DRAIN_COMMAND:-}" ]; then
    [ -n "${RESUME_COMMAND:-}" ] || { echo 'sync: drain requires an automatic resume command; refusing to drain' >&2; exit 1; }
    drained=1
    install -d -m 0755 "$(dirname "$report_path")"
    touch "$(dirname "$report_path")/update-draining"
    printf 'recover interrupted update\n' > "$(dirname "$report_path")/agent-drained"
    export PATH="/run/current-system/sw/bin:${PATH:-}"
    FLEET_DRAIN_REASON=update bounded "$((${DRAIN_TIMEOUT:-7200} + 30))" "$DRAIN_COMMAND" "${DRAIN_TIMEOUT:-7200}"
  fi
  # Which boot asked for which system: a later boot running something else
  # fell back (detect_fallback). Durable before the boot entry changes.
  printf 'boot_id=%s\ntoplevel=%s\nrevision=%s\n' "$boot_id" "$toplevel" "$revision" > "$pending_boot.next"
  sync "$pending_boot.next" 2>/dev/null || true
  mv -f "$pending_boot.next" "$pending_boot"
  apply boot
  guard boot
  reboot_requested=1
  set_phase progressing
  if ! "$systemctl" reboot; then
    reboot_requested=0
    rollback boot 'reboot request failed; restoring the previous boot generation'
  fi
else
  apply switch
  guard switch
  rm -f "$pending_path"
  set_phase converged
fi
