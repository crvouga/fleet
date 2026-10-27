"""Point Gherkin tests at the actual built platform download, not source Python."""
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


def unpack():
    dist = Path("wizard/dist").resolve()
    system = platform.system()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    root = Path(tempfile.mkdtemp(prefix="fleet-bdd-packaged-"))
    if system == "Windows":
        binary = root / "fleet-installer.exe"
        shutil.copyfile(dist / "fleet-installer-windows-x64.exe", binary)
    elif system == "Darwin":
        # ditto preserves framework symlinks and executable bits in the .app.
        subprocess.run(["ditto", "-x", "-k", str(dist / f"fleet-installer-macos-{arch}.zip"), str(root)], check=True)
        binary = root / "fleet-installer.app/Contents/MacOS/fleet-installer"
    else:
        with tarfile.open(dist / f"fleet-installer-linux-{arch}.tar.gz") as archive:
            archive.extractall(root, filter="data")
        binary = root / "fleet-installer"
    if not binary.is_file():
        raise RuntimeError("The packaged wizard executable was not found")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
        output.write(f"FLEET_BDD_WIZARD={binary}\n")
    print(f"Gherkin will launch the packaged {system} {arch} installer")


if __name__ == "__main__":
    unpack()
