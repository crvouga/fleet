{ lib, pkgs, ... }: let
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  # What a node remembers across power loss (scripts/recovery.py, docs/resilience.md).
  # Started before the agent and the runners at every boot: it notes whether the
  # previous boot ended cleanly and turns jobs a reset cut off into events.
  # Stopped late at every orderly shutdown, which is what marks a boot clean:
  # a power cut, hard reset, panic or watchdog reset never runs ExecStop.
  environment.systemPackages = [ tools.recovery ];
  systemd.services.fleet-recovery = {
    description = "Record clean and unclean shutdowns and recover interrupted jobs";
    wantedBy = [ "multi-user.target" ];
    after = [ "local-fs.target" "systemd-pstore.service" ];
    before = [ "fleet-agent.service" "fleet-capacity.service" "fleet-node-console.service" ];
    unitConfig.RequiresMountsFor = [ "/nix/fleet-state" ];
    # Its own script changing must not mark this boot as ended.
    restartIfChanged = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${tools.recovery}/bin/fleet-recovery boot";
      ExecStop = "${tools.recovery}/bin/fleet-recovery shutdown";
      TimeoutStopSec = "30s";
    };
  };
}
