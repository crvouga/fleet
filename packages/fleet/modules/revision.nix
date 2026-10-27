{ config, lib, pkgs, revision ? null, ... }: let
  # self.rev is null on a dirty tree. The flake passes "unknown" then. A
  # dirtyRev is not a cache key, so it is not published. base.nix supplies
  # the same fallback when a test does not pass specialArgs.revision.
  rev = if revision == null then "unknown" else revision;
  server = pkgs.writeText "fleet-revision.py" ''
    import os
    import socket
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    def notify_ready():
        # Type=notify stays activating until this datagram. The VM reaches
        # multi-user.target only after that, then curls the metrics port.
        raw = os.environ.get("NOTIFY_SOCKET")
        if not raw:
            raise SystemExit("NOTIFY_SOCKET is unset")
        if raw[0] == "@":
            addr = b"\0" + raw[1:].encode()
        else:
            addr = os.fsencode(raw)
        notify = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        notify.connect(addr)
        notify.sendall(b"READY=1\n")
        notify.close()

    def esc(value):
        return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "")

    def node():
        data = {"hostname": "unknown", "role": "unknown", "capabilities": ""}
        try:
            handle = open("/run/fleet/node", encoding="utf-8")
        except OSError:
            return data
        with handle:
            for line in handle:
                if "=" not in line:
                    continue
                key, value = line.strip().split("=", 1)
                if key in data:
                    data[key] = value
        return data

    def _exists(path):
        try:
            open(path, encoding="utf-8").close()
        except OSError:
            return False
        return True

    def _disk_lines():
        lines = []
        try:
            handle = open("/run/fleet/disk-alert", encoding="utf-8")
        except OSError:
            return lines
        with handle:
            for line in handle:
                parts = line.split()
                if len(parts) != 2:
                    continue
                mount, used = parts
                if mount not in ("/nix", "/boot") or not used.isdigit():
                    continue
                lines.append('fleet_disk_used_percent{mount="%s"} %s' % (mount, used))
        return lines

    def body():
        try:
            rev = open("/etc/fleet/revision", encoding="utf-8").read().strip()
        except OSError:
            rev = "unknown"
        info = node()
        rev_e = esc(rev)
        lines = [
            'nixos_configuration_revision_info{revision="%s"} 1' % rev_e,
            'nixos_node_info{hostname="%s",role="%s",capabilities="%s",revision="%s"} 1' % (
                esc(info["hostname"]), esc(info["role"]), esc(info["capabilities"]), rev_e,
            ),
            "fleet_sync_rollback %d" % (1 if _exists("/run/fleet/health-failure") else 0),
        ]
        lines.extend(_disk_lines())
        return ("\n".join(lines) + "\n").encode()


    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/metrics":
                self.send_error(404)
                return
            payload = body()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _fmt, *_args):
            return


    server = ThreadingHTTPServer(("127.0.0.1", 9101), Handler)
    notify_ready()
    server.serve_forever()
  '';
in {
  system.configurationRevision = lib.mkDefault rev;
  environment.etc."fleet/revision".text = config.system.configurationRevision + "\n";
  systemd.services.fleet-revision = {
    description = "Publish the running configuration revision on localhost";
    wantedBy = [ "multi-user.target" ];
    after = [ "node-identity.service" ];
    wants = [ "node-identity.service" ];
    serviceConfig = {
      ExecStart = "${pkgs.python3}/bin/python3 ${server}";
      # simple is active at exec, before the listen. Notify after bind.
      Type = "notify";
      DynamicUser = true;
      Restart = "on-failure";
    };
  };
}
