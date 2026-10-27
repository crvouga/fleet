#!/usr/bin/env python3
"""Build the installer for the operating system this runs on, then prove it.

  python3 build.py [--version V] [--out DIR]

PyInstaller cannot cross-compile, so CI runs this once per OS and architecture.
The result is one download per platform:

  fleet-installer-windows-x64.exe
  fleet-installer-macos-<arch>.zip     (an .app)
  fleet-installer-linux-<arch>.tar.gz  (keeps the executable bit)

The build fails unless the finished program passes its own --selftest.
"""
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = ("main.py", "bootstrap.py", "fleet_tls.py", "helper.py", "imaging.py", "leases.py", "elevate.py", "preparation.py", "fleet_wifi.py", "wifi_capture.py", "server.py", "diagnostics.py", "index.html", "admin.css", "theme.js")


def target_name():
    system = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}[platform.system()]
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64" if machine in ("x86_64", "amd64") else machine
    return system, arch


def run(command, **kwargs):
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run(command, check=True, **kwargs)


def main(argv):
    version = argv[argv.index("--version") + 1] if "--version" in argv else "dev"
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else HERE / "dist"
    system, arch = target_name()
    out.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="fleet-build-"))
    try:
        for name in FILES:
            shutil.copy(HERE / name, stage / name)
        shutil.copy(HERE.parent / "scripts" / "decide.py", stage / "decide.py")
        (stage / "_version.py").write_text(f'VERSION = "{version}"\n')
        separator = ";" if system == "windows" else ":"
        command = [
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir" if system == "macos" else "--onefile", "--name", "fleet-installer",
            "--distpath", str(stage / "dist"), "--workpath", str(stage / "work"), "--specpath", str(stage),
            "--add-data", f"{stage / 'index.html'}{separator}.",
            "--add-data", f"{stage / 'admin.css'}{separator}.",
            "--add-data", f"{stage / 'theme.js'}{separator}.",
            "--hidden-import", "decide", "--hidden-import", "_version",
            "--hidden-import", "fleet_wifi", "--hidden-import", "wifi_capture",
            "--hidden-import", "certifi", "--collect-data", "certifi",
        ]
        if system == "macos":
            command += ["--windowed", "--osx-bundle-identifier", "org.fleet.installer"]
        run([*command, str(stage / "main.py")], cwd=stage)

        dist = stage / "dist"
        if system == "windows":
            built = dist / "fleet-installer.exe"
            binary = built
            final = out / f"fleet-installer-windows-{arch}.exe"
            shutil.copy(built, final)
        elif system == "macos":
            app = dist / "fleet-installer.app"
            binary = app / "Contents" / "MacOS" / "fleet-installer"
            final = out / f"fleet-installer-macos-{arch}.zip"
            final.unlink(missing_ok=True)
            run(["ditto", "-c", "-k", "--keepParent", str(app), str(final)])
        else:
            built = dist / "fleet-installer"
            binary = built
            final = out / f"fleet-installer-linux-{arch}.tar.gz"
            with tarfile.open(final, "w:gz") as archive:
                archive.add(built, arcname="fleet-installer")
        print(f"built {final}", flush=True)

        env = dict(os.environ, FLEET_STATE=str(stage / "selftest-state"))
        done = subprocess.run([str(binary), "--selftest"], env=env, capture_output=True, text=True, timeout=300, check=False)
        print(done.stdout, done.stderr, flush=True)
        if done.returncode != 0 or "SELFTEST OK" not in done.stdout:
            print("the built installer failed its own selftest", file=sys.stderr)
            final.unlink(missing_ok=True)
            return 1
        network = subprocess.run([str(binary), "--selftest-https"], env=env, capture_output=True, text=True, timeout=120, check=False)
        print(network.stdout, network.stderr, flush=True)
        if network.returncode != 0 or "HTTPS SELFTEST OK" not in network.stdout:
            print("the built installer failed verified HTTPS; it will not be published", file=sys.stderr)
            final.unlink(missing_ok=True)
            return 1
        return 0
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
