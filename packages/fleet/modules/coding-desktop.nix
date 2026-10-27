{ lib, pkgs, ... }: let
  tools = import ./coding-package.nix { inherit lib pkgs; };
in {
  # The physical console stays on fleet status. This private virtual display
  # works on headless CI hardware too, without enabling a display manager.
  fonts.packages = [ pkgs.dejavu_fonts pkgs.noto-fonts ];
  systemd.tmpfiles.rules = [ "d /tmp/.X11-unix 1777 root root -" ];
  systemd.services.fleet-code-desktop = {
    description = "Private Oh My Pi terminal and Chromium authentication desktop";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-tmpfiles-setup.service" ];
    environment = {
      DISPLAY = ":99";
      XAUTHORITY = "/run/fleet-code-desktop/Xauthority";
      XDG_RUNTIME_DIR = "/run/fleet-code-desktop";
      BROWSER = "${tools.browser}/bin/fleet-browser";
    };
    serviceConfig = {
      Type = "simple";
      User = "agent";
      Group = "agent";
      WorkingDirectory = "/nix/fleet-code";
      RuntimeDirectory = "fleet-code-desktop";
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
      Restart = "on-failure";
      RestartSec = 5;
      KillMode = "control-group";
    };
    path = [ pkgs.coreutils pkgs.xauth pkgs.xdpyinfo pkgs.openssl ];
    script = ''
      set -euo pipefail
      cookie=$(openssl rand -hex 16)
      printf 'add :99 . %s\n' "$cookie" | xauth -f "$XAUTHORITY" source -
      unset cookie
      ${pkgs.tigervnc}/bin/Xvnc :99 -geometry 1440x900 -depth 24 \
        -auth "$XAUTHORITY" -nolisten tcp -rfbport -1 \
        -rfbunixpath /run/fleet-code-desktop/vnc.sock -rfbunixmode 0600 \
        -SecurityTypes None -AlwaysShared &
      display_pid=$!
      trap 'kill "$display_pid" 2>/dev/null || true' EXIT
      for _attempt in $(seq 1 100); do
        if xdpyinfo >/dev/null 2>&1; then break; fi
        kill -0 "$display_pid"
        sleep 0.1
      done
      xdpyinfo >/dev/null
      ${pkgs.openbox}/bin/openbox --sm-disable &
      window_pid=$!
      ${pkgs.python3Packages.websockify}/bin/websockify \
        --web=${pkgs.novnc}/share/webapps/novnc \
        --unix-listen=/run/fleet-code-desktop/web.sock --unix-listen-mode=0600 \
        --unix-target=/run/fleet-code-desktop/vnc.sock &
      web_pid=$!
      ${pkgs.xterm}/bin/xterm -fa 'DejaVu Sans Mono' -fs 12 -T 'Oh My Pi coding agent' \
        -e ${pkgs.tmux}/bin/tmux new-session -A -s coding ${tools.session}/bin/fleet-code --continue &
      ${tools.browser}/bin/fleet-browser about:blank &
      # A failed display/window manager/proxy restarts the desktop. OMP stays in
      # tmux across browser disconnects; its session files survive node reboots.
      wait -n "$display_pid" "$window_pid" "$web_pid"
      exit 1
    '';
  };
}
