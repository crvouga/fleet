{ pkgs, lib }: let
  tools = import ../modules/coding-package.nix { inherit pkgs lib; };
in pkgs.runCommand "fleet-coding-launcher" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  python3 ${./coding_smoke.py} ${tools.session}/bin/fleet-code ${../docs/coding-agent.md}
  mkdir -p "$out"
''
