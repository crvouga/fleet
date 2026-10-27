{ config, lib, pkgs, settings, ... }: let
  python = pkgs.python3.withPackages (p: [ p.pyjwt p.cryptography ]);
  readiness = pkgs.runCommand "fleet-bootstrap-tools" { } ''
    mkdir -p "$out"
    cp ${../scripts/bootstrap-readiness.py} "$out/bootstrap-readiness.py"
    cp ${../scripts/runner_control.py} "$out/runner_control.py"
    cp ${../scripts/bootstrap_report.py} "$out/bootstrap_report.py"
    cp ${../scripts/agent.py} "$out/agent.py"
    cp ${../scripts/recovery.py} "$out/recovery.py"
    cp ${../scripts/node_readiness.py} "$out/node_readiness.py"
    cp ${../scripts/telemetry.py} "$out/telemetry.py"
    cp ${../scripts/runner_job.py} "$out/runner_job.py"
    cp ${../scripts/cattle.py} "$out/cattle.py"
    cp ${../scripts/fleetconf.py} "$out/fleetconf.py"
    cp ${../scripts/live_console.py} "$out/live_console.py"
    cp ${../scripts/decide.py} "$out/decide.py"
  '';
  bootstrapPackages = [ pkgs.sops pkgs.qrencode (pkgs.writeShellScriptBin "fleet-bootstrap-ready" ''
    export PATH=${lib.makeBinPath [ pkgs.sops ]}:$PATH
    exec ${python}/bin/python3 ${readiness}/bootstrap-readiness.py "$@"
  '') (pkgs.writeShellScriptBin "fleet-bootstrap-report" ''
    exec ${python}/bin/python3 ${readiness}/bootstrap_report.py "$@"
  '') ];
  # The installer's screens and the commands a person types at its prompt
  # (scripts/live_console.py). sudo must be the setuid wrapper, not the package.
  liveCommand = name: command: pkgs.writeShellScriptBin name ''
    export PATH=${config.security.wrapperDir}:${lib.makeBinPath [ pkgs.qrencode pkgs.systemd pkgs.coreutils config.networking.networkmanager.package ]}:$PATH
    exec ${python}/bin/python3 ${readiness}/live_console.py ${command} "$@"
  '';
  livePackages = [
    (liveCommand "fleet-live" "")
    (liveCommand "fleet-status" "status")
    (liveCommand "fleet-report" "report")
    (liveCommand "fleet-wifi" "wifi")
    (liveCommand "fleet-retry" "retry")
    (liveCommand "fleet-return" "return")
  ];
in {
  imports = [ ./hardware/generic.nix ./wifi.nix ];
  # stage-1-init.sh moves /run into the live system after postMountCommands.
  # The supplemental initramfs is private runtime data, never a store path.
  boot.initrd.postMountCommands = lib.mkIf (!config.boot.initrd.systemd.enable) ''
    if [ -f /fleet-wifi.json ]; then
      mkdir -p /run/fleet-wifi
      chmod 0700 /run/fleet-wifi
      cp /fleet-wifi.json /run/fleet-wifi/wifi.json
      chmod 0600 /run/fleet-wifi/wifi.json
      rm -f /fleet-wifi.json
    fi
  '';
  # Live image. The USB ISO carries the role closures. fleet-install on this
  # console partitions the disk and installs. SSH is optional emergency access.
  # No static hostname. The installed system names itself at boot.
  networking.hostName = lib.mkForce "";
  networking.useDHCP = lib.mkForce false;
  assertions = [{
    assertion = config.networking.hostName == "";
    message = "The installer does not set a static hostname.";
  }];
  # age stays on the system path. The console user is nixos, and sudo's
  # secure_path drops the fleet-install wrapper's PATH. age-keygen has to
  # survive that. select-disk and nixos-install are already there.
  environment.systemPackages = bootstrapPackages ++ livePackages ++ [
    pkgs.age
    (pkgs.writeShellScriptBin "select-disk" ''
      export PATH=${lib.makeBinPath [ pkgs.python3 pkgs.util-linux ]}:$PATH
      exec ${pkgs.python3}/bin/python3 ${../scripts/cattle.py} select-disk
    '')
    (pkgs.writeShellScriptBin "fleet-install" ''
      export PATH=${lib.makeBinPath [
        pkgs.coreutils pkgs.bash pkgs.age pkgs.openssh pkgs.python3
        pkgs.util-linux pkgs.gawk pkgs.sudo pkgs.diffutils pkgs.curl
      ]}:$PATH
      exec ${pkgs.bash}/bin/bash ${../scripts/fleet-install.sh} "$@"
    '')
  ];
  # A prompt here appears only when the installer stopped, the person chose to
  # stay, or they pressed Alt+F2. Say what happened and what to type, every time.
  services.getty.helpLine = lib.mkForce "Fleet installer. Type fleet-status to see what is happening and what to do, or fleet-wifi to choose a Wi-Fi network.";
  # systemd's own status line ("A start job is running for ...") printed the
  # install unit's description under the installer screen for the whole network
  # wait. The screens say what is happening; systemd only reports failures.
  systemd.settings.Manager.ShowStatus = "error";
  programs.bash.loginShellInit = ''
    if [ -t 1 ] && command -v fleet-status >/dev/null 2>&1; then
      fleet-status || true
    fi
  '';
  # The first screen, as soon as filesystems are up. The install unit waits for
  # network-online.target, which can take two minutes of bare boot messages.
  systemd.services.fleet-installer-screen = {
    description = "Show the Fleet installer's first screen";
    wantedBy = [ "multi-user.target" ];
    after = [ "local-fs.target" "systemd-vconsole-setup.service" ];
    before = [ "network-online.target" "fleet-auto-install.service" ];
    unitConfig.ConditionPathExists = "/iso/fleet-install-manifest";
    serviceConfig = {
      Type = "oneshot";
      StandardOutput = "journal";
      StandardError = "journal";
      ExecStart = "${lib.getExe' (builtins.head livePackages) "fleet-live"} step network";
    };
  };
  systemd.services.fleet-auto-install = {
    # Shown by systemd and journalctl. Nothing is erased until every check passes,
    # so the description must not say that the disk is being wiped.
    description = "Fleet installer (checks first; the disk is erased only after they pass)";
    wantedBy = [ "multi-user.target" ];
    before = [ "getty@tty1.service" ];
    after = [ "systemd-udev-settle.service" "local-fs.target" "NetworkManager.service" "network-online.target" ];
    wants = [ "network-online.target" ];
    unitConfig.ConditionPathExists = "/iso/fleet-install-manifest";
    unitConfig.StartLimitIntervalSec = 0;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      # fleet-live draws the console screens itself. journal+console prefixed
      # every line with the unit name, which broke the report QR code.
      StandardOutput = "journal";
      StandardError = "journal";
      # fleet-auto.sh retries temporary preflight failures (exit 75) itself,
      # before disko, inside this one start job. A systemd restart failed the
      # job between attempts and let getty log in over the installer. Wrapped
      # token use is idempotent through the private enrolled credential
      # snapshot. Never automatically repeat a partition/install failure.
      Restart = "no";
    };
    # A service path replaces the default and hides select-disk and
    # nixos-install. Keep the live system profile, then the tools this unit calls.
    script = ''
      export PATH="/run/current-system/sw/bin:${lib.makeBinPath [
        pkgs.bash
        pkgs.coreutils
        pkgs.gawk
        pkgs.util-linux
        pkgs.systemd
        pkgs.age
        pkgs.diffutils
        pkgs.python3
      ]}"
      exec ${pkgs.bash}/bin/bash ${../scripts/fleet-auto.sh}
    '';
  };
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = lib.mkForce false;
      KbdInteractiveAuthentication = lib.mkForce false;
      PermitRootLogin = lib.mkForce "prohibit-password";
    };
  };
  # The person at the machine installs it. Root stays locked; nixos has
  # passwordless sudo only on this live image.
  services.getty.autologinUser = lib.mkForce "nixos";
  security.sudo.extraRules = [{
    users = [ "nixos" ];
    commands = [{ command = "ALL"; options = [ "NOPASSWD" "SETENV" ]; }];
  }];
  users.users.nixos.extraGroups = [ "wheel" ];
  users.allowNoPasswordLogin = settings.sshKeys == [ ];
  users.mutableUsers = false;
  users.users.root = {
    hashedPassword = lib.mkForce "!";
    initialPassword = lib.mkForce null;
    initialHashedPassword = lib.mkForce null;
    openssh.authorizedKeys.keys = settings.sshKeys;
  };
  # The minimal CD creates a nixos user and sets a password. Lock it. The
  # console is autologin. SSH still requires a key from settings.sshKeys.
  users.users.nixos = {
    hashedPassword = lib.mkForce "!";
    initialPassword = lib.mkForce null;
    initialHashedPassword = lib.mkForce null;
  };
  boot.zfs.forceImportRoot = false;
}
