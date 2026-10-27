"""The minimal runtime Bash must never treat a busy listener as idle."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'scripts/drain.sh'


@unittest.skipIf(os.name == 'nt', 'Runner drains execute on NixOS')
class BusyDrainTests(unittest.TestCase):
    def fixture(self, busy):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / 'run'
            (runtime / 'slot-1').mkdir(parents=True)
            if busy:
                (runtime / 'slot-1/busy').touch()
            binary = root / 'bin'
            binary.mkdir()
            for name, body in {
                'flock': '#!/bin/sh\nexit 0\n',
                'runner-control': '#!/bin/sh\nexit 75\n',
                'systemctl': '#!/bin/sh\ntouch "$DRAIN_FIXTURE/stopped"\n',
            }.items():
                path = binary / name
                path.write_text(body)
                path.chmod(0o700)
            script = root / 'drain.sh'
            script.write_text(SCRIPT.read_text().replace('/run/fleet', str(runtime)))
            result = subprocess.run(['bash', '-c', 'enable -n compgen; source "$1" 1', 'fixture', str(script)],
                capture_output=True, text=True, timeout=5,
                env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ.get('PATH', ''),
                     'DRAIN_FIXTURE': directory, 'FLEET_TARGETS': 'example/private',
                     'FLEET_SCOPE': 'repository', 'FLEET_APP_ID': '123',
                     'FLEET_INSTALLATION_ID': '456', 'FLEET_UNITS': 'github-runner-slot-1.service'})
            return result, (root / 'stopped').exists(), (runtime / 'draining').exists()

    def test_disabled_compgen_never_stops_a_busy_job_and_the_gate_remains_closed(self):
        result, stopped, gate = self.fixture(True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Drain timed out', result.stderr)
        self.assertFalse(stopped)
        self.assertTrue(gate)

    def test_idle_listeners_still_drain_when_remote_credentials_are_unavailable(self):
        result, stopped, gate = self.fixture(False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(stopped)
        self.assertTrue(gate)
