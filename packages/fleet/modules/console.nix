{ lib, pkgs, settings, ... }: let
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  # Nobody logs in at a node's console: root is locked and the dev account is
  # SSH-only. tty1 shows the node's status instead of a login prompt: ready or
  # not, why, what to do, and a QR code for a pre-filled GitHub issue when it
  # is not (scripts/node_console.py). Alt+F2 still has a login prompt.
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@tty1".enable = false;
  environment.systemPackages = [ tools.nodeStatus ];
  systemd.services.fleet-node-console = {
    description = "Show this node's status, problems and report code on the console";
    environment.FLEET_API_URL = settings.fleetApi.url;
    wantedBy = [ "multi-user.target" ];
    after = [ "node-identity.service" "systemd-vconsole-setup.service" "systemd-user-sessions.service" ];
    wants = [ "node-identity.service" ];
    unitConfig.ConditionPathExists = "/dev/tty1";
    serviceConfig = {
      Type = "simple";
      ExecStart = "${tools.nodeConsole}/bin/fleet-node-console watch";
      Restart = "always";
      RestartSec = "10s";
      StandardOutput = "journal";
      StandardError = "journal";
    };
  };
}
