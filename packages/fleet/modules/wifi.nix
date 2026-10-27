{ config, lib, pkgs, ... }: let
  source = pkgs.runCommand "fleet-wifi-tools" { } ''
    mkdir -p "$out"
    cp ${../wizard/fleet_wifi.py} "$out/fleet_wifi.py"
    cp ${../wizard/wifi_capture.py} "$out/wifi_capture.py"
  '';
  wifi = "${source}/fleet_wifi.py";
  tool = operation: pkgs.writeShellScriptBin "fleet-wifi-${operation}" ''
    export PATH=${lib.makeBinPath [ pkgs.networkmanager pkgs.iproute2 pkgs.python3 pkgs.util-linux pkgs.systemd ]}:$PATH
    exec ${pkgs.python3}/bin/python3 ${wifi} ${operation} "$@"
  '';
in {
  hardware.enableRedistributableFirmware = true;
  services.resolved.enable = true;
  # Keep systemd-networkd's existing wired configuration. Only NetworkManager
  # owns wireless devices, with its normal supplicant and reconnect handling.
  networking.networkmanager = {
    enable = true;
    unmanaged = [ "*" "except:type:wifi" ];
    dns = "systemd-resolved";
    wifi.powersave = false;
  };
  environment.systemPackages = [ (tool "ready") (tool "persist") ];
  systemd.services.fleet-wifi-import = {
    description = "Load private Wi-Fi settings before automatic network connection";
    requiredBy = [ "NetworkManager.service" ];
    before = [ "NetworkManager.service" ];
    after = [ "local-fs.target" "systemd-udev-settle.service" ];
    wants = [ "systemd-udev-settle.service" ];
    unitConfig.RequiresMountsFor = [ "/nix/fleet-state" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      UMask = "0077";
      ExecStart = "${pkgs.python3}/bin/python3 ${wifi} prepare";
    };
  };
  # A carried Wi-Fi profile must not wait two minutes for a disconnected wired
  # interface. NetworkManager-wait-online handles that boot instead.
  systemd.services.systemd-networkd-wait-online = lib.mkIf config.networking.useNetworkd {
    after = [ "fleet-wifi-import.service" ];
    unitConfig.ConditionPathExists = "!/run/fleet-wifi/wifi.json";
  };
}
