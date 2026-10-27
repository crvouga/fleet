{ config, lib, pkgs, settings, ... }: let
  roles = import ../roles.nix { inherit lib; };
  cap = settings.capacity;
  token = value: let text = toString value; in
    assert builtins.match "[A-Za-z0-9._-]+" text != null; text;
  # cattle.py reads the API's cached capacity settings through fleetconf.py.
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  assertions = [
    {
      assertion = config.networking.hostName == "";
      message = "Hostnames are assigned at boot. Leave networking.hostName empty.";
    }
    {
      assertion = builtins.elem settings.role roles.active;
      message = "settings.role must be an active role in roles.json, not a machine.";
    }
    {
      assertion = lib.any (closure: closure.attr == settings.flakeAttr && closure.role == settings.role) roles.closures;
      message = "settings.flakeAttr must be a closure that roles.json gives to this role.";
    }
    {
      assertion = cap.slotMax >= 1 && cap.slotMax <= 64
        && cap.perRunnerCores >= 1 && cap.perRunnerGiB >= 1
        && cap.reserveGiB >= 0 && cap.highMemGiB >= 1;
      message = "capacity constants must stay in range. slotMax is 1..64.";
    }
  ];
  environment.etc."fleet/node.conf".text = ''
    role=${token settings.role}
    flake_attr=${token settings.flakeAttr}
    reserve_gib=${token cap.reserveGiB}
    per_runner_gib=${token cap.perRunnerGiB}
    per_runner_cores=${token cap.perRunnerCores}
    slot_max=${token cap.slotMax}
    high_mem_gib=${token cap.highMemGiB}
  '';
  # Transient hostname only. /etc/hostname stays absent. hostnamectl needs
  # dbus, so this is not before sysinit. Journald may already be running.
  # SSH, metrics, and runner registration wait for this unit.
  systemd.services.node-identity = {
    description = "Name this machine from its role, capabilities, and stable id";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-udevd.service" "dbus.service" ];
    requires = [ "dbus.service" ];
    before = [ "sshd.service" "fleet-revision.service" "fleet-capacity.service" ];
    path = [ pkgs.python3 pkgs.coreutils pkgs.systemd ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      python3 ${tools.scripts}/cattle.py identity
    '';
  };
}
