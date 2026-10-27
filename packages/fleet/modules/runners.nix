{ config, lib, pkgs, settings, registrationProvider ? null, drainProvider ? null, ... }: let
  # Every closure can start this many slots. Boot starts only the count
  # cattle.py writes to /run/fleet/slot-count for the live CPU and RAM.
  slots = settings.capacity.slotMax;
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
  ids = map (n: "slot-${toString n}") (lib.range 1 slots);
  # The NixOS module applies `pkg.override { nodeRuntimes }`.
  # writeShellScriptBin has no override. callPackage supplies one, and the
  # real listener still comes from github-runner so its Node layout follows.
  runnerPackage = pkgs.callPackage ({ nodeRuntimes ? [ "node24" ] }: pkgs.writeShellScriptBin "Runner.Listener" ''
    set -euo pipefail
    real=${pkgs.github-runner.override { inherit nodeRuntimes; }}/bin/Runner.Listener
    if [ "''${1:-}" != configure ]; then
      exec "$real" "$@"
    fi
    if [ -r /run/fleet/node ]; then
      prefix=$(${pkgs.gawk}/bin/awk -F= '$1 == "runner_prefix" { print $2 }' /run/fleet/node)
      if [[ "$prefix" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] && [ -n "''${FLEET_SLOT:-}" ]; then
        export ACTIONS_RUNNER_INPUT_NAME="$prefix-$FLEET_SLOT"
      fi
    fi
    extra=""
    if [ -s /run/fleet/runner-labels ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          "") continue ;;
          *,*) echo "runner label contains a comma" >&2; exit 1 ;;
        esac
        if [ -z "$extra" ]; then extra=$line; else extra="$extra,$line"; fi
      done < /run/fleet/runner-labels
    fi
    # The repository the fleet API assigned to this slot. The registration step
    # records the one it used in /run/fleet/assign-used/<slot>, so the token and
    # the URL always name the same repository. No record: the settings.github scope.
    repo=""
    used=/run/fleet/assign-used/''${FLEET_SLOT:-none}
    if [ -s "$used" ]; then
      read -r repo < "$used" || true
      repo_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
      if ! [[ "$repo" =~ $repo_pattern ]]; then repo=""; fi
    fi
    if [ -z "$extra" ] && [ -z "$repo" ]; then
      exec "$real" "$@"
    fi
    args=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --labels)
          shift
          args+=(--labels "$1''${extra:+,$extra}")
          shift
          ;;
        --labels=*)
          args+=("--labels=''${1#--labels=}''${extra:+,$extra}")
          shift
          ;;
        --url)
          if [ -n "$repo" ]; then args+=(--url "https://github.com/$repo"); else args+=("$1" "$2"); fi
          shift 2
          ;;
        --url=*)
          if [ -n "$repo" ]; then args+=("--url=https://github.com/$repo"); else args+=("$1"); fi
          shift
          ;;
        # A runner group exists for an organization only; a repository has none.
        --runnergroup)
          if [ -z "$repo" ]; then args+=("$1" "$2"); fi
          shift 2
          ;;
        --runnergroup=*)
          if [ -z "$repo" ]; then args+=("$1"); fi
          shift
          ;;
        *)
          args+=("$1")
          shift
          ;;
      esac
    done
    exec "$real" "''${args[@]}"
  '') {};
  scopeFor = n: if settings.github.scope == "organization" then settings.github.organization
    else builtins.elemAt settings.github.repositories (lib.mod (n - 1) (builtins.length settings.github.repositories));
  token = if registrationProvider != null then registrationProvider else pkgs.writeScript "fleet-token" ''#!${pkgs.python3.withPackages (p: [ p.pyjwt p.cryptography ])}/bin/python3
${builtins.readFile ../scripts/runner_control.py}
'';
  control = if drainProvider != null then drainProvider else pkgs.writeScriptBin "runner-control" ''#!${pkgs.python3.withPackages (p: [ p.pyjwt p.cryptography ])}/bin/python3
${builtins.readFile ../scripts/runner_control.py}
'';
  # Registration pre-start for one slot. The fleet API may assign the slot a
  # repository (runners.repositories -> /run/fleet/assign/<slot>); the
  # registration token is then requested for that repository, and the choice
  # is recorded in /run/fleet/assign-used/<slot> for the Runner.Listener
  # wrapper and for fleet-drain. The GitHub App installation decides which
  # repositories can ever register: a name it cannot reach fails to get a token.
  # No assignment: the static settings.github scope, as before.
  register = id: target: pkgs.writeShellScript "fleet-register-${id}" ''
    set -euo pipefail
    scope=${lib.escapeShellArg settings.github.scope}
    target=${lib.escapeShellArg target}
    used=/run/fleet/assign-used
    ${pkgs.coreutils}/bin/install -d -m 0755 "$used"
    ${pkgs.coreutils}/bin/rm -f "$used/${id}"
    repo=""
    if [ -s "/run/fleet/assign/${id}" ]; then
      read -r repo < "/run/fleet/assign/${id}" || true
    fi
    repo_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    if [[ "$repo" =~ $repo_pattern ]]; then
      scope=repository
      target=$repo
      printf '%s\n' "$repo" > "$used/${id}"
      ${pkgs.coreutils}/bin/chmod 0644 "$used/${id}"
    fi
    # The system this slot runs on: the agent restarts an idle slot onto a
    # newer one after an update (agent.py refresh_stale_slots).
    # Advisory: it never stops registration.
    { ${pkgs.coreutils}/bin/install -d -m 0700 -o ${id} -g ${id} /run/fleet/${id} \
      && ${pkgs.coreutils}/bin/readlink -f /run/current-system > /run/fleet/${id}/system; } 2>/dev/null || true
    # The outcome, public text only, for the console screen and readiness.
    export FLEET_REGISTER_STATUS=/run/fleet/register/${id}.json
    exec ${token} register "$scope" "$target" ${lib.escapeShellArgs [ settings.github.appId settings.github.installationId "/run/secrets/github-app-key" "/run/fleet/tokens/${id}" ]}
  '';
  targets = if settings.github.scope == "organization" then [ settings.github.organization ] else settings.github.repositories;
  drain = pkgs.writeShellApplication {
    name = "fleet-drain";
    runtimeInputs = with pkgs; [ systemd coreutils util-linux gawk control ];
    text = ''
      export FLEET_SCOPE=${lib.escapeShellArg settings.github.scope}
      export FLEET_TARGETS=${lib.escapeShellArg (lib.concatStringsSep " " targets)}
      export FLEET_APP_ID=${lib.escapeShellArg settings.github.appId}
      export FLEET_INSTALLATION_ID=${lib.escapeShellArg settings.github.installationId}
      export FLEET_UNITS=${lib.escapeShellArg (lib.concatStringsSep " " (map (id: "github-runner-${id}.service") ids))}
      ${builtins.readFile ../scripts/drain.sh}
    '';
  };
  resume = pkgs.writeShellApplication {
    name = "fleet-resume";
    runtimeInputs = with pkgs; [ systemd coreutils util-linux ];
    text = ''
      export FLEETCONF=${tools.fleetconf}/bin/fleetconf
      export FLEET_SLOT_MAX=${toString slots}
      ${builtins.readFile ../scripts/resume.sh}
    '';
  };
  prerequisites = pkgs.writeShellScript "fleet-runner-prerequisites"
    (builtins.readFile ../scripts/runner-prerequisites.sh);
  hooks = event: pkgs.writeShellScript "fleet-job-${event}" (if event == "started" then ''
    exec 9>/run/fleet/gate
    ${pkgs.util-linux}/bin/flock 9
    # Admission barrier: a just-dispatched job fails before project code during drain.
    [ ! -e /run/fleet/draining ] || exit 75
    touch "$CI_BUSY_FILE"
    ${tools.runnerJob}/bin/fleet-runner-job started
  '' else ''
    rm -f "$CI_BUSY_FILE"
    ${tools.runnerJob}/bin/fleet-runner-job completed
  '');
in {
  assertions = [
    { assertion = slots >= 1 && slots <= 64; message = "Fleet slots must be 1..64."; }
    { assertion = builtins.elem settings.github.scope [ "organization" "repository" ]; message = "Invalid GitHub scope."; }
    { assertion = settings.github.scope != "repository" || builtins.length settings.github.repositories > 0;
      message = "Repository registration needs at least one owner/repo."; }
  ];
  environment.systemPackages = [ drain resume control ];
  environment.etc."fleet-slots".text = lib.concatStringsSep "\n" ids + "\n";
  # Not a secret. The on-node remove command reads it and uses the key file
  # already on the machine. TODO values fail closed.
  environment.etc."fleet/runner.conf".text = ''
    scope=${settings.github.scope}
    app_id=${settings.github.appId}
    installation_id=${settings.github.installationId}
  '' + lib.concatMapStrings (target: "target=${target}\n") (
    if settings.github.scope == "organization"
    then [ settings.github.organization ]
    else settings.github.repositories
  );
  users.groups = lib.genAttrs ids (_: {});
  users.users = lib.genAttrs ids (id: let index = lib.lists.findFirstIndex (x: x == id) 0 ids; in {
    isSystemUser = true; group = id; home = "/var/lib/github-runner/${id}";
    uid = 2000 + index;
    linger = settings.containers;
    subUidRanges = lib.optionals settings.containers [ { startUid = 100000 + 65536 * index; count = 65536; } ];
    subGidRanges = lib.optionals settings.containers [ { startGid = 100000 + 65536 * index; count = 65536; } ];
  });
  systemd.tmpfiles.rules = lib.concatMap (id: [
    "d /nix/ci-cache/${id} 0700 ${id} ${id} -"
    # The job this slot is running, durably (runner_job.py; recovery.py reads it
    # after a power loss). Written by the slot's own user, so never trusted.
    "d /nix/ci-state/${id} 0700 ${id} ${id} -"
    "d /run/fleet/${id} 0700 ${id} ${id} -"
  ]) ids ++ [ "d /run/fleet 0755 root root -" "f /run/fleet/gate 0666 root root -" ];
  services.github-runners = builtins.listToAttrs (lib.imap1 (n: id: lib.nameValuePair id {
    enable = true;
    url = "https://github.com/${scopeFor n}";
    name = null; # ACTIONS_RUNNER_INPUT_NAME below supplies hostname + slot
    ephemeral = true;
    replace = true;
    user = id; group = id;
    runnerGroup = if settings.github.scope == "organization" then settings.github.runnerGroup else null;
    tokenFile = "/run/fleet/tokens/${id}";
    package = lib.mkDefault runnerPackage;
    # nixos and ci stay in the store. x64, gpu, and high-mem are spliced
    # onto --labels at configure time from /run/fleet/runner-labels.
    extraLabels = [ "nixos" "ci" ];
    # Bash, Git and Nix come from the pinned upstream module's service PATH.
    # gh is needed by workflow steps before a project's toolchain is installed.
    extraPackages = [ pkgs.gh ] ++ lib.optionals settings.containers [ pkgs.podman ];
    extraEnvironment = {
      FLEET_PREREQUISITE_STATUS = "/run/fleet/${id}/prerequisites";
      FLEET_JOB_STATE_ROOT = "/nix/ci-state";
      ACTIONS_RUNNER_INPUT_NAME = "%H-${id}";
      FLEET_SLOT = id;
      CI_CACHE_DIR = "/nix/ci-cache/${id}";
      CI_BUSY_FILE = "/run/fleet/${id}/busy";
      ACTIONS_RUNNER_HOOK_JOB_STARTED = "${hooks "started"}";
      ACTIONS_RUNNER_HOOK_JOB_COMPLETED = "${hooks "completed"}";
    } // lib.optionalAttrs settings.containers {
      DOCKER_HOST = "unix:///run/user/${toString (2000 + lib.lists.findFirstIndex (x: x == id) 0 ids)}/podman/podman.sock";
    };
    serviceOverrides = {
      Restart = lib.mkForce "always";
      RestartSec = "15s";
      UMask = lib.mkForce "0077";
      # ExecStopPost runs after the listener's control group has stopped. A
      # crash must not leave a phantom busy job blocking every later drain.
      ExecStopPost = [
        "${pkgs.coreutils}/bin/rm -f /run/fleet/${id}/busy"
        "${tools.runnerJob}/bin/fleet-runner-job stopped"
      ];
      ReadWritePaths = [ "/nix/ci-cache/${id}" "/nix/ci-state/${id}" "/run/fleet/${id}" ]
        ++ lib.optional settings.containers "/run/user/${toString (2000 + lib.lists.findFirstIndex (x: x == id) 0 ids)}";
      # Rootless Podman requires namespaces and mounts; enabled only explicitly.
    } // lib.optionalAttrs settings.containers {
      PrivateUsers = lib.mkForce false;
      RestrictNamespaces = lib.mkForce false;
      RestrictSUIDSGID = lib.mkForce false;
      SystemCallFilter = lib.mkForce [ ];
      NoNewPrivileges = lib.mkForce false;
    };
  }) ids);
  systemd.services = builtins.listToAttrs (lib.imap1 (n: id: lib.nameValuePair "github-runner-${id}" {
    wantedBy = lib.mkForce [ ];
    requires = [ "node-identity.service" ];
    # An update must not restart a runner: that killed the job it was running.
    # The new unit takes effect when the slot next starts: after its job for a
    # busy slot, at once for an idle one (agent.py refresh_stale_slots).
    restartIfChanged = false;
    after = [ "node-identity.service" ] ++ lib.optional (settings.secretsFile != null) "sops-install-secrets.service";
    # fleet-remove writes /nix/fleet-state/withdrawn. It survives reboots, so a
    # removed node never registers again until it is reinstalled.
    unitConfig.ConditionPathExists = [ "!/run/fleet/draining" "!/nix/fleet-state/withdrawn" ];
    serviceConfig.ExecStartPre = lib.mkMerge [
      (lib.mkBefore [ "+${register id (scopeFor n)}" ])
      # After upstream setup, inside the actual service sandbox as the slot
      # user. No '+' privilege escape or PATH supplied by an interactive shell.
      (lib.mkAfter [ "${prerequisites}" ])
    ];
  }) ids);
}
