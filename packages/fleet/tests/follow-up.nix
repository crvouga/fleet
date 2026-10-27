{ pkgs, lib, sopsModule, diskoModule }: let
  settings = import ../fleet.nix;
  state = "/nix/fleet-state/sync-test";
  origin = "/nix/fleet-state/test-origin";
  # Substitute fixture closures; Git, nix-env, timers, timeouts and the final
  # two NixOS activations remain real. No physical devices are involved.
  mockNix = pkgs.writeShellScriptBin "nix" ''
    set -euo pipefail
    jobs=""; previous=""; flake=""
    for arg in "$@"; do
      if [ "$previous" = --max-jobs ]; then jobs=$arg; fi
      previous=$arg
      case "$arg" in git+file:*) flake=$arg ;; esac
    done
    [ "$jobs" = 2 ]; [ -n "$flake" ]
    checkout=''${flake#git+file://}
    checkout=''${checkout%%\?*}/packages/fleet
    revision=$(${pkgs.git}/bin/git -C "$checkout" rev-parse HEAD)
    mkdir -p ${state}
    echo "$revision" >> ${state}/lookups
    if [ -e ${state}/cache-unavailable ]; then exit 1; fi
    if [ -f "$checkout/REAL_GENERATION" ]; then
      cat "${state}/real-$(cat "$checkout/REAL_GENERATION")"
      exit 0
    fi
    if [ -f "$checkout/SLOW" ] && [ ! -e ${state}/slow-completed ]; then
      sleep 8
      touch ${state}/slow-completed
    fi
    kernel=$(mktemp)
    echo same > "$kernel"
    kernel_store=$(${pkgs.nix}/bin/nix-store --add "$kernel")
    mkdir -p /nix/var/nix/gcroots
    ln -sfn "$kernel_store" "/nix/var/nix/gcroots/''${kernel_store##*/}"
    work=$(mktemp -d)
    mkdir -p "$work/bin"
    for name in kernel initrd kernel-modules; do ln -s "$kernel_store" "$work/$name"; done
    echo "$kernel_store" > "$work/kernel-path"
    echo "$revision" > "$work/commit"
    cat > "$work/bin/switch-to-configuration" <<SCRIPT
#!${pkgs.runtimeShell}
echo "$revision" >> ${state}/activations
SCRIPT
    if [ -e "$checkout/HANG" ]; then
      printf 'trap "" TERM\nsleep 90\n' >> "$work/bin/switch-to-configuration"
    fi
    if [ -e "$checkout/STOP_TIMER" ]; then
      echo '${pkgs.systemd}/bin/systemctl stop fleet-sync.timer' >> "$work/bin/switch-to-configuration"
    else
      echo '${pkgs.systemd}/bin/systemctl start fleet-sync.timer' >> "$work/bin/switch-to-configuration"
    fi
    chmod +x "$work/bin/switch-to-configuration"
    toplevel=$(${pkgs.nix}/bin/nix-store --add "$work")
    # Root the toplevel too, as the real nix build's output is. Unrooted, a
    # garbage collection before fleet-sync selects it fails the switch with
    # "is required, but there is no substituter that can build it".
    ln -sfn "$toplevel" "/nix/var/nix/gcroots/''${toplevel##*/}"
    test -e "$toplevel/kernel"
    test -e "$toplevel/initrd"
    test -e "$toplevel/kernel-modules"
    echo "$toplevel"
  '';
  health = pkgs.writeShellScript "fleet-health" ''
    test ! -e ${state}/fail-health
  '';
  testSettings = settings // {
    fleetApi = { url = ""; };
    secretsFile = null;
    fleetNix = "${mockNix}/bin/nix";
    fleetHealth = "${health}";
    repo = settings.repo // { url = "file://${origin}"; timer = true; pollSeconds = 3; };
    reboot = settings.reboot // { delayMaxSeconds = 0; };
    binaryCache = { url = "https://cache.invalid/fleet"; publicKey = "cache.invalid-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; };
  };
in pkgs.testers.runNixOSTest {
  name = "fleet-follow-up";
  node.specialArgs = { settings = testSettings; revision = "follow-up-rev"; };
  nodes.machine = {
    imports = [ sopsModule diskoModule ../modules/base.nix ];
    disko.enableConfig = lib.mkForce false;
    boot.loader.systemd-boot.enable = lib.mkForce false;
    users.users.root.hashedPassword = lib.mkForce null;
    environment.systemPackages = [ pkgs.git ];
    virtualisation = {
      memorySize = 2048;
      cores = 2;
      diskSize = 4096;
      writableStore = true;
      # The normal VM overlay is tmpfs. Recovery tests must retain real store
      # objects across the reboot, just like an installed node's /nix volume.
      writableStoreUseTmpfs = false;
    };
    systemd.timers.fleet-sync.timerConfig = {
      OnBootSec = lib.mkForce "5s";
      RandomizedDelaySec = lib.mkForce "0";
      AccuracySec = lib.mkForce "1ms";
    };
    systemd.services.fleet-sync.environment = {
      FLEET_ACTIVATION_TIMEOUT = "180";
      FLEET_TIMEOUT_KILL_AFTER = "1";
    };
    specialisation.updated.configuration = {
      environment.etc."fleet-sync-test-generation".text = "updated";
      systemd.services.fleet-sync.description = lib.mkForce "Updated automatic pull agent";
    };
    specialisation.following.configuration = {
      environment.etc."fleet-sync-test-generation".text = "following";
      systemd.services.fleet-sync.description = lib.mkForce "Following automatic pull agent";
    };
  };
  testScript = ''
    start_all()
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("fleet-sync.timer")
    machine.succeed(r"""
      set -eu
      mkdir -p ${origin}/packages/fleet ${state}
      git init -b main ${origin}
      git -C ${origin} config user.email test@example.invalid
      git -C ${origin} config user.name test
      echo first > ${origin}/packages/fleet/marker
      readlink -f /run/current-system/specialisation/updated > ${state}/real-updated
      readlink -f /run/current-system/specialisation/following > ${state}/real-following
      # Fixture kernels are not the guest kernel; real boot fallback has its
      # own tests. These synthetic generations exercise in-place switches.
      rm -f /run/booted-system
    """)

    def commit(name, root="${origin}"):
        return machine.succeed(f"git -C {root} add packages && git -C {root} commit --allow-empty -m {name} >/dev/null && git -C {root} rev-parse HEAD").strip()

    def converged(revision):
        machine.wait_until_succeeds(f"test $(cat /nix/fleet-state/sync/last-success) = {revision}", timeout=120)
        machine.succeed("systemctl is-active --quiet fleet-sync.timer && systemctl is-enabled --quiet fleet-sync.timer")
        machine.succeed("test ! -e /nix/fleet-state/sync/health-failure")

    with subtest("the real timer applies an initial revision and a slow follow-up"):
        first = commit("first")
        converged(first)
        machine.succeed("touch ${origin}/packages/fleet/SLOW")
        slow = commit("slow")
        converged(slow)
        following = commit("after-slow")
        converged(following)

    with subtest("offline reboot and missed releases recover without running sync by hand"):
        machine.succeed("mv ${origin} ${origin}-offline")
        missed = commit("missed", "${origin}-offline")
        latest = commit("latest", "${origin}-offline")
        machine.wait_until_succeeds("test -s /nix/fleet-state/sync/health-failure", timeout=120)
        machine.succeed(f"test $(cat /nix/fleet-state/sync/last-success) = {following}")
        machine.shutdown()
        machine.start()
        machine.wait_for_unit("multi-user.target")
        machine.wait_for_unit("fleet-sync.timer")
        machine.succeed(f"test $(cat /nix/var/nix/profiles/system/commit) = {following}")
        machine.succeed("rm -f /run/booted-system; touch ${state}/cache-unavailable; mv ${origin}-offline ${origin}")
        machine.wait_until_succeeds(f"grep -qx {latest} ${state}/lookups", timeout=120)
        machine.succeed(f"test $(cat /nix/fleet-state/sync/last-success) = {following}")
        machine.succeed(f"! grep -qx {missed} ${state}/activations")
        machine.succeed("rm ${state}/cache-unavailable")
        converged(latest)

    with subtest("failed post-activation connectivity rolls back and retries the same revision"):
        machine.succeed("touch ${state}/fail-health")
        unhealthy = commit("unhealthy-connectivity")
        machine.wait_until_succeeds("grep -q 'mode=switch' /nix/fleet-state/sync/health-failure", timeout=120)
        machine.wait_until_succeeds(f"test $(cat /nix/var/nix/profiles/system/commit) = {latest}", timeout=120)
        machine.succeed("rm ${state}/fail-health")
        converged(unhealthy)
        latest = unhealthy

    with subtest("an update that stops its timer rolls back and future code repairs it"):
        machine.succeed("touch ${origin}/packages/fleet/STOP_TIMER")
        broken = commit("stop-timer")
        machine.wait_until_succeeds("grep -q 'timer is not active' /nix/fleet-state/sync/health-failure", timeout=120)
        machine.succeed(f"test $(cat /nix/fleet-state/sync/last-success) = {latest}")
        machine.wait_until_succeeds(f"test $(cat /nix/var/nix/profiles/system/commit) = {latest}", timeout=120)
        machine.succeed("rm ${origin}/packages/fleet/STOP_TIMER")
        repaired = commit("restore-timer")
        converged(repaired)

    with subtest("a hung activation is killed, rolled back and retried automatically"):
        machine.succeed("mkdir -p /run/systemd/system/fleet-sync.service.d; printf '[Service]\\nEnvironment=FLEET_ACTIVATION_TIMEOUT=2\\n' > /run/systemd/system/fleet-sync.service.d/timeout.conf; systemctl daemon-reload")
        machine.succeed("touch ${origin}/packages/fleet/HANG")
        hung = commit("hang")
        machine.wait_until_succeeds("grep -q FLEET_ACTIVATION_FAILED /nix/fleet-state/sync/health-failure", timeout=60)
        machine.succeed(f"test $(cat /nix/fleet-state/sync/last-success) = {repaired}")
        machine.wait_until_succeeds(f"test $(cat /nix/var/nix/profiles/system/commit) = {repaired}", timeout=120)
        machine.succeed("rm ${origin}/packages/fleet/HANG")
        recovered = commit("after-hang")
        converged(recovered)
        machine.succeed("rm /run/systemd/system/fleet-sync.service.d/timeout.conf; systemctl daemon-reload")

    with subtest("real NixOS activations preserve the updater while changing its own unit"):
        machine.succeed("echo updated > ${origin}/packages/fleet/REAL_GENERATION")
        updated = commit("real-update")
        converged(updated)
        machine.succeed("grep -qx updated /etc/fleet-sync-test-generation")
        machine.succeed("echo following > ${origin}/packages/fleet/REAL_GENERATION")
        final = commit("real-follow-up")
        converged(final)
        machine.succeed("grep -qx following /etc/fleet-sync-test-generation")
        machine.succeed("test $(systemctl show fleet-sync.service -p ExecMainStatus --value) = 0")
  '';
}
