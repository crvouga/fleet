{ config, lib, pkgs, settings, ... }: let
  repo = settings.repo;
  configured = !(lib.hasInfix "TODO" repo.url);
  timerOn = (repo.timer or true) && configured;
  auth = repo.auth or "none";
  gitKey = if auth == "ssh" then config.sops.secrets.git-read-key.path else "";
  gitToken = if auth == "token" then config.sops.secrets.git-read-token.path else "";
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  # comin is not in nixpkgs at the pinned revision 7c8764b7, so this timer is
  # the pull agent. It fetches main and switches nixosConfigurations.<flakeAttr>
  # using upstream substitutes and bounded local builds for missing paths.
  assertions = [
    {
      assertion = repo.branch == "main";
      message = "Every role polls main. There is no deploy or canary branch.";
    }
    {
      assertion = auth == "none" || settings.secretsFile != null;
      message = "repo.auth needs this role's secretsFile. CI and web must not share that file or its age key.";
    }
  ];
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "fleet-sync" ''
      exec ${pkgs.bash}/bin/bash ${../scripts/fleet-sync.sh} "$@"
    '')
  ];
  environment.etc."fleet/git-known-hosts".source = ./github-known-hosts;
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
  '';
  sops.secrets = lib.mkIf (settings.secretsFile != null) (lib.mkMerge [
    (lib.mkIf (auth == "ssh") { git-read-key = { mode = "0400"; }; })
    (lib.mkIf (auth == "token") { git-read-token = { mode = "0400"; }; })
  ]);
  systemd.services.fleet-sync = {
    description = "Pull this role from git";
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
