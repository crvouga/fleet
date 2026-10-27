#!/usr/bin/env python3
"""Serves /srv/release the way GitHub does (HTTP, Range, Content-Length), and
can misbehave on command: GET /__mode/<ok|corrupt|truncate|missing|slow>."""
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("FLEET_E2E_ROOT", "/srv/release")
MODE = {"value": "ok"}
CORRUPT_AT = 100000


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("release %s %s\n" % (self.command, fmt % args))

    def do_GET(self):
        if self.path.startswith("/__mode/"):
            MODE["value"] = self.path.rsplit("/", 1)[1]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(MODE["value"].encode())
            return
        path = os.path.join(ROOT, os.path.basename(self.path.split("?")[0]))
        mode = MODE["value"]
        if not os.path.isfile(path) or (mode == "missing" and path.endswith(".iso")):
            self.send_error(404)
            return
        data = open(path, "rb").read()
        if mode == "corrupt" and path.endswith(".iso"):
            data = data[:CORRUPT_AT] + bytes([data[CORRUPT_AT] ^ 0xFF]) + data[CORRUPT_AT + 1:]
        start, end = 0, len(data) - 1
        rng = self.headers.get("Range")
        status = 200
        if rng and rng.startswith("bytes="):
            lo, _, hi = rng[6:].partition("-")
            start = int(lo or 0)
            end = min(int(hi) if hi else len(data) - 1, len(data) - 1)
            status = 206
        body = data[start:end + 1]
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
        self.end_headers()
        if mode == "truncate" and path.endswith(".iso") and status == 200:
            self.wfile.write(body[: len(body) // 2])
            self.wfile.flush()
            self.connection.close()
            return
        step = 64 * 1024
        for offset in range(0, len(body), step):
            if mode == "slow" and path.endswith(".iso") and status == 200:
                time.sleep(0.25)
            self.wfile.write(body[offset:offset + step])


ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("FLEET_E2E_PORT", "9000"))), Handler).serve_forever()
