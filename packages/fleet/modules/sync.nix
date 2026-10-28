{ config, lib, pkgs, settings, ... }: let
  repo = settings.repo;
  configured = !(lib.hasInfix "TODO" repo.url);
  timerOn = (repo.timer or true) && configured;
  auth = repo.auth or "none";
  # Every closure, base included, reads the Git read credential from one fixed
  # path. The installer places it there (a node cannot decrypt anything before
  # an operator makes it a SOPS recipient, and cannot fetch that change without
  # a credential). A role whose secretsFile holds a newer credential refreshes
  # the fixed copy, so rotation travels through Git. It is node identity, never
  # cache: node_state.py keeps /nix/fleet-state/secrets across role changes.
  credentialName = if auth == "ssh" then "git-read-key" else "git-read-token";
  credential = "/nix/fleet-state/secrets/${credentialName}";
  gitKey = if auth == "ssh" then credential else "";
  gitToken = if auth == "token" then credential else "";
  refreshed = auth != "none" && settings.secretsFile != null;
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  # comin is not in nixpkgs at the pinned revision 7c8764b7, so this timer is
  # the pull agent. It fetches main and converges to the assigned closure in
  # /nix/fleet-state/target (written by fleet-agent from the controller's
  # desired state, or by fleet-target in local mode), else to this image's own
  # nixosConfigurations.<flakeAttr>, using upstream substitutes and bounded
  # local builds for missing paths (ARCHITECTURE.md).
  assertions = [
    {
      assertion = repo.branch == "main";
      message = "Every role polls main. There is no deploy or canary branch.";
    }
    {
      assertion = builtins.elem auth [ "none" "ssh" "token" ];
      message = "repo.auth is none, ssh or token.";
    }
  ];
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "fleet-sync" ''
      exec ${pkgs.bash}/bin/bash ${../scripts/fleet-sync.sh} "$@"
    '')
  ];
  environment.etc."fleet/git-known-hosts".text = settings.repo.sshKnownHosts or "";
  environment.etc."fleet/sync.env".text = ''
    ROLE=${lib.escapeShellArg settings.role}
    FLAKE_ATTR=${lib.escapeShellArg settings.flakeAttr}
    BRANCH=${lib.escapeShellArg repo.branch}
    REPO_URL=${lib.escapeShellArg repo.url}
    FLAKE_DIR=${lib.escapeShellArg repo.flakeDir}
    CACHE_URL=${lib.escapeShellArg (if settings.binaryCache.url == null then "" else settings.binaryCache.url)}
    DELAY_MAX=${toString settings.reboot.delayMaxSeconds}
    DRAIN_COMMAND=${lib.escapeShellArg settings.reboot.drainCommand}
    RESUME_COMMAND=${lib.escapeShellArg (settings.reboot.resumeCommand or "")}
    DRAIN_TIMEOUT=${toString settings.reboot.drainTimeoutSeconds}
    GIT_KEY=${lib.escapeShellArg gitKey}
    GIT_TOKEN=${lib.escapeShellArg gitToken}
    GIT_KNOWN_HOSTS=${lib.escapeShellArg "/etc/fleet/git-known-hosts"}
    FLEET_NIX=${lib.escapeShellArg (settings.fleetNix or "${pkgs.nix}/bin/nix")}
    FLEET_NIX_ENV=${lib.escapeShellArg (settings.fleetNixEnv or "${pkgs.nix}/bin/nix-env")}
    FLEET_SYSTEMCTL=${lib.escapeShellArg (settings.fleetSystemctl or "${pkgs.systemd}/bin/systemctl")}
    FLEET_GIT=${lib.escapeShellArg "${pkgs.git}/bin/git"}
    FLEET_HEALTH=${lib.escapeShellArg (settings.fleetHealth or "")}
    CATTLE_PY=${lib.escapeShellArg "${tools.scripts}/cattle.py"}
    RECOVERY_PY=${lib.escapeShellArg "${tools.scripts}/recovery.py"}
    FLEET_ROLES_PY=${lib.escapeShellArg "${tools.scripts}/fleet_roles.py"}
    FLEETCONF=${lib.escapeShellArg "${tools.fleetconf}/bin/fleetconf"}
    PYTHON=${lib.escapeShellArg "${pkgs.python3}/bin/python3"}
    TARGET=${lib.escapeShellArg "/nix/fleet-state/target"}
    AGE_PUB=${lib.escapeShellArg "/nix/fleet-state/secrets/age.pub"}
    RECONCILE=${lib.escapeShellArg "/run/fleet/reconcile.json"}
    NODE_CONF=${lib.escapeShellArg "/etc/fleet/node.conf"}
    REPO_AUTH=${lib.escapeShellArg auth}
  '';
  sops.secrets = lib.mkIf refreshed {
    ${credentialName} = { mode = "0400"; restartUnits = [ "fleet-git-credential.service" ]; };
  };
  systemd.services.fleet-git-credential = lib.mkIf refreshed {
    description = "Refresh the Git read credential from this role's secrets";
    wantedBy = [ "multi-user.target" ];
    before = [ "fleet-sync.service" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; UMask = "0077"; };
    path = [ pkgs.coreutils pkgs.diffutils ];
    script = ''
      set -eu
      from=${config.sops.secrets.${credentialName}.path}
      [ -s "$from" ] || exit 0
      cmp -s "$from" ${credential} 2>/dev/null && exit 0
      install -d -m 0700 /nix/fleet-state/secrets
      install -m 0600 "$from" ${credential}.new
      mv ${credential}.new ${credential}
    '';
  };
  systemd.services.fleet-sync = {
    description = "Converge this node to its assigned closure";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    # An updater must finish its current activation and health/rollback checks
    # when its own script or unit changes. The next timer run uses the new unit.
    restartIfChanged = false;
    # path replaces the unit PATH. awk is gawk, not coreutils.
    path = [ pkgs.git pkgs.openssh pkgs.coreutils pkgs.gawk pkgs.nix pkgs.python3 pkgs.curl ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.bash}/bin/bash ${../scripts/fleet-sync.sh}";
    };
    unitConfig.X-StopOnRemoval = false;
  };
  systemd.timers.fleet-sync = lib.mkIf timerOn {
    description = "Converge this node to its assigned closure every poll";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "15s";
      # Schedule from completion, including failed attempts and long drains.
      OnUnitInactiveSec = "${toString repo.pollSeconds}s";
      # Persistent is for calendar timers. With systemd 260, its saved realtime
      # trigger can suppress an overdue OnBootSec without a monotonic retry
      # timestamp after reboot. OnBootSec starts recovery on every boot.
      RandomizedDelaySec = "30s";
      AccuracySec = "1s";
    };
  };
}
