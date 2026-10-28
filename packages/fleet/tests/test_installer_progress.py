"""Installer progress reaches the controller (phase-tagged, redacted, bounded), the live installer
refuses unsupported hardware before registering, and an expired or revoked grant stops before erasing.
Fixtures only: no network, disk or controller."""
import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'wizard'))
import bootstrap_report  # noqa: E402
import decide  # noqa: E402
from bootstrap_report import BootstrapReporter, current_phase, tag  # noqa: E402

spec = importlib.util.spec_from_file_location('bootstrap_readiness_progress', ROOT / 'scripts/bootstrap-readiness.py')
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)

NODE = 'b' * 64
TOKEN = 'fgr_' + 'Z' * 43


class TagTests(unittest.TestCase):
    def test_coded_messages_gain_a_phase_after_the_code(self):
        self.assertEqual(tag('FLEET_API_UNAVAILABLE: Fleet is down.', 'checks'), 'FLEET_API_UNAVAILABLE: phase=checks Fleet is down.')

    def test_plain_messages_become_installing_reports(self):
        self.assertEqual(tag('copying files', 'install'), 'FLEET_INSTALLING: phase=install copying files')

    def test_a_phase_the_shell_already_named_is_kept_once(self):
        message = 'FLEET_INSTALL_FAILED: phase=erase installer exited 1 at line 9.'
        self.assertEqual(tag(message, 'checks'), message)

    def test_an_unknown_phase_falls_back_and_the_report_is_bounded(self):
        self.assertIn('phase=checks', tag('FLEET_X: y', 'nonsense'))
        self.assertEqual(len(tag('FLEET_X: ' + 'a' * 2000, 'disk')), 500)


class PhaseTests(unittest.TestCase):
    def test_the_latest_step_in_the_log_is_the_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'install.log'
            log.write_text('2026-10-28T10:00:00Z step network\n2026-10-28T10:00:05Z not a step line\n'
                           '2026-10-28T10:01:00Z step checks\n2026-10-28T10:02:00Z step erase\n2026-10-28T10:02:01Z partitioning with disko\n')
            self.assertEqual(current_phase(log), 'erase')
            self.assertIsNone(current_phase(log.with_name('missing')))
            log.write_text('2026-10-28T10:00:00Z the next step is unknown\n')
            self.assertIsNone(current_phase(log))


class ReporterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        system = root / 'system' / 'etc/fleet'
        system.mkdir(parents=True)
        (system / 'bootstrap.json').write_text(json.dumps({'apiUrl': 'https://fleet.invalid'}))
        token = root / 'enrolled' / 'enrollment-token'
        token.parent.mkdir()
        token.write_text(TOKEN + '\n')
        self.sent = []

        def http(method, url, headers, body, timeout):
            self.sent.append(json.loads(body) if body else None)
            return 200, b'{"status":"approved"}'
        self.reporter = BootstrapReporter(root / 'system', token, identity={'id': NODE, 'hostname': 'base-bbbb'}, http=http)
        self.reporter.started = True
        self.reporter.worker.secret = 'c' * 64

    def test_a_report_carries_phase_message_and_failure_state_without_credentials(self):
        self.reporter.report(f'FLEET_INSTALLING: copying with {TOKEN} and secret {"c" * 64}', phase='install')
        body = self.sent[0]
        issue = body['readiness']['issues'][0]
        self.assertTrue(issue.startswith('FLEET_INSTALLING: phase=install '), issue)
        self.assertNotIn(TOKEN, json.dumps(body))
        self.assertNotIn('c' * 64, json.dumps(body))
        self.assertEqual(body['reconcile']['phase'], 'progressing')
        self.assertEqual(body['events'][0]['severity'], 'info')

    def test_a_failure_is_blocked_and_an_error_event(self):
        self.reporter.report('FLEET_API_UNAVAILABLE: Fleet could not be reached.', failed=True)
        body = self.sent[0]
        self.assertEqual(body['reconcile']['phase'], 'blocked')
        self.assertEqual(body['events'][0]['severity'], 'error')
        self.assertIn('phase=checks', body['reconcile']['issues'][0])

    def test_an_unreachable_controller_never_hides_the_original_failure(self):
        def broken(*args):
            raise bootstrap_report.agent.NetworkError('down')
        self.reporter.worker.http = broken
        self.reporter.report('FLEET_INSTALLING: still going', phase='disk')  # best effort: no exception


class LiveHardwareTests(unittest.TestCase):
    def verdict(self, **changes):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'efi').mkdir()
            (root / 'meminfo').write_text(changes.pop('meminfo', 'MemTotal:       16000000 kB\n'))
            adapters = changes.pop('adapters', [{'name': 'enp1', 'type': 'wired', 'driver': 'r8169'}])
            if adapters is not None:
                (root / 'network.json').write_text(json.dumps({'adapters': adapters}))
            environ = {'FLEET_MEMINFO': str(root / 'meminfo'), 'FLEET_LIVE_STATE': str(root), 'FLEET_ARCH': changes.pop('arch', 'x86_64'),
                       'FLEET_EFI_DIR': str(root / ('efi' if changes.pop('uefi', True) else 'none'))}
            return readiness.live_hardware(environ)

    def test_a_normal_machine_is_supported(self):
        self.assertEqual(self.verdict()['tier'], 'supported')

    def test_unsupported_hardware_is_refused_before_registering_with_a_public_code(self):
        for changes, code in (({'arch': 'aarch64'}, 'arch-not-x86-64'), ({'uefi': False}, 'firmware-not-uefi'),
                              ({'meminfo': 'MemTotal: 1000000 kB\n'}, 'ram-below-minimum'),
                              ({'adapters': [{'name': 'wlp1', 'type': 'wifi', 'driver': 'none'}]}, 'no-network-driver')):
            verdict = self.verdict(**changes)
            self.assertEqual(verdict['tier'], 'unsupported', code)
            self.assertIn(code, {r['code'] for r in verdict['reasons']})
            with self.assertRaisesRegex(readiness.NotReady, 'FLEET_HARDWARE_UNSUPPORTED.*Nothing was erased'):
                readiness.refuse_unsupported_hardware(verdict)

    def test_unknown_network_facts_never_refuse(self):
        self.assertEqual(self.verdict(adapters=None)['tier'], 'supported')
        self.assertEqual(self.verdict(adapters=[])['tier'], 'supported')

    def test_a_missing_decide_or_unreadable_state_degrades_to_no_verdict(self):
        readiness.refuse_unsupported_hardware(None)
        with mock.patch.dict(sys.modules, {'decide': None}):
            self.assertIsNone(readiness.live_hardware({}))


class GrantRefusalTests(unittest.TestCase):
    def refusal(self, code):
        error = urllib.error.HTTPError('https://fleet.invalid', 401, 'x', {}, BytesIO(json.dumps({'error': code}).encode()))
        opener = mock.Mock()
        opener.open.side_effect = error
        with mock.patch.object(readiness.urllib.request, 'build_opener', return_value=opener):
            readiness.check_api('https://fleet.invalid', TOKEN)

    def test_expired_and_revoked_grants_say_so_and_that_nothing_was_erased(self):
        for code, marker in (('enrollment_grant_expired', 'FLEET_ENROLLMENT_EXPIRED'), ('enrollment_grant_revoked', 'FLEET_ENROLLMENT_REVOKED')):
            with self.assertRaisesRegex(readiness.NotReady, marker + '.*Nothing was erased') as caught:
                self.refusal(code)
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_other_refusals_keep_the_existing_code(self):
        with self.assertRaisesRegex(readiness.NotReady, 'FLEET_ENROLLMENT_REJECTED'):
            self.refusal('enrollment_not_ready')


class LiveConsoleAdviceTests(unittest.TestCase):
    def test_the_screen_gives_actionable_steps_for_the_new_codes(self):
        import live_console
        for reason, word in (('FLEET_HARDWARE_UNSUPPORTED: no network adapter has a driver', 'hardware'),
                             ('FLEET_ENROLLMENT_EXPIRED: the installer grant expired', 'grant'),
                             ('FLEET_ENROLLMENT_REVOKED: the installer grant was revoked', 'grant')):
            summary, steps = live_console.advice(reason)
            self.assertIn(word, summary.lower(), reason)
            self.assertTrue(steps)
            self.assertTrue(any('Nothing was erased' in step or 'Pending' in step or 'Use a supported' in step for step in steps))


if __name__ == '__main__':
    unittest.main()
