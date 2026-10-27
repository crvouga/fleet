{ lib, pkgs, settings, ... }: let
  tools = import ./coding-package.nix { inherit lib pkgs; };
in {
  imports = [ ./coding-desktop.nix ];
  # Subscription credentials belong to the person using this account. They
  # never enter sops, the Nix store, runner environments or the fleet API.
  environment.systemPackages = [
    tools.session tools.ssh tools.browser pkgs.omp
    pkgs.claude-code pkgs.codex pkgs.chromium pkgs.ripgrep pkgs.tmux pkgs.xdg-utils
  ];
  environment.etc."fleet/coding.md".source = ../docs/coding.md;
  environment.etc."fleet/coding-agent.md".source = ../docs/coding-agent.md;
  users.groups.agent.gid = 1100;
  users.users.agent = {
    isNormalUser = true;
    uid = 1100;
    group = "agent";
    home = "/nix/fleet-code";
    createHome = true;
    hashedPassword = "!";
    openssh.authorizedKeys.keys = settings.sshKeys;
  };
  systemd.tmpfiles.rules = [ "d /nix/fleet-code 0700 agent agent -" ];
  # A broken/missing native client becomes a failed unit in the existing fleet
  # readiness report. No login, paid inference or credential inspection at boot.
  systemd.services.fleet-coding-check = {
    description = "Verify the installed coding harness and native clients";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-tmpfiles-setup.service" "fleet-code-desktop.service" ];
    wants = [ "fleet-code-desktop.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "agent";
      Group = "agent";
      WorkingDirectory = "/nix/fleet-code";
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ReadWritePaths = [ "/nix/fleet-code" ];
    };
    script = ''
      ${tools.session}/bin/fleet-code --version
      ${pkgs.chromium}/bin/chromium --version
      ${pkgs.claude-code}/bin/claude --version
      ${pkgs.codex}/bin/codex --version
      # A restarting desktop may never appear in `systemctl --failed`.
      # Probe the actual private HTTP endpoint so it cannot look ready merely
      # because its supervisor is running. No login or model request is made.
      for _attempt in $(${pkgs.coreutils}/bin/seq 1 30); do
        if [ -S /run/fleet-code-desktop/vnc.sock ] && \
          ${pkgs.curl}/bin/curl --fail --silent --max-time 2 \
            --unix-socket /run/fleet-code-desktop/web.sock \
            http://localhost/vnc.html --output /dev/null; then
          exit 0
        fi
        sleep 1
      done
      echo 'fleet-coding-check: private authentication desktop is unavailable' >&2
      exit 1
    '';
  };
  # An SSH connection opens a conversation. Original commands are parsed as
  # harness arguments, never interpreted by a shell. No new network listener.
  services.openssh.extraConfig = ''
    Match User agent
      ForceCommand ${tools.ssh}/bin/fleet-code-ssh
      # OpenSSH shares the local TCP/Unix forwarding permission gate. PermitOpen
      # compares this literal path for Unix channels and rejects TCP hostnames.
      AllowTcpForwarding local
      PermitOpen [/run/fleet-code-desktop/web.sock]:*
      AllowStreamLocalForwarding local
      AllowAgentForwarding no
      X11Forwarding no
      PermitUserRC no
      AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u
    Match all
  '';
}
