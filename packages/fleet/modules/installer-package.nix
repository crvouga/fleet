# Native launcher: no foreign ELF loader, PyInstaller or nix-ld dependency.
{ pkgs, lib, revision ? "dev" }: let
  files = [ "main.py" "bootstrap.py" "fleet_tls.py" "helper.py" "imaging.py" "leases.py" "elevate.py" "preparation.py" "fleet_wifi.py" "wifi_capture.py" "server.py" "diagnostics.py" "index.html" "admin.css" "theme.js" ];
  source = pkgs.linkFarm "fleet-installer-source" (map (name: {
    inherit name;
    path = ../wizard + "/${name}";
  }) files);
in pkgs.runCommand "fleet-installer" { } ''
  mkdir -p "$out/bin" "$out/libexec/fleet-installer"
  cp ${source}/* "$out/libexec/fleet-installer/"
  cp ${../scripts/decide.py} "$out/libexec/fleet-installer/decide.py"
  printf 'VERSION = "%s"\n' ${lib.escapeShellArg revision} > "$out/libexec/fleet-installer/_version.py"
  cat > "$out/bin/fleet-installer" <<EOF
#!${pkgs.runtimeShell}
export PATH=${lib.makeBinPath ([ pkgs.python3 pkgs.curl pkgs.coreutils pkgs.bash ]
  ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.util-linux pkgs.kexec-tools pkgs.networkmanager ])}:\$PATH
exec ${pkgs.python3}/bin/python3 "$out/libexec/fleet-installer/main.py" "\$@"
EOF
  chmod +x "$out/bin/fleet-installer"
  cat > "$out/bin/fleet-node" <<EOF
#!${pkgs.runtimeShell}
export PATH=${lib.makeBinPath ([ pkgs.python3 pkgs.curl pkgs.coreutils pkgs.bash ]
  ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.util-linux pkgs.kexec-tools pkgs.networkmanager ])}:\$PATH
exec ${pkgs.bash}/bin/bash ${../scripts/fleet-node.sh} "\$@"
EOF
  chmod +x "$out/bin/fleet-node"
  # Elevation re-enters the wrapper so sudo/polkit cannot discard its tool PATH.
  ln -s "$out/bin/fleet-installer" "$out/libexec/fleet-installer/launcher"
''
