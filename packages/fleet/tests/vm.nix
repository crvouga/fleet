{ pkgs, lib, settings, sopsModule, diskoModule }: let
  mock = pkgs.callPackage ({ nodeRuntimes ? [] }: pkgs.runCommand "mock-github-runner" {} ''
    mkdir -p $out/bin
    cat > $out/bin/Runner.Listener <<'MOCK'
#!${pkgs.bash}/bin/bash
set -eu
case "$1" in
  configure)
    test -s "$RUNNER_ROOT/.new-token"
    test -n "$ACTIONS_RUNNER_INPUT_NAME"
    for name in .credentials .credentials_rsaparams .runner; do
      printf '{}' > "$RUNNER_ROOT/$name"
    done
    ;;
  run)
    # A job shell must resolve tools through the service PATH, not a root
    # login shell or the absolute interpreter used to launch this mock.
    bash --noprofile --norc -euo pipefail -c '
      for tool in bash git gh nix; do command -v "$tool"; "$tool" --version; done
      test "$(cat "$FLEET_PREREQUISITE_STATUS")" = ok
    ' > "/run/fleet/$FLEET_SLOT/job-tools"
    exec ${pkgs.coreutils}/bin/sleep infinity
    ;;
  *) exit 2 ;;
esac
MOCK
    chmod +x $out/bin/Runner.Listener
  '') {};
  testSettings = settings // {
    # The VM has no route to the fleet API. Leave the agent out so the test stays offline.
    fleetApi = { url = ""; };
    secretsFile = null;
    # 2 cores and about 3 GiB must still start both slots. Production constants
    # would start one. highMemGiB stays at 60, so this VM is not high-mem.
    capacity = settings.capacity // {
      slotMax = 2;
      reserveGiB = 0;
      perRunnerGiB = 1;
      perRunnerCores = 1;
    };
    github = settings.github // { organization = "mock-org"; appId = "123"; installationId = "456"; };
    cache = settings.cache // { remote = settings.cache.remote // { enable = false; }; };
  };
in pkgs.testers.runNixOSTest {
  name = "fleet";
  node.specialArgs = { settings = testSettings; };
  nodes.machine = { config, ... }: {
    imports = [ sopsModule diskoModule ../hosts/ci.nix ];
    # The VM root is the test image. Disko still evaluates, but must not mount the host disk layout.
    disko.enableConfig = lib.mkForce false;
    _module.args = {
      registrationProvider = pkgs.writeShellScript "mock-registration" ''
        install -d -m 0700 /run/fleet/tokens
        printf 'mock-registration' > "$7"
        chmod 0600 "$7"
      '';
      # writeShellScriptBin is /bin/sh. compgen is bash-only, and a missing
      # command here was ignored, so a busy slot still looked drained.
      drainProvider = pkgs.writeShellScriptBin "runner-control" ''
        [ ! -e /run/fleet/remote-drain-failed ] || exit 75
        for busy in /run/fleet/*/busy; do
          [ -e "$busy" ] && exit 1
        done
        exit 0
      '';
    };
    boot.loader.systemd-boot.enable = lib.mkForce false;
    users.users.root.hashedPassword = lib.mkForce null;
    services.github-runners = lib.genAttrs [ "slot-1" "slot-2" ] (id: {
      package = mock;
      extraPackages = lib.mkBefore (lib.optional (id == "slot-2")
        (pkgs.writeShellScriptBin "gh" ''
          [ ! -e /run/fleet/block-gh ] || exit 91
          exec ${pkgs.gh}/bin/gh "$@"
        ''));
    });
    environment.etc."ci-fleet-vm-test".text = ''
      firewall=${lib.boolToString config.networking.firewall.enable}
      sshPorts=${lib.concatStringsSep "," (map toString config.networking.firewall.allowedTCPPorts)}
      nixLd=${lib.boolToString config.programs.nix-ld.enable}
      watchdog=${config.systemd.settings.Manager.RuntimeWatchdogSec}
    '';
    # Test persistence and disposable root without touching a physical disk.
    virtualisation = { memorySize = 3072; cores = 2; writableStore = true; };
  };
  nodes.client = { pkgs, ... }: { environment.systemPackages = [ pkgs.netcat-openbsd ]; };
  # The other node is reached by address. The hostname is assigned at boot.
  testScript = { nodes, ... }: ''
    start_all()
    machine.wait_for_unit("multi-user.target")
    # Run the native wizard and its real helper inside NixOS.
    # --selftest writes temporary regular files, never a block device.
    machine.succeed("fleet-installer --selftest | grep -F 'SELFTEST OK'", timeout=120)
    machine.succeed("fleet-node --help | grep -- --reinstall")
    machine.succeed("command -v kexec lsblk findmnt")
    machine.wait_for_unit("github-runner-slot-1.service")
    machine.wait_for_unit("github-runner-slot-2.service")
    for slot in ("slot-1", "slot-2"):
        machine.succeed(f"grep -qx ok /run/fleet/{slot}/prerequisites")
        machine.succeed(f"grep -F 'gh version' /run/fleet/{slot}/job-tools")
        machine.succeed(f"test $(stat -c %U /run/fleet/{slot}/prerequisites) = {slot}")
        machine.succeed(f"test -z \"$(find /run/github-runner/{slot} -maxdepth 1 -name '.fleet-prerequisites.*' -print)\"")
    machine.succeed("hostname | grep -Eq '^ci-[0-9a-f]{4}$'")
    machine.succeed("grep -qx \"ACTIONS_RUNNER_INPUT_NAME=$(hostname)\" /run/fleet/identity")
    machine.succeed("grep -qx 2 /run/fleet/slot-count")
    machine.succeed("test -d /nix/ci-cache/slot-1 && test -d /nix/ci-cache/slot-2")
    machine.succeed("grep -qx nixLd=true /etc/ci-fleet-vm-test && test -e /run/current-system/sw/share/nix-ld/lib/ld.so")
    machine.succeed("grep -qx watchdog=30s /etc/ci-fleet-vm-test")
    machine.succeed("grep -qx firewall=true /etc/ci-fleet-vm-test && grep -qx sshPorts=22 /etc/ci-fleet-vm-test")
    client.wait_for_unit("multi-user.target")
    client.succeed("nc -z -w 5 ${nodes.machine.networking.primaryIPAddress} 22")
    machine.succeed("${pkgs.python3}/bin/python3 -m http.server 8765 --bind 0.0.0.0 >/tmp/firewall-probe.log 2>&1 &")
    machine.wait_for_open_port(8765)
    client.fail("nc -z -w 2 ${nodes.machine.networking.primaryIPAddress} 8765")
    machine.succeed("systemctl show -p RuntimeWatchdogUSec | grep '30s'")
    machine.succeed("su -s /bin/sh slot-1 -c 'echo disposable >/nix/ci-cache/slot-1/probe'")
    machine.fail("su -s /bin/sh slot-2 -c 'cat /nix/ci-cache/slot-1/probe'")
    machine.succeed("sshd -G -T -f /etc/ssh/sshd_config | grep -i '^passwordauthentication no$'")
    machine.succeed("test $(id -u slot-1) != $(id -u slot-2)")
    machine.succeed("test $(stat -c %a /run/fleet/tokens/slot-1) = 600")
    machine.succeed("fleet-drain 30")
    machine.fail("systemctl is-active --quiet github-runner-slot-1.service")
    machine.succeed("fleet-resume")
    machine.wait_for_unit("github-runner-slot-1.service")
    # Busy jobs must not be stopped at timeout; deployment must be blocked.
    machine.succeed("touch /run/fleet/slot-1/busy")
    machine.fail("fleet-drain 1")
    machine.succeed("systemctl is-active --quiet github-runner-slot-1.service")
    machine.succeed("rm /run/fleet/slot-1/busy; fleet-resume")
    machine.wait_for_unit("github-runner-slot-1.service")
    # Expired GitHub credentials must not block an OS repair. The local gate
    # still protects running jobs when remote label removal is unavailable.
    machine.succeed("touch /run/fleet/remote-drain-failed /run/fleet/slot-1/busy")
    machine.fail("fleet-drain 1")
    machine.succeed("systemctl is-active --quiet github-runner-slot-1.service")
    machine.succeed("rm /run/fleet/slot-1/busy; fleet-drain 10")
    machine.fail("systemctl is-active --quiet github-runner-slot-1.service")
    machine.succeed("rm /run/fleet/remote-drain-failed; fleet-resume")
    machine.wait_for_unit("github-runner-slot-1.service")
    # A oneshot is activating while ExecStart runs. Resume must respect that
    # state, then recover a stale lease after the interrupted updater stops.
    machine.succeed("systemctl stop fleet-sync.timer fleet-sync.service; mkdir -p /run/systemd/system/fleet-sync.service.d")
    machine.succeed("printf '[Service]\\nExecStart=\\nExecStart=${pkgs.coreutils}/bin/sleep infinity\\n' > /run/systemd/system/fleet-sync.service.d/test.conf; systemctl daemon-reload; systemctl --no-block start fleet-sync.service")
    machine.wait_until_succeeds("test $(systemctl show --property=ActiveState --value fleet-sync.service) = activating")
    machine.succeed("touch /run/fleet/draining /run/fleet/update-draining")
    machine.fail("fleet-resume")
    machine.succeed("test -e /run/fleet/draining && test -e /run/fleet/update-draining")
    machine.succeed("systemctl stop fleet-sync.service; fleet-resume")
    machine.succeed("test ! -e /run/fleet/draining && test ! -e /run/fleet/update-draining")
    machine.succeed("rm /run/systemd/system/fleet-sync.service.d/test.conf; systemctl daemon-reload")
    machine.fail("grep -F cache.invalid /etc/nix/nix.conf")
    # A tool present on PATH but unable to execute must prevent admission;
    # repairing it lets the normal service start replace the failed evidence.
    machine.succeed("touch /run/fleet/block-gh; systemctl stop github-runner-slot-2.service")
    machine.fail("systemctl start github-runner-slot-2.service")
    machine.succeed("grep -qx failed:tool:gh /run/fleet/slot-2/prerequisites")
    machine.fail("systemctl is-active --quiet github-runner-slot-2.service")
    machine.succeed("rm /run/fleet/block-gh; systemctl reset-failed github-runner-slot-2.service; systemctl restart github-runner-slot-2.service")
    machine.wait_for_unit("github-runner-slot-2.service")
    machine.succeed("grep -qx ok /run/fleet/slot-2/prerequisites")
  '';
}
