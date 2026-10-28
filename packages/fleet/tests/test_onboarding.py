"""Onboarding failures use fixtures only: no host credentials or disk devices."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'wizard'))
import decide
import iso_fixture
import node_readiness
from bootstrap_report import BootstrapReporter, ApprovalRefused

spec = importlib.util.spec_from_file_location('bootstrap_readiness', ROOT / 'scripts/bootstrap-readiness.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


TOKEN = 'enroll.test-only-token'
NODE = 'a' * 64


class OnboardingTests(unittest.TestCase):
    """The installer checks the base closure, the optional token and approval.
    It never decrypts secrets, registers GitHub runners or compares a role."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.system = self.root / 'system'
        self.etc = self.system / 'etc/fleet'
        self.etc.mkdir(parents=True)
        self.token = self.root / 'enrolled' / 'enrollment-token'
        self.token.parent.mkdir()
        self.token.write_text(TOKEN + '\n')
        self.metadata = {'version': 1, 'role': 'base', 'blocked': [], 'installBlocked': [], 'apiUrl': 'https://fleet.invalid',
                         'cacheUrl': 'https://cache.invalid/fleet', 'cachePublicKey': 'fixture:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                         'secretsFile': None, 'requiredSecrets': [], 'github': None}
        self.write_metadata()

    def write_metadata(self):
        (self.etc / 'bootstrap.json').write_text(json.dumps(self.metadata))

    def run_check(self, run):
        api = mock.Mock()
        bootstrap.check(self.system, self.token, run=run, api=api)
        return api

    def reporter(self, http):
        return BootstrapReporter(self.system, self.token, identity={'id': NODE, 'hostname': 'base-aaaa'}, http=http)

    def test_local_mode_checks_closure_without_remote_credentials(self):
        self.metadata.update(approvalMode="local", apiUrl="", updateMode="local")
        self.write_metadata()
        self.token.unlink()
        api = self.run_check(lambda *a, **kw: SimpleNamespace(returncode=0))
        api.assert_not_called()

    def test_local_mode_cannot_disable_a_configured_api(self):
        self.metadata.update(approvalMode="local")
        self.write_metadata()
        with self.assertRaises(bootstrap.NotReady):
            self.run_check(mock.Mock())

    def test_managed_mode_without_a_token_waits_for_app_approval(self):
        self.token.unlink()
        api = self.run_check(mock.Mock(return_value=SimpleNamespace(returncode=0)))
        api.assert_called_once_with('https://fleet.invalid', '')

    def test_a_malformed_token_is_refused_before_any_check(self):
        self.token.write_text('short\n')
        run = mock.Mock()
        with self.assertRaisesRegex(bootstrap.NotReady, 'FLEET_ENROLLMENT_INVALID') as caught:
            self.run_check(run)
        self.assertNotIn('short', str(caught.exception))
        run.assert_not_called()

    def test_checks_never_decrypt_secrets_and_keep_the_token_out_of_arguments(self):
        self.metadata.update(secretsFile='/fixture/encrypted.yaml', requiredSecrets=['github-app-key'],
                             github={'scope': 'repository', 'repositories': ['example/private'], 'appId': '1', 'installationId': '2'})
        self.write_metadata()
        run = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=b''))
        api = self.run_check(run)
        self.assertEqual([call.args[0][0] for call in run.call_args_list], ['nix'])
        self.assertNotIn(TOKEN, repr(run.call_args_list))
        api.assert_called_once_with('https://fleet.invalid', TOKEN)

    def test_the_single_blocked_list_refuses_without_network_access(self):
        for key in ('installBlocked', 'blocked'):
            with self.subTest(key=key):
                self.metadata = {k: v for k, v in self.metadata.items() if k != 'installBlocked'}
                self.metadata[key] = ['FLEET_REPOSITORY_UNCONFIGURED: configure the repository']
                self.write_metadata()
                run = mock.Mock()
                with self.assertRaisesRegex(bootstrap.NotReady, 'FLEET_PLATFORM_NOT_READY'):
                    self.run_check(run)
                run.assert_not_called()
                self.metadata[key] = []

    def test_install_blocked_takes_precedence_over_the_running_nodes_list(self):
        self.metadata.update(installBlocked=[], blocked=['FLEET_RUNNERS_UNCONFIGURED'])
        self.write_metadata()
        run = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=b''))
        self.run_check(run)
        self.assertEqual(run.call_count, 1)

    def test_local_build_metadata_checks_bundled_closure_without_private_cache(self):
        self.metadata.update(updateMode='local', cacheUrl=None, cachePublicKey=None)
        self.write_metadata()
        run = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=b''))
        self.run_check(run)
        self.assertEqual(run.call_args_list[0].args[0], ['nix', 'path-info', '--recursive', str(self.system)])
        self.assertNotIn('--store', repr(run.call_args_list))

    def test_missing_bundled_closure_refuses_before_disk_changes(self):
        self.metadata.update(updateMode='local', cacheUrl=None, cachePublicKey=None)
        self.write_metadata()
        run = mock.Mock(return_value=SimpleNamespace(returncode=1, stdout=b''))
        with self.assertRaisesRegex(bootstrap.NotReady, 'FLEET_LOCAL_CLOSURE_UNAVAILABLE'):
            self.run_check(run)
        self.assertEqual(run.call_count, 1)

    def test_unpublished_revision_is_a_retryable_pre_wipe_failure(self):
        run = mock.Mock(return_value=SimpleNamespace(returncode=1, stdout=b''))
        with self.assertRaisesRegex(bootstrap.Retryable, 'FLEET_CACHE_UNAVAILABLE'):
            self.run_check(run)
        self.assertEqual(run.call_count, 1)

    def test_token_check_follows_the_enrollment_check_contract(self):
        seen = []

        class Reply:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                return self.body

        def opener(*_handlers):
            def open_(request, timeout):
                seen.append(json.loads(request.data))
                return Reply(b'{"ok":true,"role":"devbox"}')
            return SimpleNamespace(open=open_)
        with mock.patch.object(bootstrap.urllib.request, 'build_opener', opener):
            bootstrap.check_api('https://fleet.invalid', TOKEN)
            bootstrap.check_api('https://fleet.invalid', '')
        # The role in the answer is the controller's decision, never compared.
        self.assertEqual(seen, [{'enrollmentToken': TOKEN}])

    def test_a_refused_token_stops_before_disk_changes(self):
        def opener(*_handlers):
            def open_(request, timeout):
                raise bootstrap.urllib.error.HTTPError(request.full_url, 401, 'no', {}, None)
            return SimpleNamespace(open=open_)
        with mock.patch.object(bootstrap.urllib.request, 'build_opener', opener):
            with self.assertRaisesRegex(bootstrap.NotReady, 'FLEET_ENROLLMENT_REJECTED') as caught:
                bootstrap.check_api('https://fleet.invalid', TOKEN)
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_registration_has_no_role_and_carries_the_token(self):
        requests = []
        def http(method, url, headers, body, timeout):
            requests.append((url, headers, json.loads(body)))
            return (201, b'{"status":"approved","role":null}') if url.endswith('/register') else (200, b'{"ok":true}')
        reporter = self.reporter(http)
        reporter.begin(mock.Mock())
        registered = requests[0][2]
        self.assertTrue(requests[0][0].endswith('/v1/nodes/register'))
        self.assertEqual(set(registered), {'nodeId', 'hostname', 'secret', 'enrollmentToken'})
        self.assertEqual(registered['enrollmentToken'], TOKEN)
        self.assertEqual(registered['hostname'], 'base-aaaa')

    def test_reporter_reuses_the_credential_that_the_installed_node_will_receive(self):
        requests = []
        def http(method, url, headers, body, timeout):
            requests.append((url, headers, json.loads(body)))
            return (201, b'{"status":"approved"}') if url.endswith('/register') else (200, b'{"ok":true}')
        reporter = self.reporter(http)
        reporter.begin(mock.Mock())
        secret = reporter.paths.secret.read_text().strip()
        self.assertEqual(reporter.paths.secret, self.token.parent / 'agent/node.secret')
        self.assertEqual(requests[0][2]['secret'], secret)
        self.assertEqual(requests[1][1]['Authorization'], 'Bearer ' + NODE + '.' + secret)
        heartbeat = requests[1][2]
        self.assertEqual((heartbeat['v'], heartbeat['role'], heartbeat['closure']), (2, 'base', 'base'))
        self.assertEqual(heartbeat['agent'], {'version': '2', 'desiredRevision': None})
        self.assertIsNone(heartbeat['revision'])
        self.assertIn('FLEET_INSTALLING', heartbeat['readiness']['issues'][0])
        again = self.reporter(http)
        again.begin(mock.Mock())
        self.assertEqual(again.paths.secret.read_text().strip(), secret)
        if os.name != 'nt':
            self.assertEqual(reporter.paths.secret.stat().st_mode & 0o777, 0o600)

    def test_pending_node_waits_for_app_approval_whatever_role_fleet_answers(self):
        self.token.unlink()
        calls = []
        def http(method, url, headers, body, timeout):
            payload = json.loads(body) if body else None
            calls.append((url, payload))
            if url.endswith('/register'):
                return 200, b'{"status":"pending","role":null}'
            if url.endswith('/enrollment/status'):
                return 200, json.dumps({'status': 'approved', 'nodeId': NODE, 'role': 'devbox'}).encode()
            return 200, b'{"ok":true}'
        reporter = self.reporter(http)
        with mock.patch('bootstrap_report.time.sleep'):
            reporter.begin(mock.Mock())
        self.assertTrue(reporter.started)
        self.assertNotIn('enrollmentToken', calls[0][1])
        self.assertNotIn('role', calls[0][1])
        self.assertTrue(calls[1][0].endswith('/enrollment/status'))
        self.assertEqual(reporter.paths.secret.read_text().strip(), calls[0][1]['secret'])

    def test_pending_approval_timeout_never_authorizes_installation(self):
        self.token.unlink()
        reporter = self.reporter(lambda *args: (200, b'{"status":"pending"}'))
        with mock.patch.dict(os.environ, {'FLEET_APPROVAL_WAIT_SECONDS': '0'}):
            with self.assertRaisesRegex(ApprovalRefused, 'Pending'):
                reporter.begin(mock.Mock())
        self.assertFalse(reporter.started)

    def test_rejected_identity_is_refused_before_installation(self):
        reporter = self.reporter(lambda *args: (200, b'{"status":"rejected"}'))
        with self.assertRaisesRegex(ApprovalRefused, 'FLEET_APPROVAL_REQUIRED'):
            reporter.begin(mock.Mock())

    def test_installer_manifest_blocks_before_admission_or_boot_preparation(self):
        tree = iso_fixture.installer_tree()
        tree['fleet-readiness.json'] = json.dumps({'version': 2, 'blocked': ['FLEET_REPOSITORY_UNCONFIGURED']}).encode()
        image = self.root / 'installer.iso'
        image.write_bytes(iso_fixture.build(tree))
        with mock.patch.object(decide.wifi_module(), 'simulated', return_value=False), mock.patch.object(decide, 'wifi_profile', return_value=None), \
                mock.patch.object(decide, 'close_job_admission') as close, mock.patch.object(decide, 'stage_reboot') as reboot:
            with self.assertRaisesRegex(decide.Invariant, 'FLEET_PLATFORM_NOT_READY'):
                decide.perform_install('Linux', image, None, self.root, {'ok': True, 'disk_id': 'fixture'})
            close.assert_not_called()
            reboot.assert_not_called()

    def test_missing_or_per_role_readiness_manifest_fails_closed(self):
        old = iso_fixture.installer_tree()
        old['fleet-readiness.json'] = json.dumps({'version': 1, 'roles': {'ci': {'blocked': []}}}).encode()
        for tree in (iso_fixture.installer_tree(), old):
            image = self.root / 'installer.iso'
            image.write_bytes(iso_fixture.build(tree))
            with mock.patch.object(decide.wifi_module(), 'simulated', return_value=False):
                with self.assertRaises(decide.Invariant):
                    decide.check_installer_readiness(image)

    @unittest.skipIf(os.name == 'nt', 'Source-system recovery runs on NixOS')
    def test_source_boot_recovery_only_undoes_its_own_reinstall_withdrawal(self):
        state, runtime = self.root / 'state', self.root / 'run'
        state.mkdir()
        resume = self.root / 'resume'
        resume.write_text('#!/bin/sh\ntouch "$FLEET_BUSY_DIR/resumed"\n')
        resume.chmod(0o700)
        for restore in ('0', '1'):
            (state / 'handoff').write_text('status=staged\nrestore_ci=' + restore + '\n')
            (state / 'withdrawn').write_text('status=withdrawn\nrole=ci\n')
            result = subprocess.run(['bash', str(ROOT / 'scripts/recover-handoff.sh')], capture_output=True,
                env={**os.environ, 'FLEET_STATE': str(state), 'FLEET_BUSY_DIR': str(runtime), 'FLEET_RESUME': str(resume)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((state / 'withdrawn').exists(), restore == '0')
            self.assertEqual((runtime / 'resumed').exists(), restore == '1')

    def test_readiness_is_unknown_without_evidence_and_failure_cannot_stop_reporting(self):
        paths = SimpleNamespace(etc=self.root / 'absent')
        self.assertIn('FLEET_READINESS_UNKNOWN', node_readiness.issues(paths, {}, mock.Mock(), None, {})[0])
        self.assertIn('FLEET_READINESS_FAILED', node_readiness.issues(None, {}, mock.Mock(), None, {})[0])

    def test_readiness_requires_current_sync_proof_and_live_github_runners(self):
        self.metadata.update(role='ci', github={'scope': 'repository', 'repositories': ['example/private'],
                                                'appId': '1', 'installationId': '2'})
        self.write_metadata()
        runtime = self.root / 'run'
        runtime.mkdir()
        (runtime / 'slot-count').write_text('1')
        (runtime / 'slot-1').mkdir()
        (runtime / 'slot-1/prerequisites').write_text('ok')
        (self.etc / 'revision').write_text('a' * 40)
        (self.root / 'sync').mkdir()
        (self.root / 'sync/last-success').write_text('a' * 40)
        paths = SimpleNamespace(etc=self.etc, run=runtime, state=self.root / 'agent', systemctl='systemctl')
        identity = {'role': 'ci', 'hostname': 'ci-aaaa', 'runner_prefix': 'ci-aaaa-' + 'a' * 32}
        run = mock.Mock(side_effect=lambda args, timeout: (0, json.dumps({'online': 1,
            'onlineNames': [identity['runner_prefix'] + '-slot-1']})) if args[0].endswith('runner-control') else (0, 'active'))
        self.assertEqual(node_readiness.issues(paths, identity, run, True, {}), [])
        self.assertIn(identity['runner_prefix'], run.call_args.args[0])
        (self.root / 'sync/last-success').write_text('b' * 40)
        self.assertTrue(any('UPDATE_CHECK_PENDING' in issue for issue in node_readiness.issues(paths, identity, run, True, {})))
        (self.root / 'sync/last-success').write_text('a' * 40)
        (paths.state / 'github-readiness.json').unlink()
        run.side_effect = lambda args, timeout: (0, '{"online":0,"onlineNames":[]}') if args[0].endswith('runner-control') else (0, 'active')
        self.assertIn('GITHUB_RUNNERS_PENDING', node_readiness.issues(paths, identity, run, True, {})[0])

    def test_bounded_github_checks_rotate_and_include_repository_overrides_of_organization_slots(self):
        runtime = self.root / 'run'
        (runtime / 'assign-used').mkdir(parents=True)
        (runtime / 'slot-count').write_text('2')
        for slot in ('slot-1', 'slot-2'):
            (runtime / slot).mkdir()
            (runtime / slot / 'prerequisites').write_text('ok')
        (runtime / 'assign-used/slot-1').write_text('example/override')
        paths = SimpleNamespace(run=runtime, state=self.root / 'agent', systemctl='systemctl')
        github = {'scope': 'organization', 'organization': 'example', 'appId': '1', 'installationId': '2'}
        identity = {'hostname': 'ci-aaaa', 'runner_prefix': 'ci-aaaa-' + 'a' * 32}
        calls = []
        def run(args, timeout):
            if args[0].endswith('runner-control'):
                calls.append(args[2:4])
                slot = '1' if args[2] == 'repository' else '2'
                return 0, json.dumps({'online': 1, 'onlineNames': [identity['runner_prefix'] + '-slot-' + slot]})
            return 0, 'active\nactive'
        with mock.patch.object(node_readiness.time, 'monotonic', side_effect=[0, 1, 10]):
            self.assertIn('GITHUB_CHECK_PENDING', node_readiness.github_issues(paths, identity, run, github, {})[0])
        with mock.patch.object(node_readiness.time, 'monotonic', side_effect=[0, 1]):
            self.assertEqual(node_readiness.github_issues(paths, identity, run, github, {}), [])
        self.assertCountEqual(calls, [['organization', 'example'], ['repository', 'example/override']])

    def test_short_hostname_collisions_cannot_replace_or_drain_another_nodes_runners(self):
        import cattle
        first = cattle.runner_prefix('ci-aaaa', 'aaaa' + '1' * 60)
        other = cattle.runner_prefix('ci-aaaa', 'aaaa' + '2' * 60)
        self.assertNotEqual(first, other)
        self.assertLess(len(first + '-slot-8'), 64)

    @unittest.skipIf(os.name == 'nt', 'Boot recovery runs on NixOS')
    def test_boot_health_keeps_first_boot_alive_and_only_reboots_counted_upgrades_with_a_fallback(self):
        binaries = self.root / 'bin'
        binaries.mkdir()
        log = self.root / 'reboots'
        for name, body in {'curl': 'exit 1', 'bless': 'echo indeterminate',
                           'systemctl': f'[ "$1" != reboot ] || echo reboot >> "{log}"'}.items():
            path = binaries / name
            path.write_text('#!/bin/bash\n' + body + '\n')
            path.chmod(0o700)
        envfile = self.root / 'sync.env'
        envfile.write_text('CACHE_URL=https://cache.invalid/fleet\n')
        entries = self.root / 'entries'
        entries.mkdir()
        env = {**os.environ, 'SYNC_ENV': str(envfile), 'FLEET_STATE': str(self.root / 'state'),
               'FLEET_CURL': str(binaries / 'curl'), 'FLEET_SYSTEMCTL': str(binaries / 'systemctl'),
               'FLEET_BLESS': str(binaries / 'bless'), 'FLEET_BOOT_ENTRIES': str(entries)}
        for fallback in (False, True):
            if fallback:
                for name in ('nixos-generation-1.conf', 'nixos-generation-2+2-1.conf'):
                    (entries / name).touch()
            done = subprocess.run(['bash', str(ROOT / 'scripts/boot-health.sh')], env=env, capture_output=True)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(log.exists(), fallback)
        self.assertIn('FLEET_BOOT_HEALTH_FAILED', (self.root / 'state/sync/health-failure').read_text())

    @unittest.skipIf(os.name == 'nt', 'Nix garbage-collection roots use POSIX symlinks')
    def test_successful_boot_protects_both_last_known_healthy_generations_from_gc(self):
        binaries = self.root / 'bin'
        binaries.mkdir()
        for name in ('curl', 'systemctl'):
            path = binaries / name
            path.write_text('#!/bin/sh\nexit 0\n')
            path.chmod(0o700)
        envfile = self.root / 'sync.env'
        envfile.write_text('CACHE_URL=https://cache.invalid/fleet\n')
        roots = self.root / 'roots'
        for name in ('first', 'second'):
            generation = self.root / name
            generation.mkdir()
            done = subprocess.run(['bash', str(ROOT / 'scripts/boot-health.sh')], capture_output=True,
                env={**os.environ, 'SYNC_ENV': str(envfile), 'FLEET_GC_ROOTS': str(roots),
                     'FLEET_BOOTED_SYSTEM': str(generation), 'FLEET_CURL': str(binaries / 'curl'),
                     'FLEET_SYSTEMCTL': str(binaries / 'systemctl')})
            self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((roots / 'fleet-last-healthy').resolve(), (self.root / 'second').resolve())
        self.assertEqual((roots / 'fleet-previous-healthy').resolve(), (self.root / 'first').resolve())


if __name__ == '__main__':
    unittest.main()
