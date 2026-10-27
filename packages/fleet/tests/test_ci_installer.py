"""Independent installer checks overlap; every failure still prevents publication."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("ci_installer", Path(__file__).with_name("installer.py"))
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerSchedulingTests(unittest.TestCase):
    def test_checks_overlap_instead_of_waiting_for_packaging(self):
        with tempfile.TemporaryDirectory() as directory:
            source = "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); end=time.monotonic()+5\nwhile len(list(pathlib.Path('.').glob('ready-*')))<4:\n if time.monotonic()>end: raise RuntimeError('checks did not overlap')\n time.sleep(0.02)\n"
            checks = {name: [sys.executable, "-c", source, "ready-" + name] for name in ["units", "browser", "build", "nix"]}
            self.assertEqual(installer.run_checks(checks, directory), 0)

    def test_failed_or_missing_commands_fail_after_the_other_checks_finish(self):
        for bad in [[sys.executable, "-c", "raise SystemExit(7)"], ["/nonexistent-installer-command"]]:
            with self.subTest(command=bad), tempfile.TemporaryDirectory() as directory:
                checks = {"failed": bad, "successful": [sys.executable, "-c", "from pathlib import Path; Path('other-check-completed').touch()"]}
                self.assertEqual(installer.run_checks(checks, directory), 1)
                self.assertTrue((Path(directory) / "other-check-completed").exists())

    def test_a_hung_check_and_its_children_are_killed_with_their_output_shown(self):
        # A hung browser contract once ran silently until the 30-minute job limit.
        hang = ("import subprocess,sys,time; print('reached the slow scenario', flush=True); "
                "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)']); time.sleep(600)")
        with tempfile.TemporaryDirectory() as directory, patch.object(installer, "CHECK_TIMEOUT", 2), \
                patch("sys.stdout", new_callable=__import__("io").StringIO) as out:
            checks = {"hung": [sys.executable, "-c", hang],
                      "successful": [sys.executable, "-c", "from pathlib import Path; Path('done').touch()"]}
            started = __import__("time").monotonic()
            self.assertEqual(installer.run_checks(checks, directory), 1)
            self.assertLess(__import__("time").monotonic() - started, 30)
            self.assertTrue((Path(directory) / "done").exists())
        self.assertIn("reached the slow scenario", out.getvalue())
        self.assertIn("TIMED OUT after 2s", out.getvalue())
        self.assertIn("--- hung (", out.getvalue())

    def test_every_native_platform_runs_unit_browser_packaging_and_self_test(self):
        commands = installer.commands("fixture-sha")
        self.assertEqual(len(commands), 4 if sys.platform == "win32" else 3)
        self.assertIn("test_wizard*.py", commands["Wizard unit tests"])
        self.assertEqual(commands["Wizard browser contracts"], ["node", "wizard/ui-e2e.cjs"])
        self.assertEqual(commands["Packaged installer and self-test"], [sys.executable, "wizard/build.py", "--version", "fixture-sha"])

    def test_linux_adds_native_build_without_omitting_portable_contracts(self):
        commands = installer.commands("fixture-sha", native_nix=True)
        self.assertEqual(len(commands), 5 if sys.platform == "win32" else 4)
        self.assertEqual(commands["Native Nix installer"], ["nix", "build", "--no-write-lock-file", "-o", "result-native", ".#fleet-installer"])
        self.assertIn("Packaged installer and self-test", commands)

    def test_standalone_cli_loads_the_standard_library_without_shadowing_token(self):
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("installer.py")), "--help"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("--version", result.stdout)

    def test_each_check_has_its_own_temporary_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            source = "import pathlib,sys,tempfile; pathlib.Path(sys.argv[1]).write_text(tempfile.gettempdir())"
            checks = {name: [sys.executable, "-c", source, name] for name in ["units", "browser", "build"]}
            self.assertEqual(installer.run_checks(checks, directory), 0)
            paths = [(Path(directory) / name).read_text() for name in checks]
            self.assertEqual(len(set(paths)), 3)
            for path in paths:
                self.assertFalse(Path(path).exists(), "temporary check data was not removed")
