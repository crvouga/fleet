{ lib, pkgs }: let
  defaults = pkgs.writeText "fleet-omp.yml" (builtins.toJSON {
    # The upstream headless backend disables Chromium's sandbox and exposes
    # loopback CDP. Authentication uses the existing private desktop instead.
    browser = { enabled = false; relay = false; };
    # --provider alone does not select OMP's initial model. A native role
    # supplies the default while preserving --model and resumed model choices.
    modelRoles.default = "openai-codex/*";
    retry.modelFallback = false;
    # The reviewed flake, rather than an interactive updater, owns versions.
    startup.checkUpdate = false;
    marketplace.autoUpdate = "off";
  });
  browser = pkgs.writeShellScriptBin "fleet-browser" ''
    export DISPLAY=:99
    export XAUTHORITY=/run/fleet-code-desktop/Xauthority
    export XDG_RUNTIME_DIR=/run/fleet-code-desktop
    umask 077
    exec ${pkgs.chromium}/bin/chromium --no-first-run \
      --user-data-dir="$HOME/.config/fleet-chromium" "$@"
  '';
  session = pkgs.writeShellScriptBin "fleet-code" ''
    export DISPLAY=:99
    export XAUTHORITY=/run/fleet-code-desktop/Xauthority
    export XDG_RUNTIME_DIR=/run/fleet-code-desktop
    export BROWSER=${browser}/bin/fleet-browser
    export PI_CODING_AGENT_DIR="$HOME/.omp/agent"
    # Subcommands such as `omp config` initialize settings separately and do
    # not consume the session's --config flag. This native environment layer
    # applies the same defaults to interactive, RPC and configuration commands.
    export PI_CONFIG_FILES=${defaults}''${PI_CONFIG_FILES:+:$PI_CONFIG_FILES}
    # Use the installed browser rather than an on-demand Chromium download.
    export PUPPETEER_EXECUTABLE_PATH=${pkgs.chromium}/bin/chromium
    export PATH=${lib.makeBinPath [ pkgs.claude-code pkgs.codex pkgs.git pkgs.ripgrep pkgs.xdotool pkgs.scrot pkgs.xdg-utils ]}:$PATH
    umask 077
    exec ${pkgs.omp}/bin/omp \
      --append-system-prompt /etc/fleet/coding-agent.md "$@"
  '';
  ssh = pkgs.writeShellScriptBin "fleet-code-ssh" ''
    export FLEET_CODE_ENTRY=${session}/bin/fleet-code
    export PATH=${lib.makeBinPath [ pkgs.tmux ]}:$PATH
    exec ${pkgs.python3}/bin/python3 ${../scripts/coding_ssh.py}
  '';
in { inherit browser session ssh defaults; }
