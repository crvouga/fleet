{ pkgs, lib, sopsModule, diskoModule }: let
  settings = import ../fleet.nix;
  # The fake controller listens here. runner_control.py accepts plain http for
  # the loopback address only, so the broker runs on the node itself.
  brokerPort = 8099;
  brokerState = "/run/fake-controller";
  # A Runner.Listener that never talks to GitHub. `configure` keeps the
  # arguments it was given (the registration token and the URL) where the test
  # can read them; `run` stays up like a listener waiting for a job.
  mock = pkgs.callPackage ({ nodeRuntimes ? [] }: pkgs.runCommand "mock-github-runner" {} ''
    mkdir -p $out/bin
    cat > $out/bin/Runner.Listener <<'MOCK'
#!${pkgs.bash}/bin/bash
set -eu
case "$1" in
  configure)
    test -s "$RUNNER_ROOT/.new-token"
    test -n "$ACTIONS_RUNNER_INPUT_NAME"
    printf '%s\n' "$@" > "/run/fleet/$FLEET_SLOT/configure-args"
    for name in .credentials .credentials_rsaparams .runner; do
      printf '{}' > "$RUNNER_ROOT/$name"
    done
    ;;
  run)
    exec ${pkgs.coreutils}/bin/sleep infinity
    ;;
  *) exit 2 ;;
esac
MOCK
    chmod +x $out/bin/Runner.Listener
  '') {};
  testSettings = settings // {
    repo = settings.repo // { url = "https://github.com/example/machines.git"; };
    # A controller address makes the agent run and the runner slots exist with
    # no per-machine GitHub settings: the node asks the controller for tokens.
    fleetApi = { url = "http://127.0.0.1:${toString brokerPort}"; };
    secretsFile = null;
    # 2 cores and about 3 GiB start both slots (as in vm.nix).
    capacity = settings.capacity // {
      slotMax = 2;
      reserveGiB = 0;
      perRunnerGiB = 1;
      perRunnerCores = 1;
    };
    # No GitHub App on the node: no App ID, no installation, no repository.
    github = settings.github // {
      scope = "repository";
      organization = "";
      repositories = [ ];
      runnerGroup = null;
      appId = "";
      installationId = "";
    };
    cache = settings.cache // { remote = settings.cache.remote // { enable = false; }; };
  };
in pkgs.testers.runNixOSTest {
  name = "fleet-runner-registration";
  node.specialArgs = { settings = testSettings; };
  nodes.machine = { ... }: {
    imports = [ sopsModule diskoModule ../hosts/ci.nix ];
    # The VM root is the test image. Disko still evaluates, but must not mount the host disk layout.
    disko.enableConfig = lib.mkForce false;
    boot.loader.systemd-boot.enable = lib.mkForce false;
    users.users.root.hashedPassword = lib.mkForce null;
    # The real token provider and the real runner-control stay: only the
    # listener is replaced, and the controller is the fake below.
    services.github-runners = lib.genAttrs [ "slot-1" "slot-2" ] (_: { package = mock; });
    # The fake controller (tests/runner_registration_broker.py). Type=notify: it
    # reports ready once it listens, and the agent and the slots are ordered after it.
    systemd.services.fake-controller = {
      description = "Fake fleet controller (runner registration test)";
      wantedBy = [ "multi-user.target" ];
      before = [ "fleet-agent.service" "fleet-capacity.service" ];
      serviceConfig = {
        Type = "notify";
        ExecStart = "${pkgs.python3}/bin/python3 ${./runner_registration_broker.py} --state ${brokerState} --port ${toString brokerPort}";
        RuntimeDirectory = "fake-controller";
        RuntimeDirectoryMode = "0755";
        Restart = "on-failure";
      };
    };
    virtualisation = { memorySize = 3072; cores = 2; writableStore = true; };
  };
  testScript = builtins.readFile ./runner_registration_vm.py;
}
