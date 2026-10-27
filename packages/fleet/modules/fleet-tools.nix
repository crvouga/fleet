# Not a module. A function that returns the node scripts as ONE store path
# (agent.py, fleetconf.py and cattle.py import each other, so they must sit
# in the same directory) and the commands built on them. agent.nix, sync.nix,
# identity.nix, base.nix and ci-runner.nix call it, and nothing else.
{ lib, pkgs, apiUrl ? "" }: let
  python = "${pkgs.python3}/bin/python3";
  scripts = pkgs.runCommand "fleet-node-scripts" { } ''
    mkdir -p "$out"
    cp ${../scripts/cattle.py} "$out/cattle.py"
    cp ${../scripts/fleet_roles.py} "$out/fleet_roles.py"
    cp ${../scripts/fleetconf.py} "$out/fleetconf.py"
    cp ${../scripts/agent.py} "$out/agent.py"
    cp ${../scripts/node_readiness.py} "$out/node_readiness.py"
    cp ${../scripts/telemetry.py} "$out/telemetry.py"
    cp ${../scripts/recovery.py} "$out/recovery.py"
  '';
  # Runner units embed these paths. A store path shared with every other
  # script changed the runner units on almost every update. Keep the job hook
  # and the console in their own paths so unrelated changes leave them alone.
  jobScripts = pkgs.runCommand "fleet-job-scripts" { } ''
    mkdir -p "$out"
    cp ${../scripts/runner_job.py} "$out/runner_job.py"
  '';
  consoleScripts = pkgs.runCommand "fleet-console-scripts" { } ''
    mkdir -p "$out"
    cp ${../scripts/node_console.py} "$out/node_console.py"
    cp ${../scripts/live_console.py} "$out/live_console.py"
    cp ${../scripts/decide.py} "$out/decide.py"
    cp ${../scripts/recovery.py} "$out/recovery.py"
  '';
in {
  inherit scripts;
  # fleetconf get KEY DEFAULT: the setting this node last applied from the
  # fleet API, else DEFAULT. It never fails, so a unit can always call it.
  fleetconf = pkgs.writeShellScriptBin "fleetconf" ''
    exec ${python} ${scripts}/fleetconf.py "$@"
  '';
  # fleet-agent run|once|status|retire. A shell started by hand gets the same
  # API address as the unit.
  agent = pkgs.writeShellScriptBin "fleet-agent" ''
    export PATH=${lib.makeBinPath [ pkgs.iproute2 pkgs.systemd pkgs.coreutils ]}:$PATH
    export FLEET_API_URL="''${FLEET_API_URL-${apiUrl}}"
    exec ${python} ${scripts}/agent.py "$@"
  '';
  runnerJob = pkgs.writeShellScriptBin "fleet-runner-job" ''
    exec ${python} ${jobScripts}/runner_job.py "$@"
  '';
  # fleet-node-status: the console screen's words, over SSH. The console unit
  # runs `fleet-node-console watch`. Both only read.
  nodeConsole = pkgs.writeShellScriptBin "fleet-node-console" ''
    export PATH=${lib.makeBinPath [ pkgs.iproute2 pkgs.systemd pkgs.coreutils pkgs.qrencode pkgs.openssh ]}:$PATH
    exec ${python} ${consoleScripts}/node_console.py "$@"
  '';
  # fleet-recovery boot|shutdown|jobs|status (scripts/recovery.py, modules/recovery.nix).
  recovery = pkgs.writeShellScriptBin "fleet-recovery" ''
    exec ${python} ${scripts}/recovery.py "$@"
  '';
  nodeStatus = pkgs.writeShellScriptBin "fleet-node-status" ''
    export PATH=${lib.makeBinPath [ pkgs.iproute2 pkgs.systemd pkgs.coreutils pkgs.qrencode pkgs.openssh ]}:$PATH
    exec ${python} ${consoleScripts}/node_console.py status "$@"
  '';
}
