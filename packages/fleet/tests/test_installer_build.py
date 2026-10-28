"""Check Windows attribution reaches the packaged executable's build input."""
import importlib.util
import re
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


WIZARD = Path(__file__).resolve().parents[1] / "wizard"
SPEC = importlib.util.spec_from_file_location("installer_build", WIZARD / "build.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class InstallerBuildTests(unittest.TestCase):
    def test_windows_build_embeds_owner_and_revision_before_selftests(self):
        resources = []
        version = "revision-'quoted'"

        def package(command, **kwargs):
            resource = Path(command[command.index("--version-file") + 1]).read_text()
            # Execute the resource grammar with stand-in constructors. This also
            # catches malformed Python when a version contains quote characters.
            strings = {}

            def string_struct(key, value):
                strings[key] = value

            constructors = {name: lambda *args, **kw: None for name in
                            ("VSVersionInfo", "FixedFileInfo", "StringFileInfo",
                             "StringTable", "VarFileInfo", "VarStruct")}
            exec(compile(resource, "version-info", "exec"),
                 {"__builtins__": {}, **constructors, "StringStruct": string_struct})
            resources.append(strings)
            dist = Path(kwargs["cwd"]) / "dist"
            dist.mkdir()
            (dist / "fleet-installer.exe").write_bytes(b"packaged fixture")

        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(BUILD, "target_name", return_value=("windows", "x64")), \
                patch.object(BUILD, "run", side_effect=package), \
                patch.object(BUILD.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, "SELFTEST OK\nHTTPS SELFTEST OK\n", "")) as selftest:
            self.assertEqual(BUILD.main(["--version", version, "--out", temporary]), 0)
            self.assertEqual((Path(temporary) / "fleet-installer-windows-x64.exe").read_bytes(),
                             b"packaged fixture")
            self.assertEqual(selftest.call_count, 2)
        self.assertEqual(resources[0]["CompanyName"], "Chris Vouga")
        self.assertEqual(resources[0]["ProductName"], "Fleet")
        self.assertEqual(resources[0]["ProductVersion"], version)
        self.assertEqual(resources[0]["Comments"], "https://github.com/crvouga/fleet")

class InstallerPackagingParityTests(unittest.TestCase):
    """The native launcher (Nix) and the PyInstaller build ship the same wizard files.

    A module added to one and not the other only fails when the packaged
    installer starts (ModuleNotFoundError), long after the code was merged.
    """

    def test_nix_launcher_ships_exactly_the_files_the_executable_build_does(self):
        nix = (WIZARD.parent / "modules" / "installer-package.nix").read_text()
        listed = re.search(r"files = \[(.*?)\];", nix, re.S).group(1)
        self.assertEqual(sorted(re.findall(r'"([^"]+)"', listed)), sorted(BUILD.FILES))

    def test_every_local_module_the_wizard_imports_is_shipped(self):
        shipped = {name[:-3] for name in BUILD.FILES if name.endswith(".py")} | {"decide", "_version"}
        local = {path.stem for path in WIZARD.glob("*.py")}
        for name in BUILD.FILES:
            if not name.endswith(".py"):
                continue
            source = (WIZARD / name).read_text()
            for module in re.findall(r"^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", source, re.M):
                if module in local:
                    self.assertIn(module, shipped, f"{name} imports {module}, which is not packaged")

