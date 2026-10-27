{ pkgs, lib, roles }: let
  # Check every deployable role, including capability variants. A role that
  # drops automatic recovery must fail CI before any node can pull it.
  recoverable = system: let
    config = system.config;
    service = config.systemd.services.fleet-sync or null;
    timer = config.systemd.timers.fleet-sync or null;
  in service != null && timer != null
    && lib.elem "timers.target" timer.wantedBy
    && (timer.timerConfig.OnBootSec or null) != null
    && (timer.timerConfig.OnUnitInactiveSec or null) != null
    && !(timer.timerConfig.Persistent or false)
    && service.serviceConfig.Type == "oneshot"
    && !(service.serviceConfig.RemainAfterExit or false)
    && !service.restartIfChanged
    && lib.hasInfix "fleet-sync.sh" service.serviceConfig.ExecStart
    && config.environment.etc ? "fleet/sync.env";
  broken = lib.attrNames (lib.filterAttrs (_: system: !(recoverable system)) roles);
in pkgs.runCommand "fleet-update-units" { } (
  if broken == [ ] then "mkdir -p $out"
  else "echo 'roles without automatic update recovery: ${lib.concatStringsSep ", " broken}' >&2; exit 1"
)
