{ pkgs, lib, ... }: let
  # Public test-only credentials; production credentials are always runtime data.
  fixture = pkgs.writeText "fleet-wifi-fixture.json" (builtins.toJSON {
    ssid = "Fleet Wi-Fi test";
    password = "fixture-only-password";
    auth = "wpa-psk";
    hidden = true;
  });
in pkgs.testers.runNixOSTest {
  name = "fleet-wifi-recovery";
  nodes.machine = {
    imports = [ ../modules/wifi.nix ];
    networking.useNetworkd = true;
    networking.useDHCP = false;
    # qemu-vm disables wireless with mkVMOverride (priority 10), even when
    # mac80211_hwsim supplies real simulated radios. Restore NM's supplicant.
    networking.wireless.enable = lib.mkOverride 0 true;
    virtualisation = { memorySize = 1536; cores = 1; graphics = false; vlans = [ ]; };
    boot.kernelModules = [ "mac80211_hwsim" ];
    boot.extraModprobeConfig = "options mac80211_hwsim radios=2";
    environment.systemPackages = [ pkgs.iw pkgs.networkmanager pkgs.iproute2 ];
    systemd.services.fleet-wifi-import = {
      requires = [ "test-wifi-seed.service" ];
      after = [ "test-wifi-seed.service" ];
    };
    systemd.services.test-wifi-seed = {
      unitConfig.ConditionPathExists = "!/nix/fleet-state/wifi-test-seeded";
      serviceConfig.Type = "oneshot";
      script = ''
        install -d -m 0700 /nix/fleet-state/network
        install -m 0600 ${fixture} /nix/fleet-state/network/wifi.json
        touch /nix/fleet-state/wifi-test-seeded
      '';
    };
    systemd.services.test-wifi-setup = {
      requires = [ "NetworkManager.service" ];
      after = [ "NetworkManager.service" "systemd-udev-settle.service" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      path = [ pkgs.iw pkgs.iproute2 pkgs.networkmanager pkgs.gawk pkgs.coreutils ];
      script = ''
        set -eu
        mapfile -t radios < <(iw dev | awk '$1 == "Interface" { print $2 }' | sort)
        test "''${#radios[@]}" -eq 2
        ap="''${radios[0]}"
        station="''${radios[1]}"
        nmcli device set "$ap" managed no
        ip address replace 192.0.2.1/24 dev "$ap"
        ip link set "$ap" up
        mkdir -p /run/wifi-test
        printf '%s\n' "$station" > /run/wifi-test/station
        cat > /run/wifi-test/hostapd.conf <<EOF
        interface=$ap
        driver=nl80211
        ssid=Fleet Wi-Fi test
        hw_mode=g
        channel=6
        wpa=2
        wpa_key_mgmt=WPA-PSK
        wpa_passphrase=fixture-only-password
        rsn_pairwise=CCMP
        ignore_broadcast_ssid=1
        EOF
        cat > /run/wifi-test/dnsmasq.conf <<EOF
        interface=$ap
        bind-interfaces
        dhcp-range=192.0.2.10,192.0.2.20,255.255.255.0,10m
        dhcp-option=3,192.0.2.1
        dhcp-option=6,192.0.2.1
        address=/fleet-wifi.test/192.0.2.1
        EOF
      '';
    };
    systemd.services.test-hostapd = {
      wantedBy = [ "multi-user.target" ];
      requires = [ "test-wifi-setup.service" ];
      after = [ "test-wifi-setup.service" ];
      serviceConfig = {
        ExecStart = "${pkgs.hostapd}/bin/hostapd /run/wifi-test/hostapd.conf";
        Restart = "on-failure";
      };
    };
    systemd.services.test-dnsmasq = {
      wantedBy = [ "multi-user.target" ];
      requires = [ "test-wifi-setup.service" ];
      after = [ "test-wifi-setup.service" ];
      serviceConfig.ExecStart = "${pkgs.dnsmasq}/bin/dnsmasq --keep-in-foreground --conf-file=/run/wifi-test/dnsmasq.conf";
    };
    networking.firewall.enable = false;
  };
  testScript = ''
    machine.start(allow_reboot=True)
    machine.wait_for_unit("test-hostapd.service")
    machine.wait_for_unit("test-dnsmasq.service")
    connected = 'station=$(cat /run/wifi-test/station); iw dev "$station" link | grep -q "Connected to"'
    machine.wait_until_succeeds(connected, timeout=120)
    machine.wait_until_succeeds("getent hosts fleet-wifi.test | grep -q 192.0.2.1", timeout=120)
    machine.succeed("test $(stat -c %a /run/NetworkManager/system-connections/fleet-wifi.nmconnection) = 600")
    machine.fail("su -s /bin/sh nobody -c 'cat /nix/fleet-state/network/wifi.json'")
    machine.succeed("systemctl stop test-hostapd.service")
    machine.wait_until_fails(connected, timeout=60)
    machine.succeed("systemctl start test-hostapd.service")
    # No nmcli connection-up command: automatic reassociation must recover.
    machine.wait_until_succeeds(connected, timeout=120)
    machine.wait_until_succeeds("getent hosts fleet-wifi.test | grep -q 192.0.2.1", timeout=60)
    machine.succeed("sync")
    machine.reboot()
    machine.wait_for_unit("test-hostapd.service")
    machine.wait_for_unit("test-dnsmasq.service")
    machine.wait_until_succeeds(connected, timeout=120)
    machine.wait_until_succeeds("getent hosts fleet-wifi.test | grep -q 192.0.2.1", timeout=120)
    machine.succeed("test -f /run/fleet-wifi/wifi.json; test $(stat -c %a /nix/fleet-state/network/wifi.json) = 600")
  '';
}
