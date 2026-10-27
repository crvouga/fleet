{ lib, pkgs, settings, ... }: let
  # The fleet API (packages/fleet-api) receives a heartbeat from every node
  # and serves the node's dynamic settings. It sends data, never code, and
  # the node works without it: an empty or TODO address leaves the unit out,
  # and an unreachable server leaves the last applied settings in force.
  url = (settings.fleetApi or { }).url or "";
  enabled = url != "" && !(lib.hasInfix "TODO" url);
  tools = import ./fleet-tools.nix { inherit lib pkgs; apiUrl = url; };
in {
  environment.systemPackages = [ tools.agent tools.fleetconf ];
  systemd.tmpfiles.rules = [ "d /nix/fleet-state/agent 0700 root root -" ];
  systemd.services.fleet-agent = lib.mkIf enabled {
    description = "Report this node to the fleet API and apply the settings it sends";
    wantedBy = [ "multi-user.target" ];
    after = [ "node-identity.service" "network-online.target" ];
    wants = [ "node-identity.service" "network-online.target" ];
    environment.FLEET_API_URL = url;
    serviceConfig = {
      Type = "simple";
      ExecStart = "${tools.agent}/bin/fleet-agent run";
      Restart = "always";
      RestartSec = "30s";
    };
  };
}
