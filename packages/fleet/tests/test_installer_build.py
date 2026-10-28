"""Check Windows attribution reaches the packaged executable's build input."""
import importlib.util
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
