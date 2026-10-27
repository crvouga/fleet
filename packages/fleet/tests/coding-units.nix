{ pkgs, lib, roles }: let
  ready = system: let
    config = system.config;
    names = map lib.getName config.environment.systemPackages;
    user = config.users.users.agent or null;
    check = config.systemd.services.fleet-coding-check or null;
    desktop = config.systemd.services.fleet-code-desktop or null;
  in lib.all (name: lib.elem name names) [ "fleet-code" "omp" "chromium" "claude-code" "codex" ]
    && !(lib.elem "pi-coding-agent" names)
    && user != null && user.uid == 1100 && user.group == "agent"
    && user.home == "/nix/fleet-code" && user.hashedPassword == "!"
    && user.extraGroups == [ ]
    && lib.elem "d /nix/fleet-code 0700 agent agent -" config.systemd.tmpfiles.rules
    && lib.hasInfix "Match User agent" config.services.openssh.extraConfig
    && lib.hasInfix "/bin/fleet-code-ssh" config.services.openssh.extraConfig
    && lib.hasInfix "AllowTcpForwarding local" config.services.openssh.extraConfig
    && lib.hasInfix "PermitOpen [/run/fleet-code-desktop/web.sock]:*" config.services.openssh.extraConfig
    && lib.hasInfix "AllowStreamLocalForwarding local" config.services.openssh.extraConfig
    && desktop != null && lib.elem "multi-user.target" desktop.wantedBy
    && desktop.serviceConfig.User == "agent"
    && desktop.serviceConfig.RuntimeDirectoryMode == "0700"
    && lib.hasInfix "-rfbport -1" desktop.script
    && lib.hasInfix "--unix-listen=/run/fleet-code-desktop/web.sock" desktop.script
    && check != null && lib.elem "multi-user.target" check.wantedBy
    && check.serviceConfig.User == "agent"
    && lib.elem "fleet-code-desktop.service" check.wants
    && lib.hasInfix "--unix-socket /run/fleet-code-desktop/web.sock" check.script
    && config.environment.etc ? "fleet/coding.md";
  broken = lib.attrNames (lib.filterAttrs (_: system: !(ready system)) roles);
in assert lib.assertMsg (broken == [ ])
  "closures without the coding harness: ${lib.concatStringsSep ", " broken}";
  pkgs.runCommand "fleet-coding-units" { } "mkdir -p $out"
