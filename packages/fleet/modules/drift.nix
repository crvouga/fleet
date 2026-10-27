{ lib, pkgs, settings, ... }: let
  repo = settings.repo;
  configured = !(lib.hasInfix "TODO" repo.url);
  timerOn = (repo.timer or true) && configured;
in {
  # TODO: this unit failing is the only lag signal. Metrics stay on
  # 127.0.0.1:9101. A node that stops reporting cannot be seen from here,
  # and no scraper or pager exists yet. This is not OpenTofu plan drift.
  assertions = [
    {
      assertion = settings.drift.maxMinutes >= 1 && settings.drift.maxMinutes <= 1440;
      message = "drift.maxMinutes must be 1..1440.";
    }
  ];
  environment.etc."fleet/drift.env".text = ''
    REPO_URL=${lib.escapeShellArg repo.url}
    BRANCH=${lib.escapeShellArg repo.branch}
    REVISION_FILE=/etc/fleet/revision
    MAX_MINUTES=${toString settings.drift.maxMinutes}
    STATE_DIR=/nix/fleet-state/drift
  '';
  systemd.services.fleet-drift = {
    description = "Compare the running revision with origin/main";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    path = [ pkgs.git pkgs.openssh pkgs.python3 ];
    serviceConfig = {
      Type = "oneshot";
      EnvironmentFile = "/etc/fleet/drift.env";
      ExecStart = "${pkgs.python3}/bin/python3 ${../scripts/drift.py}";
    };
    unitConfig.X-StopOnRemoval = false;
  };
  systemd.timers.fleet-drift = lib.mkIf timerOn {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "3min";
      OnUnitActiveSec = "${toString repo.pollSeconds}s";
      Persistent = true;
      RandomizedDelaySec = "30s";
    };
  };
}
