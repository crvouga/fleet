"""Run the real service probe with a PATH isolated from interactive user tools."""
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/runner-prerequisites.sh'


class RunnerPrerequisitesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.workspace = self.root / 'work'
        self.workspace.mkdir()
        self.status = self.root / 'prerequisites'
        for name in ('bash', 'git', 'mkdir', 'mv', 'rm', 'mktemp', 'ln', 'cat', 'cp'):
            found = shutil.which(name)
            if not found:
                self.skipTest(f'{name} is required to exercise the service probe')
            (self.bin / name).symlink_to(found)
        for name in ('gh', 'nix'):
            self.stub(name, f'echo "{name} version fixture"')
        self.env = {'PATH': str(self.bin), 'HOME': str(self.root), 'LC_ALL': 'C',
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                    'FLEET_PREREQUISITE_STATUS': str(self.status)}

    def stub(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o755)

    def run_probe(self):
        return subprocess.run([str(self.bin / 'bash'), str(SCRIPT)], cwd=self.workspace,
                              env=self.env, capture_output=True, text=True, timeout=30)

    def test_real_git_checkout_preserves_symlinks_and_long_paths_and_cleans_up(self):
        result = self.run_probe()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.status.read_text(), 'ok\n')
        self.assertIn('FLEET_RUNNER_PREREQUISITES_OK', result.stdout)
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_missing_tool_or_a_tool_that_cannot_execute_blocks_startup(self):
        self.status.write_text('ok\n')  # a previous start must not hide this failure
        (self.bin / 'gh').unlink()
        result = self.run_probe()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.status.read_text(), 'failed:tool:gh\n')
        self.stub('gh', 'exit 91')
        self.assertEqual(self.run_probe().returncode, 91)
        self.assertEqual(self.status.read_text(), 'failed:tool:gh\n')

    def test_checkout_that_materializes_symlinks_as_files_is_detected(self):
        real_git = shlex.quote(str((self.bin / 'git').resolve()))
        (self.bin / 'git').unlink()
        self.stub('git', f'{real_git} "$@" || exit $?\n'
                  'if [ "$1" = clone ]; then rm checkout/link; printf target > checkout/link; fi')
        result = self.run_probe()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.status.read_text(), 'failed:checkout\n')
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_git_configuration_disabling_symlinks_is_detected(self):
        self.env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.symlinks', GIT_CONFIG_VALUE_0='false')
        result = self.run_probe()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.status.read_text(), 'failed:checkout\n')
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_filesystem_failure_is_reported_and_partial_probe_is_removed(self):
        (self.bin / 'ln').unlink()
        self.stub('ln', 'exit 92')
        result = self.run_probe()
        self.assertEqual(result.returncode, 92)
        self.assertEqual(self.status.read_text(), 'failed:filesystem\n')
        self.assertEqual(list(self.workspace.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
