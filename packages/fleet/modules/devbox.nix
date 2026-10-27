{ config, lib, pkgs, settings, ... }: let
  # sshd reads bootstrap public keys as root; the development user cannot
  # modify fleet state, role keys, or the system's Git-managed configuration.
  keys = pkgs.writeShellScript "devbox-authorized-keys" ''
    set -eu
    [ "$1" = dev ] || exit 0
    file=/nix/fleet-state/devbox/authorized_keys
    [ -f "$file" ] || exit 0
    exec ${pkgs.coreutils}/bin/cat "$file"
  '';
in {
  assertions = [
    { assertion = settings.role == "devbox"; message = "The devbox module belongs only to the devbox role."; }
    { assertion = !(config.systemd.services ? fleet-capacity); message = "A devbox must never start CI runners."; }
    { assertion = settings.secretsFile == null || settings.secretsFile == ../secrets/devbox.yaml;
      message = "A devbox must use its own secrets/devbox.yaml file."; }
    { assertion = config.users.users.dev.home == "/nix/devbox"; message = "The devbox home must persist across tmpfs-root reboots."; }
  ];
  users.users.dev = {
    isNormalUser = true;
    home = "/nix/devbox";
    createHome = true;
    hashedPassword = "!";
    openssh.authorizedKeys.keys = settings.sshKeys;
  };
  services.openssh.settings = {
    AuthorizedKeysCommand = "/run/fleet/devbox-authorized-keys %u";
    AuthorizedKeysCommandUser = "root";
  };
  # OpenSSH rejects AuthorizedKeysCommand below a group-writable directory.
  # /nix/store is group-writable for builds. Copy, never symlink, the command
  # into a root-owned runtime directory before sshd accepts connections.
  systemd.services.sshd.preStart = lib.mkBefore ''
    ${pkgs.coreutils}/bin/install -D -m 0755 ${keys} /run/fleet/devbox-authorized-keys
  '';
  programs.nix-ld.enable = true;
  environment.systemPackages = with pkgs; [
    bun nodejs python3 gcc gnumake cmake pkg-config just ripgrep fd
    tmux gh rsync zip unzip
  ];
  systemd.tmpfiles.rules = [
    "d /nix/devbox 0700 dev users -"
    "d /nix/fleet-state/devbox 0700 root root -"
  ];
  users.motd = ''
    Remote fleet devbox. Connect as dev; /nix/devbox survives reboots.
    Use nix develop and nix profile for project tools. System configuration
    continues to come from Git; the dev user has no administrator privileges.
    Reinstalling into any role erases the workspace. Back it up first.
  '';
}
