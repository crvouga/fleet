{ lib, pkgs, settings, ... }: let
  tools = import ./fleet-tools.nix { inherit lib pkgs; };
in {
  imports = [ ./runners.nix ./cache.nix ];
  _module.args.registrationProvider = lib.mkDefault null;
  _module.args.drainProvider = lib.mkDefault null;
  programs.nix-ld.enable = true;
  virtualisation.podman = lib.mkIf settings.containers { enable = true; dockerCompat = true; };
  # Start slot-1..slot-N from the live count (/run/fleet/slot-count, which the
  # fleet API's capacity settings can change). The other units exist in this
  # closure and stay stopped. systemctl start is synchronous enough that
  # multi-user waits until those units have been started. The agent restarts
  # this unit after a capacity change: it starts the missing slots and stops
  # the surplus ones that are idle. A slot with a job is never stopped; it is
  # listed in /run/fleet/capacity-pending and the agent asks again.
  systemd.services.fleet-capacity = {
    description = "Start the runner slots this machine can hold";
    wantedBy = [ "multi-user.target" ];
    after = [ "node-identity.service" ];
    requires = [ "node-identity.service" ];
    path = [ pkgs.systemd pkgs.coreutils pkgs.util-linux ];
    serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
    script = ''
      count=$(tr -d '[:space:]' < /run/fleet/slot-count)
      case "$count" in
        ""|*[!0-9]*) echo 'slot count is not a number' >&2; exit 1 ;;
      esac
      if [ "$count" -lt 1 ]; then
        echo 'slot count must be at least 1' >&2
        exit 1
      fi
      # runners.enabled = false or runners.cordoned = true (fleet API): no slot runs.
      enabled=$(${tools.fleetconf}/bin/fleetconf get runners.enabled true 2>/dev/null) || enabled=true
      cordoned=$(${tools.fleetconf}/bin/fleetconf get runners.cordoned false 2>/dev/null) || cordoned=false
      if [ "$enabled" = false ] || [ "$cordoned" = true ]; then
        echo 'runners are disabled or cordoned by the fleet configuration; no slot is started'
        exit 0
      fi
      units=()
      n=1
      while [ "$n" -le "$count" ]; do
        units+=("github-runner-slot-$n.service")
        n=$((n + 1))
      done
      systemctl start "''${units[@]}"
      pending=()
      n=$((count + 1))
      while [ "$n" -le ${toString settings.capacity.slotMax} ]; do
        unit="github-runner-slot-$n.service"
        if systemctl is-active --quiet "$unit"; then
          # Same lock as the job-start hook, so a job cannot begin between the check and the stop.
          if ! (
            exec 9>/run/fleet/gate
            flock 9
            [ ! -e "/run/fleet/slot-$n/busy" ] && systemctl stop "$unit"
          ); then
            pending+=("slot-$n")
          fi
        fi
        n=$((n + 1))
      done
      if [ "''${#pending[@]}" -gt 0 ]; then
        printf '%s\n' "''${pending[@]}" > /run/fleet/capacity-pending
        echo "busy slots left running above the count: ''${pending[*]}"
      else
        rm -f /run/fleet/capacity-pending
      fi
    '';
  };
  # GitHub App key and cache signing material stay on runner hosts only.
  sops.secrets = lib.mkIf (settings.secretsFile != null) ({
    github-app-key = { mode = "0400"; };
  } // lib.optionalAttrs settings.cache.remote.enable {
    cache-credentials = { mode = "0400"; };
    cache-signing-key = { mode = "0400"; };
  });
}
