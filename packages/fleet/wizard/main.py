"""Fleet installer: a local wizard that turns a computer into a fleet node, or
makes an install USB stick for one. Run it, and a page opens in your browser.

  fleet-installer              open the wizard
  fleet-installer --no-browser print the address instead of opening it
  fleet-installer --selftest   prove this build works on this machine, then exit
  fleet-installer --helper DIR (internal) the privileged step
"""
import hashlib
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import helper  # noqa: E402
import imaging  # noqa: E402
import server  # noqa: E402
import fleet_tls  # noqa: E402


def readable_streams():
    """A Windows console or a redirected pipe may use a code page that cannot print every
    character; a message with an unusual one must never stop the program."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(errors="replace")
            except (OSError, ValueError):
                pass


def fake_iso(size=96 * 1024):
    blob = bytearray(size)
    blob[decide.ISO_MAGIC_OFFSET:decide.ISO_MAGIC_OFFSET + 5] = b"CD001"
    return bytes(blob)


def call(port, secret, method, path, body=None, host=None, token=True):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    headers = {"Host": host or f"127.0.0.1:{port}"}
    if token:
        headers["X-Fleet-Token"] = secret
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    connection.request(method, path, payload, headers)
    reply = connection.getresponse()
    data = reply.read()
    connection.close()
    return reply.status, data


def selftest():
    """Everything that can break in a packaged build, without touching a disk."""
    work = Path(tempfile.mkdtemp(prefix="fleet-selftest-"))
    os.environ.setdefault("FLEET_STATE", str(work / "state"))
    os.environ["FLEET_CACHE"] = str(work / "cache")
    os.environ["FLEET_ELEVATE"] = "none"
    decide.start_log(["selftest"])
    steps = []

    def check(name, condition, detail=""):
        steps.append(name)
        if not condition:
            print(f"SELFTEST FAIL {name} {detail}", file=sys.stderr)
            raise SystemExit(1)

    page = server.resource("index.html")
    check("page is bundled", page.is_file() and b"Fleet installer" in page.read_bytes(), str(page))

    iso = work / "fleet-installer.iso"
    iso.write_bytes(fake_iso())
    sha = hashlib.sha256(iso.read_bytes()).hexdigest()
    (work / "fleet-installer.iso.sha256").write_text(f"{sha}  fleet-installer.iso\n")
    os.environ["FLEET_INSTALLER_URL"] = iso.as_uri()
    os.environ["FLEET_INSTALLER_SHA256_URL"] = (work / "fleet-installer.iso.sha256").as_uri()
    # Packaged selftests must be deterministic and never depend on the host's
    # real disk count, attached storage, permissions, or diskutil latency.
    usb = {"path": f"/dev/{work.name}", "tran": "usb", "rm": True, "hotplug": True, "usb": True, "internal": False,
           "mounted": False, "whole": True, "size": 10**9, "model": "Selftest", "serial": "ST1"}
    (work / "disks.json").write_text(json.dumps([usb]))
    os.environ["FLEET_DISKS_FILE"] = str(work / "disks.json")

    fetched = imaging.download(iso.as_uri(), work / "copy.iso", imaging.fetch_checksum((work / "fleet-installer.iso.sha256").as_uri()))
    check("download verifies", imaging.sha256_of(fetched) == sha)
    target = work / "usb.img"
    target.write_bytes(b"\xff" * (iso.stat().st_size + 8192))
    imaging.write_image(iso, target, target.stat().st_size, sha)
    check("write and read back", target.read_bytes()[: iso.stat().st_size] == iso.read_bytes())

    wizard = server.Wizard()
    httpd = server.serve(wizard)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        status, body = call(port, wizard.secret, "GET", "/")
        check("page is served", status == 200 and b"Fleet installer" in body, str(status))
        status, body = call(port, wizard.secret, "GET", "/api/scan")
        scan = json.loads(body) if status == 200 else {}
        check("scan answers", status == 200 and scan.get("roles") and scan["release"]["ok"], f"{status} {body[:200]!r}")
        check("roles match the fleet", [r["id"] for r in scan["roles"]] == list(decide.ROLES))
        check("wrong token refused", call(port, wizard.secret, "GET", "/api/scan", token=False)[0] == 403)
        check("foreign host refused", call(port, wizard.secret, "GET", "/api/scan", host="evil.example")[0] == 403)
        check("run without a plan refused", call(port, wizard.secret, "POST", "/api/run", {"plan_id": "x", "ack": True})[0] == 409)

        # The whole make-a-USB flow, with a real helper process started the way
        # the packaged app starts it, writing to a plain file instead of a disk.
        stick = work / "stick.img"
        stick.write_bytes(b"\xee" * (iso.stat().st_size + 4096))
        os.environ.update(FLEET_DISKS_FILE=str(work / "disks.json"), FLEET_WRITE_TARGET=str(stick))
        status, body = call(port, wizard.secret, "POST", "/api/plan", {"mode": "usb", "disk_id": decide.disk_id(usb)})
        plan = json.loads(body)
        check("plan is ready", status == 200 and plan.get("ready"), f"{status} {body[:300]!r}")
        status, _ = call(port, wizard.secret, "POST", "/api/run", {"plan_id": plan["id"], "ack": True, "disk_id": plan["disk_id"]})
        check("run starts", status == 200, str(status))
        job = {}
        for _ in range(300):
            job = json.loads(call(port, wizard.secret, "GET", "/api/job")[1])
            if job["state"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.2)
        check("helper finished", job.get("state") == "done", json.dumps(job)[:500])
        check("stick holds the installer", stick.read_bytes()[: iso.stat().st_size] == iso.read_bytes())
    finally:
        httpd.shutdown()
    print(f"SELFTEST OK version={server.VERSION} os={decide.current_os()} arch={decide.machine_arch()} checks={len(steps)}")
    return 0


def main(argv):
    readable_streams()
    if argv[:1] == ["--helper"]:
        return helper.run(argv[1])
    if "--selftest-https" in argv:
        return fleet_tls.selftest()
    if "--selftest" in argv:
        return selftest()
    if "--version" in argv:
        print(server.VERSION)
        return 0
    print("Starting the local Fleet installer…", flush=True)
    decide.start_log(["wizard", *argv])
    print(f"Log: {decide.LOG['path']}", flush=True)
    wizard = server.Wizard()
    port = 0
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    httpd = server.serve(wizard, port)
    url = server.url_for(httpd, wizard)
    print("Fleet installer is running. Open this address if your browser does not open by itself:", flush=True)
    print(url, flush=True)
    print(f"Log: {decide.LOG['path']}", flush=True)
    if "--no-browser" not in argv:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
