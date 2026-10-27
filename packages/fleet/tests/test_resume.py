"""Exercise the actual recovery script with fake systemd; VM tests use real locks."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'scripts/resume.sh'


@unittest.skipIf(os.name == 'nt', 'Runner recovery executes on NixOS')
class ResumeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run = self.root / 'run'
        self.run.mkdir()
        (self.run / 'slot-count').write_text('2')
        (self.run / 'draining').touch()
        binaries = self.root / 'bin'
        binaries.mkdir()
        self.write(binaries / 'flock', '#!/bin/sh\nexit 0\n')
        self.write(binaries / 'fleetconf', '#!/bin/sh\ncase "$2" in runners.cordoned) echo "${FLEET_TEST_CORDON:-false}";; *) echo true;; esac\n')
        self.write(binaries / 'systemctl', f'''#!{sys.executable}
import json,os,sys
from pathlib import Path
root=Path(os.environ['FLEET_TEST_ROOT']);run=root/'run';args=sys.argv[1:]
with (root/'calls').open('a') as stream: stream.write(json.dumps(args)+'\\n')
if args[0]=='show':
    print(os.environ.get('FLEET_TEST_SYNC','inactive'));sys.exit(0)
if args[0]=='is-failed':sys.exit(1)
if args[0]=='stop':
    for unit in args[1:]:
        slot=unit.removeprefix('github-runner-').removesuffix('.service')
        assert not (run/slot/'busy').exists(),'an active job was interrupted'
if args[0]=='--no-block':
    assert args[1]=='start'
    if (run/'draining').exists():sys.exit(0) # systemd silently skips the condition
    if (root/'fail-start').exists():sys.exit(1)
    (run/'started').mkdir(exist_ok=True)
    for unit in args[2:]:(run/'started'/unit).touch()
''')
        self.env = {**os.environ, 'FLEET_TEST_ROOT': str(self.root), 'FLEET_BUSY_DIR': str(self.run),
            'FLEET_SYSTEMD_RUNTIME': str(self.root / 'systemd'), 'FLEETCONF': str(binaries / 'fleetconf'),
            'FLEET_SYSTEMCTL': str(binaries / 'systemctl'), 'FLEET_SLOT_MAX': '2',
            'PATH': str(binaries) + os.pathsep + os.environ.get('PATH', '')}

    def write(self, path, content):
        path.write_text(content)
        path.chmod(0o700)

    def resume(self, **env):
        return subprocess.run(['bash', str(SCRIPT)], env={**self.env, **env}, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]

    def test_low_disk_keeps_admission_closed_and_a_resume_clears_every_other_reason(self):
        reasons = self.run / 'drain-reasons'
        reasons.mkdir()
        (reasons / 'low-disk').write_text('2026-10-26T00:00:00Z\n')
        result = self.resume()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('FLEET_LOW_DISK', result.stdout)
        self.assertTrue((self.run / 'draining').exists(), 'only the cache cleanup lifts a low-disk drain')
        (reasons / 'low-disk').unlink()
        for name in ('config', 'manual', 'unknown'):
            (reasons / name).write_text('2026-10-26T00:00:00Z\n')
        result = self.resume()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.run / 'draining').exists())
        self.assertEqual(list(reasons.iterdir()), [], 'no orphaned reason survives a resume')

    def test_start_conditions_see_the_reopened_gate_and_busy_jobs_are_not_stopped(self):
        (self.run / 'slot-1').mkdir()
        (self.run / 'slot-1/busy').touch()
        result = self.resume()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.run / 'draining').exists())
        self.assertTrue((self.run / 'slot-1/busy').exists())
        self.assertEqual(sorted(path.name for path in (self.run / 'started').iterdir()),
            ['github-runner-slot-1.service', 'github-runner-slot-2.service'])
        self.assertEqual([call for call in self.calls() if call[0] == 'stop'], [['stop', 'github-runner-slot-2.service']])

    def test_active_update_preserves_gate_and_an_interrupted_updater_recovers(self):
        (self.run / 'update-draining').touch()
        for state in ('active', 'activating', 'reloading'):
            self.assertEqual(self.resume(FLEET_TEST_SYNC=state).returncode, 75)
            self.assertTrue((self.run / 'draining').exists())
        result = self.resume(FLEET_TEST_SYNC='failed')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.run / 'update-draining').exists())
        self.assertTrue((self.run / 'started').is_dir())

    def test_failed_start_recloses_admission_and_retains_automatic_retry_intent(self):
        (self.root / 'fail-start').touch()
        result = self.resume()
        self.assertEqual(result.returncode, 1)
        self.assertTrue((self.run / 'draining').exists())
        self.assertTrue((self.run / 'agent-drained').exists())
        (self.root / 'fail-start').unlink()
        self.assertEqual(self.resume().returncode, 0)
        self.assertFalse((self.run / 'draining').exists())
        self.assertTrue((self.run / 'started').is_dir())

    def test_deliberate_cordon_and_invalid_capacity_never_start_runners(self):
        self.assertEqual(self.resume(FLEET_TEST_CORDON='true').returncode, 0)
        self.assertTrue((self.run / 'draining').exists())
        self.assertFalse((self.run / 'started').exists())
        (self.run / 'slot-count').write_text('999')
        self.assertEqual(self.resume().returncode, 1)
        self.assertTrue((self.run / 'draining').exists())
        self.assertFalse((self.run / 'started').exists())
