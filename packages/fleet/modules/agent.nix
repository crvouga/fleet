{ lib, pkgs, settings, ... }: let
  # The fleet controller (packages/fleet-controller) receives a heartbeat from every node
  # and serves the node's dynamic settings. It sends data, never code, and
  # the node works without it: an empty or TODO address leaves the unit out,
  # and an unreachable controller leaves the last applied settings in force.
  url = (settings.fleetApi or { }).url or "";
  enabled = url != "" && !(lib.hasInfix "TODO" url);
  tools = import ./fleet-tools.nix { inherit lib pkgs; apiUrl = url; };
in {
  # fleet-target show|set|clear: the desired state in local mode. It refuses to
  # change the target when this image names a controller (the controller is
  # authoritative), so it is installed here where the address is known.
  environment.systemPackages = [ tools.agent tools.fleetconf tools.target ];
  systemd.tmpfiles.rules = [ "d /nix/fleet-state/agent 0700 root root -" ];
  systemd.services.fleet-agent = lib.mkIf enabled {
    description = "Report this node to the fleet controller and converge on the desired state it assigns";
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
