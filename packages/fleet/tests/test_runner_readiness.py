"""Readiness needs each expected runner, not aggregate registration counts."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bootstrap_report
import node_readiness


class RunnerReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        runtime = self.root / 'run'
        runtime.mkdir()
        (runtime / 'slot-count').write_text('2')
        self.paths = SimpleNamespace(run=runtime, state=self.root / 'agent', systemctl='systemctl')
        self.identity = {'hostname': 'ci-aaaa', 'runner_prefix': 'ci-aaaa-' + 'a' * 32}
        self.prefix = self.identity['runner_prefix']
        self.github = {'scope': 'repository', 'repositories': ['example/a', 'example/b'],
                       'appId': '1', 'installationId': '2'}
        for slot in ('slot-1', 'slot-2'):
            (runtime / slot).mkdir()
            (runtime / slot / 'prerequisites').write_text('ok\n')

    def check(self, names):
        def run(args, timeout):
            if args[0] == 'systemctl':
                return 0, 'active\nactive'
            online = names[args[3]]
            return 0, json.dumps({'online': len(online), 'onlineNames': online})
        return node_readiness.github_issues(self.paths, self.identity, run, self.github, {})

    def inactive(self, restarts=0, register=None):
        if register is not None:
            (self.paths.run / 'register').mkdir(exist_ok=True)
            (self.paths.run / 'register' / 'slot-2.json').write_text(json.dumps(register))
        def run(args, timeout):
            if args[1] == 'is-active':
                return 3, 'active\nactivating'
            if args[1] == 'show':
                return 0, ('Id=github-runner-slot-1.service\nActiveState=active\nNRestarts=0\n\n'
                           f'Id=github-runner-slot-2.service\nActiveState=activating\nNRestarts={restarts}\n')
            raise AssertionError(args)
        return node_readiness.github_issues(self.paths, self.identity, run, self.github, {})[0]

    def test_an_inactive_slot_is_explained_by_its_last_registration_or_said_to_be_unknown(self):
        self.assertEqual(self.inactive(), 'FLEET_RUNNERS_STARTING: 1 of 2 runner services are active.')
        refused = {'code': 'FLEET_GITHUB_KEY', 'message': 'GitHub refused the App credential (HTTP 401)', 'exit': 78}
        self.assertTrue(self.inactive(register=refused).startswith('FLEET_GITHUB_KEY: runner slot-2 cannot register with GitHub'))
        temporary = {'code': 'FLEET_GITHUB_UNAVAILABLE', 'message': 'GitHub could not be reached', 'exit': 75}
        self.assertIn('retrying automatically', self.inactive(register=temporary))
        (self.paths.run / 'register' / 'slot-2.json').unlink()
        looping = self.inactive(restarts=5)
        self.assertTrue(looping.startswith('FLEET_RUNNER_RESTARTING: runner slot-2 has restarted 5 times'))
        self.assertIn('not recorded', looping)

    def test_a_refused_status_check_names_the_refusal_not_a_retry(self):
        def run(args, timeout):
            if args[0] == 'systemctl':
                return 0, 'active\nactive'
            return 78, json.dumps({'code': 'FLEET_GITHUB_SCOPE', 'message': 'GitHub answered HTTP 404 for the runner target'})
        issue = node_readiness.github_issues(self.paths, self.identity, run, self.github, {})[0]
        self.assertTrue(issue.startswith('FLEET_GITHUB_SCOPE: GitHub answered HTTP 404'))
        self.assertNotIn('retrying', issue)

    def test_online_runner_without_a_successful_service_probe_is_not_ready(self):
        names = {'example/a': [self.prefix + '-slot-1'], 'example/b': [self.prefix + '-slot-2']}
        status = self.paths.run / 'slot-1/prerequisites'
        for value in (None, 'checking', 'unknown', 'x' * 1000):
            if value is None:
                status.unlink()
            else:
                status.write_text(value)
            self.assertIn('no successful service prerequisite check', self.check(names)[0])

    def test_failed_probe_names_the_stage_even_when_the_service_is_restarting(self):
        status = self.paths.run / 'slot-2/prerequisites'
        for stage, expected in [('tool:gh', 'gh discovery/execution'), ('checkout', 'Git checkout'),
                                ('filesystem', 'filesystem operations')]:
            status.write_text('failed:' + stage)
            issue = self.inactive(restarts=5)
            self.assertIn('FLEET_RUNNER_PREREQUISITE_FAILED', issue)
            self.assertIn(expected, issue)
        status.write_text('failed:password=do-not-report')
        self.assertNotIn('do-not-report', self.inactive())

    def test_probe_status_rejects_nonregular_files_and_malformed_bytes(self):
        status = self.paths.run / 'slot-1/prerequisites'
        target = self.root / 'outside'
        target.write_text('ok')
        status.unlink()
        status.symlink_to(target)
        self.assertEqual(node_readiness.prerequisite_status(status), '')
        status.unlink()
        os.mkfifo(status)
        self.assertEqual(node_readiness.prerequisite_status(status), '')
        status.unlink()
        status.write_bytes(b'\xff')
        self.assertEqual(node_readiness.prerequisite_status(status), '')

    def test_extra_runners_on_one_repository_cannot_hide_a_missing_assigned_runner(self):
        names = {'example/a': [self.prefix + '-slot-1', self.prefix + '-slot-2'], 'example/b': []}
        self.assertIn('1 of 2 expected runners', self.check(names)[0])

    def test_each_runner_must_be_online_on_its_own_assigned_repository(self):
        names = {'example/a': [self.prefix + '-slot-2'], 'example/b': [self.prefix + '-slot-1']}
        self.assertIn('0 of 2 expected runners', self.check(names)[0])
        (self.paths.state / 'github-readiness.json').unlink()
        names = {'example/a': [self.prefix + '-slot-1'], 'example/b': [self.prefix + '-slot-2']}
        self.assertEqual(self.check(names), [])

    def test_duplicate_names_cannot_substitute_for_a_missing_slot(self):
        self.github['repositories'] = ['example/a']
        self.assertIn('1 of 2 expected runners', self.check({'example/a': [self.prefix + '-slot-1'] * 2})[0])

    def test_old_count_only_cache_is_rechecked_instead_of_claiming_readiness(self):
        self.paths.state.mkdir()
        evidence = {f'repository:example/{target}': {'online': 2, 'checked': time.time()} for target in ('a', 'b')}
        (self.paths.state / 'github-readiness.json').write_text(json.dumps({'prefix': self.prefix, 'targets': evidence}))
        self.assertIn('0 of 2 expected runners', self.check({'example/a': [], 'example/b': []})[0])

    def test_another_nodes_name_is_not_accepted_as_status_evidence(self):
        names = {'example/a': ['ci-another-slot-1'], 'example/b': [self.prefix + '-slot-2']}
        self.assertIn('FLEET_GITHUB_UNAVAILABLE', self.check(names)[0])


class BootstrapProgressTests(unittest.TestCase):
    def test_installer_bootstrap_packaging_includes_the_agents_runtime_imports(self):
        fleet = Path(__file__).resolve().parents[1]
        declaration = (fleet / 'modules/installer.nix').read_text().split('readiness =', 1)[1].split("'';", 1)[0]
        copies = re.findall(r'cp \$\{\.\./scripts/([^}]+)\} "\$out/([^"]+)"', declaration)
        self.assertTrue(copies)
        with tempfile.TemporaryDirectory() as directory:
            for source, target in copies:
                shutil.copyfile(fleet / 'scripts' / source, Path(directory) / target)
            # Isolated Python cannot accidentally satisfy a missing packaged
            # import from the checkout or another test's sys.path.
            code = 'import sys; sys.path.insert(0, sys.argv[1]); import bootstrap_report'
            done = subprocess.run([sys.executable, '-I', '-B', '-c', code, directory],
                                  capture_output=True, text=True, timeout=20)
            self.assertEqual(done.returncode, 0, done.stderr)

    def test_progress_reads_the_end_of_a_log_larger_than_64_kib(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'install.log'
            log.write_bytes(b'old step\n' + b'long output\n' * 10000 + 'Installing the latest generation ✓\n'.encode())
            self.assertEqual(bootstrap_report.latest_progress(log), 'Installing the latest generation ✓')
            log.write_bytes(b'x' * 70000 + b'\nFinal recent step\n')
            self.assertEqual(bootstrap_report.latest_progress(log), 'Final recent step')
            self.assertIsNone(bootstrap_report.latest_progress(log.with_name('missing')))

    def test_periodic_report_redacts_the_recent_log_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = root / 'node.secret'
            secret.write_text('a' * 64)
            log = root / 'install.log'
            log.write_text('old\n' * 20000 + 'Latest password=private-value test-only-role-token\n')
            reporter = SimpleNamespace(paths=SimpleNamespace(secret=secret), worker=SimpleNamespace(),
                                       token='test-only-role-token', report=mock.Mock())
            with mock.patch.object(bootstrap_report, 'BootstrapReporter', return_value=reporter), \
                    mock.patch.object(bootstrap_report.cattle, 'read_machine_digest', return_value='b' * 64), \
                    mock.patch.object(bootstrap_report.os, 'kill', side_effect=[None, ProcessLookupError]), \
                    mock.patch.object(bootstrap_report.time, 'sleep'), \
                    mock.patch.dict(bootstrap_report.os.environ, {'FLEET_INSTALL_LOG': str(log)}):
                bootstrap_report.main(['fixture-system', 'ci', 'fixture-token', 'Waiting', '123'])
            reported = reporter.report.call_args.args[0]
            self.assertIn('Latest', reported)
            self.assertNotIn('private-value', reported)
            self.assertNotIn(reporter.token, reported)


if __name__ == '__main__':
    unittest.main()
