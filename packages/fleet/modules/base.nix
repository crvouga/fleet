{ lib, pkgs, settings, revision, ... }: let
  fleetTools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  imports = [
    ./disks/internal.nix
    ./hardware/generic.nix
    ./wifi.nix
    ./capabilities/high-mem.nix
    ./identity.nix
    ./sync.nix
    ./revision.nix
    ./drift.nix
    ./agent.nix
    ./onboarding.nix
    ./boot-health.nix
    ./console.nix
    ./recovery.nix
    ./coding.nix
  ];
  # The module system ignores `revision ? null` and throws if the argument is
  # absent. Tests omit it. The flake passes the real commit via specialArgs,
  # which wins over this default.
  _module.args.revision = lib.mkDefault "unknown";
  system.stateVersion = "26.05";
  systemd.services.fleet-recover-handoff = {
    description = "Recover the original node after an installer boot falls back";
    wantedBy = [ "multi-user.target" ];
    after = [ "node-identity.service" "network-online.target" ];
    wants = [ "network-online.target" ];
    unitConfig.ConditionPathExists = "/nix/fleet-state/handoff";
    path = [ pkgs.python3 pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.bash}/bin/bash ${../scripts/recover-handoff.sh}";
      Environment = "FLEET_RESUME=/run/current-system/sw/bin/fleet-resume";
    };
  };
  boot.loader.timeout = 5;
  boot.loader.systemd-boot.enable = true;
  boot.loader.systemd-boot.configurationLimit = settings.bootGenerationLimit;
  boot.loader.efi.canTouchEfiVariables = true;
  # Newest entry gets tries-left. See scripts/boot-count.sh. This pin has no
  # boot-counting module option. graceful is not fallback.
  boot.loader.systemd-boot.extraInstallCommands = ''
    export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.findutils pkgs.gawk ]}:$PATH
    export FLEET_ESP=/boot
    export FLEET_BOOT_TRIES=${toString settings.bootTries}
    ${pkgs.bash}/bin/bash ${../scripts/boot-count.sh}
  '';
  # No static hostname. hostnamed prefers /etc/hostname, and that file is
  # read-only on NixOS, so a transient name would never be applied.
  # Wired DHCP is matched by device type in the generic hardware profile.
  networking.hostName = "";
  networking.firewall = { enable = true; allowedTCPPorts = [ 22 ]; };
  time.timeZone = "UTC";
  services.openssh = {
    enable = true;
    settings = { PasswordAuthentication = false; KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password"; };
    hostKeys = [ { path = "/nix/fleet-state/ssh/ssh_host_ed25519_key"; type = "ed25519"; } ];
  };
  users.mutableUsers = false;
  # An empty sshKeys list is valid. Remote login stays closed until a commit
  # adds keys. The installer console does not need them.
  users.allowNoPasswordLogin = settings.sshKeys == [ ];
  users.users.root = { hashedPassword = "!"; openssh.authorizedKeys.keys = settings.sshKeys; };
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    auto-optimise-store = false;
    min-free = 2 * 1024 * 1024 * 1024;
    max-free = 8 * 1024 * 1024 * 1024;
  } // lib.optionalAttrs (
    settings.binaryCache.url != null
    && settings.binaryCache.publicKey != null
    && !(lib.hasInfix "TODO" settings.binaryCache.url)
    && !(lib.hasInfix "TODO" settings.binaryCache.publicKey)
  ) {
    extra-substituters = [ settings.binaryCache.url ];
    extra-trusted-public-keys = [ settings.binaryCache.publicKey ];
  };
  nix.gc = { automatic = true; dates = "weekly"; options = "--delete-older-than 14d"; };
  nix.optimise = { automatic = true; dates = [ "03:00" ]; };
  environment.systemPackages = with pkgs; [
    git pciutils ethtool nvme-cli jq kexec-tools
    (import ./installer-package.nix { inherit pkgs lib revision; })
    (writeShellScriptBin "fleet-remove" ''
      export PATH=${lib.makeBinPath [ bash python3 curl coreutils ]}:$PATH
      exec ${bash}/bin/bash ${../scripts/fleet-node.sh} remove
    '')
  ];
  # Hardware watchdog: a hung userspace stops petting /dev/watchdog and the
  # firmware reboots. RebootWatchdogSec covers a reboot that never finishes.
  # softdog is not a substitute. Boot counting covers a generation that never
  # reaches userspace.
  systemd.settings.Manager = { RuntimeWatchdogSec = "30s"; RebootWatchdogSec = "5min"; };
  # The root is tmpfs, so the journal lives in RAM. Cap it. Logs stay on the
  # node; the heartbeat to the fleet API carries failed units and rollbacks.
  services.journald.storage = "volatile";
  services.journald.extraConfig = ''
    RuntimeMaxUse=256M
    MaxRetentionSec=2week
  '';
  boot.kernel.sysctl."kernel.panic" = 10;
  boot.kernel.sysctl."kernel.panic_on_oops" = 1;
  systemd.tmpfiles.rules = [
    "d /nix/fleet-state 0700 root root -"
    "d /nix/fleet-state/ssh 0700 root root -"
    "d /nix/fleet-state/secrets 0700 root root -"
    "d /run/fleet 0755 root root -"
  ];
  # The console screen (console.nix) shows the age public key and host fingerprint.
  # Local signal. A failed unit is the alert, and fleet-agent reports failed
  # units to the fleet API. Nothing scrapes 127.0.0.1:9101.
  systemd.services.fleet-disk = {
    description = "Fail when /nix or /boot is too full";
    serviceConfig.Type = "oneshot";
    path = [ pkgs.coreutils pkgs.gawk ];
    script = ''
      set -eu
      install -d -m 0755 /run/fleet
      : > /run/fleet/disk-alert
      # The fleet API may change the threshold (disk.alertPercent). A missing or
      # unusable setting leaves the value built into this image.
      threshold=$(${fleetTools.fleetconf}/bin/fleetconf get disk.alertPercent ${toString settings.disk.alertPercent} 2>/dev/null) || threshold=${toString settings.disk.alertPercent}
      case "$threshold" in
        ""|*[!0-9]*) threshold=${toString settings.disk.alertPercent} ;;
      esac
      fail=0
      for mount in /nix /boot; do
        if [ ! -d "$mount" ]; then
          continue
        fi
        used=$(df -P "$mount" | awk 'NR==2 { gsub("%","",$5); print $5 }')
        printf '%s %s\n' "$mount" "$used" >> /run/fleet/disk-alert
        if [ "$used" -ge "$threshold" ]; then
          echo "fleet-disk: $mount is ''${used}% full" >&2
          fail=1
        fi
      done
      exit "$fail"
    '';
  };
  systemd.timers.fleet-disk = {
    wantedBy = [ "timers.target" ];
    timerConfig = { OnBootSec = "5min"; OnUnitActiveSec = "15min"; };
  };
  systemd.services.fleet-age-rotate = lib.mkIf (settings.rotateAgeKey or false) {
    description = "Install a rotated age key from sops";
    wantedBy = [ "multi-user.target" ];
    after = [ "sops-install-secrets.service" ];
    wants = [ "sops-install-secrets.service" ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      set -eu
      next=/run/secrets/age-key-next
      dest=/nix/fleet-state/secrets/age.key
      [ -s "$next" ]
      if [ -f "$dest" ] && cmp -s "$next" "$dest"; then
        exit 0
      fi
      install -d -m 0700 /nix/fleet-state/secrets
      install -m 0600 "$next" "$dest.next"
      mv "$dest.next" "$dest"
    '';
  };
  # Age key path and sops file only. Role modules declare their own secrets.
  # A CI runner and a web server must not be given the same key or file.
  sops = lib.mkIf (settings.secretsFile != null) {
    defaultSopsFile = settings.secretsFile;
    age = { keyFile = "/nix/fleet-state/secrets/age.key"; generateKey = false; sshKeyPaths = [ ]; };
    gnupg.sshKeyPaths = [ ];
    secrets = lib.mkIf (settings.rotateAgeKey or false) {
      age-key-next = { mode = "0400"; restartUnits = [ "fleet-age-rotate.service" ]; };
    };
  };
  assertions = [
    {
      assertion = settings.bootTries >= 1;
      message = "bootTries is the tries-left count on the newest systemd-boot entry.";
    }
    {
      assertion = settings.disk.alertPercent >= 50 && settings.disk.alertPercent <= 99;
      message = "disk.alertPercent is the /nix and /boot fullness threshold.";
    }
    {
      assertion = (settings.rotateAgeKey or false) -> settings.secretsFile != null;
      message = "rotateAgeKey needs this role's secretsFile, with secret age-key-next.";
    }
  ];
}
