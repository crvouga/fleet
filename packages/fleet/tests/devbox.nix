{ pkgs, lib, sopsModule, diskoModule, ... }: let
  settings = import ../devbox.nix;
  coding = import ../modules/coding-package.nix { inherit pkgs lib; };
  key = pkgs.runCommand "devbox-test-key" { nativeBuildInputs = [ pkgs.openssh ]; } ''
    mkdir -p "$out"
    ssh-keygen -q -t ed25519 -N "" -f "$out/id"
  '';
in pkgs.testers.runNixOSTest {
  name = "fleet-devbox";
  node.specialArgs = { settings = settings // { repo = settings.repo // { timer = false; }; fleetApi = { url = ""; }; }; };
  nodes.machine = {
    imports = [ sopsModule diskoModule ../hosts/devbox.nix ];
    disko.enableConfig = lib.mkForce false;
    boot.loader.systemd-boot.enable = lib.mkForce false;
    users.users.root.hashedPassword = lib.mkForce null;
    virtualisation = { memorySize = 3072; cores = 2; writableStore = true; };
    systemd.services.test-devbox-key = {
      wantedBy = [ "multi-user.target" ];
      before = [ "sshd.service" ];
      serviceConfig.Type = "oneshot";
      script = ''
        install -d -m 0700 /nix/fleet-state/devbox
        install -m 0600 ${key}/id.pub /nix/fleet-state/devbox/authorized_keys
        install -m 0600 ${key}/id /root/devbox-test-key
        install -D -m 0644 ${key}/id.pub /etc/ssh/authorized_keys.d/agent
      '';
    };
  };
  testScript = ''
    import unittest

    machine.start(allow_reboot=True)
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("sshd.service")
    machine.wait_for_unit("fleet-coding-check.service")
    machine.succeed("grep -qx role=devbox /etc/fleet/node.conf")
    machine.succeed("getent passwd dev | grep -F /nix/devbox")
    machine.succeed("getent passwd agent | grep -F /nix/fleet-code")
    machine.succeed("fleet-code --version && omp --version && chromium --version && claude --version && codex --version", timeout=60)
    # Inspect the file passed by the NixOS service, not the package defaults.
    effective_ssh = machine.succeed("sshd -T -f /etc/ssh/sshd_config -C user=agent,host=localhost,addr=127.0.0.1")
    # OpenSSH 10.5 prints canonical keyword casing; earlier versions use lowercase.
    ssh_policy = {key.lower(): value for key, value in (line.split(" ", 1) for line in effective_ssh.splitlines())}
    policy_checks = unittest.TestCase()
    policy_checks.assertEqual(ssh_policy.get("forcecommand"), "${coding.ssh}/bin/fleet-code-ssh")
    policy_checks.assertEqual(ssh_policy.get("allowstreamlocalforwarding"), "local")
    policy_checks.assertEqual(ssh_policy.get("allowtcpforwarding"), "local")
    policy_checks.assertEqual(ssh_policy.get("permitopen"), "[/run/fleet-code-desktop/web.sock]:*")
    machine.succeed("su - agent -c 'test $(stat -c %a /nix/fleet-code) = 700; echo persistent > ~/coding-test'")
    machine.fail("su - agent -c 'sudo -n true'")
    machine.fail("su - dev -c 'cat /nix/fleet-code/coding-test'")
    machine.succeed("ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key agent@localhost 'omp --version' | grep -F '18.13.1'")
    machine.succeed("ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key agent@localhost 'omp config get modelRoles --json' | grep -F 'openai-codex/*'")
    machine.fail("ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key agent@localhost 'touch /nix/fleet-code/shell-bypass'")
    machine.succeed("test ! -e /nix/fleet-code/shell-bypass")
    machine.wait_for_unit("fleet-code-desktop.service")
    machine.wait_until_succeeds("test -S /run/fleet-code-desktop/web.sock && test -S /run/fleet-code-desktop/vnc.sock")
    machine.succeed("test $(stat -c %a /run/fleet-code-desktop) = 700; test $(stat -c %a /run/fleet-code-desktop/web.sock) = 600; test $(stat -c %a /run/fleet-code-desktop/vnc.sock) = 600")
    machine.wait_until_succeeds("su - agent -c '${pkgs.tmux}/bin/tmux has-session -t coding'")
    machine.wait_until_succeeds("su - agent -c 'DISPLAY=:99 XAUTHORITY=/run/fleet-code-desktop/Xauthority ${pkgs.xwininfo}/bin/xwininfo -root -tree' | grep -i chromium", timeout=120)
    machine.succeed("${pkgs.curl}/bin/curl -fsS --unix-socket /run/fleet-code-desktop/web.sock http://localhost/vnc.html | grep -F noVNC")
    machine.fail("su - dev -c '${pkgs.curl}/bin/curl --connect-timeout 2 --unix-socket /run/fleet-code-desktop/web.sock http://localhost/vnc.html'")
    machine.fail("su - dev -c 'cat /run/fleet-code-desktop/Xauthority'")
    machine.succeed("ssh -fNT -o BatchMode=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key -L 127.0.0.1:16080:/run/fleet-code-desktop/web.sock agent@localhost")
    machine.succeed("${pkgs.curl}/bin/curl -fsS http://127.0.0.1:16080/vnc.html | grep -F noVNC")
    machine.succeed("if ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key -W 127.0.0.1:22 agent@localhost > /run/fleet-agent-tcp-rejection 2>&1; then exit 1; fi; grep -F 'administratively prohibited' /run/fleet-agent-tcp-rejection")
    machine.succeed("test -z \"$(${pkgs.iproute2}/bin/ss -H -lnt '( sport = :5999 or sport = :6099 or sport = :6080 or sport = :9222 )')\"")
    machine.succeed("test ! -L /run/fleet/devbox-authorized-keys; test $(stat -c %u /run/fleet/devbox-authorized-keys) = 0; test $(stat -c %a /run/fleet/devbox-authorized-keys) = 755")
    # SSH must not consume the test driver's command/completion stream on stdin.
    machine.succeed("ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key dev@localhost 'set -eu; test $HOME = /nix/devbox; echo persistent > ~/workspace-test; for devbox_tool in git bun node python3 gcc just tmux; do command -v $devbox_tool; done'", timeout=60)
    machine.fail("su - dev -c 'cat /nix/fleet-state/devbox/authorized_keys'")
    machine.fail("su - dev -c 'sudo -n true'")
    machine.fail("systemctl cat fleet-capacity.service")
    machine.succeed("test ! -e /run/fleet/slot-count; test ! -e /run/secrets/github-app-key")
    machine.succeed("sync")
    machine.reboot()
    machine.wait_for_unit("sshd.service")
    machine.succeed("ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /root/devbox-test-key dev@localhost 'grep -qx persistent ~/workspace-test'", timeout=60)
    machine.succeed("su - agent -c 'grep -qx persistent ~/coding-test'")
    machine.wait_for_unit("fleet-code-desktop.service")
    machine.wait_until_succeeds("test -S /run/fleet-code-desktop/web.sock")
  '';
}
