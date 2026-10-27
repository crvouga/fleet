"""Outages and broken scheduling must never silently strand an installed node."""
import fcntl
import unittest

import test_sync as fixture


class SyncRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.node = fixture.SyncTests()
        self.node.setUp()
        self.addCleanup(self.node.tearDown)

    def test_interrupted_profile_selection_keeps_the_saved_rollback_generation(self):
        node = self.node
        roots = node.root / 'gcroots'
        node.env['FLEET_GC_ROOTS'] = str(roots)
        node.commit('healthy')
        self.assertEqual(node.run_sync().returncode, 0)
        healthy = node.profile.resolve()
        (node.root / 'fail-health').touch()
        node.commit('unhealthy')
        self.assertNotEqual(node.run_sync().returncode, 0)
        revision = node._git(['-C', str(node.origin), 'rev-parse', 'HEAD']).stdout.strip()
        candidate = node.root / 'closures' / revision
        self.assertEqual((roots / 'fleet-update-previous').resolve(), healthy)
        # Power loss after nix-env --set can leave the profile on the candidate,
        # with no successful health check and the old closure still GC-rooted.
        node.profile.unlink()
        node.profile.symlink_to(candidate)
        retried = node.run_sync()
        self.assertNotEqual(retried.returncode, 0)
        self.assertEqual(node.profile.resolve(), healthy)
        self.assertEqual((roots / 'fleet-update-previous').resolve(), healthy)
        self.assertNotIn('FLEET_ROLLBACK_UNAVAILABLE', (node.state / 'health-failure').read_text())

    def test_abruptly_interrupted_git_locks_are_recovered_without_manual_cleanup(self):
        node = self.node
        node.commit('initial')
        self.assertEqual(node.run_sync().returncode, 0)
        node.commit('after-power-loss')
        checkout = node.state / 'repo/.git'
        for name in ('index.lock', 'shallow.lock', 'config.lock'):
            (checkout / name).touch()
        recovered = node.run_sync()
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        expected = node._git(['-C', str(node.origin), 'rev-parse', 'HEAD']).stdout.strip()
        self.assertEqual((node.state / 'last-success').read_text().strip(), expected)
        self.assertFalse(any(checkout.glob('*.lock')))

    def test_new_commit_after_interruption_preserves_the_healthy_rollback_target(self):
        node = self.node
        roots = node.root / 'gcroots'
        node.env['FLEET_GC_ROOTS'] = str(roots)
        node.commit('healthy')
        self.assertEqual(node.run_sync().returncode, 0)
        healthy = node.profile.resolve()
        (node.root / 'fail-health').touch()
        node.commit('interrupted')
        self.assertNotEqual(node.run_sync().returncode, 0)
        revision = node._git(['-C', str(node.origin), 'rev-parse', 'HEAD']).stdout.strip()
        candidate = node.root / 'closures' / revision
        # The updater records this candidate before selecting its profile.
        self.assertEqual((node.state / 'pending-generation').read_text().strip(), str(candidate.resolve()))
        node.profile.unlink()
        node.profile.symlink_to(candidate)
        node.commit('new-release-during-outage')
        retried = node.run_sync()
        self.assertNotEqual(retried.returncode, 0)
        self.assertEqual(node.profile.resolve(), healthy)
        self.assertEqual((roots / 'fleet-update-previous').resolve(), healthy)
        (node.root / 'fail-health').unlink()
        self.assertEqual(node.run_sync().returncode, 0)
        self.assertFalse((node.state / 'pending-generation').exists())

    def test_live_update_lock_preserves_the_running_generation_and_git_writer(self):
        node = self.node
        node.commit('initial')
        self.assertEqual(node.run_sync().returncode, 0)
        previous = node.profile.resolve()
        node.commit('pending')
        with (node.state / 'update.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            git_lock = node.state / 'repo/.git/index.lock'
            git_lock.touch()
            waiting = node.run_sync()
            self.assertEqual(waiting.returncode, 0, waiting.stderr)
            self.assertIn('another update is running', waiting.stdout)
            self.assertEqual(node.profile.resolve(), previous)
            self.assertTrue(git_lock.exists())
        self.assertEqual(node.run_sync().returncode, 0)
        self.assertNotEqual(node.profile.resolve(), previous)

    def test_inactive_or_disabled_timer_rolls_back_even_when_network_health_passes(self):
        node = self.node
        node.commit('initial')
        self.assertEqual(node.run_sync().returncode, 0)
        fixture.write_executable(node.bin / 'systemctl', f'''\
            #!/bin/bash
            if [ -f {node.root}/reject-timer ] && [ "$1" = "$(cat {node.root}/reject-timer)" ]; then exit 3; fi
            exit 0
            ''')
        for command in ('is-active', 'is-enabled'):
            with self.subTest(command=command):
                previous = node.profile.resolve()
                success = (node.state / 'last-success').read_text()
                node.commit('next-' + command)
                (node.root / 'reject-timer').write_text(command)
                failed = node.run_sync()
                self.assertNotEqual(failed.returncode, 0, failed.stdout + failed.stderr)
                self.assertEqual(node.profile.resolve(), previous)
                self.assertEqual((node.state / 'last-success').read_text(), success)
                self.assertIn('fleet-sync.timer', (node.state / 'health-failure').read_text())
                (node.root / 'reject-timer').unlink()
                recovered = node.run_sync()
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                self.assertNotEqual(node.profile.resolve(), previous)
                self.assertFalse((node.state / 'health-failure').exists())

    def test_reconnection_catches_up_and_delayed_cache_publication_needs_no_new_commit(self):
        node = self.node
        node.commit('initial')
        self.assertEqual(node.run_sync().returncode, 0)
        previous = node.profile.resolve()
        success = (node.state / 'last-success').read_text()
        original = node.origin
        node.origin = node.root / 'offline-origin'
        original.rename(node.origin)
        node.flake = node.origin / 'packages/fleet'
        node.commit('missed-one')
        node.commit('missed-two')
        offline = node.run_sync()
        self.assertNotEqual(offline.returncode, 0)
        self.assertEqual(node.profile.resolve(), previous)
        self.assertEqual((node.state / 'last-success').read_text(), success)
        latest = node._git(['-C', str(node.origin), 'rev-parse', 'HEAD']).stdout.strip()
        node.origin.rename(original)
        (node.bin / 'nix').rename(node.bin / 'cached-nix')
        fixture.write_executable(node.bin / 'nix', f'''\
            #!/bin/bash
            if [ -e {node.root}/cache-unavailable ]; then exit 1; fi
            exec {node.bin}/cached-nix "$@"
            ''')
        (node.root / 'cache-unavailable').touch()
        self.assertNotEqual(node.run_sync().returncode, 0)
        self.assertEqual(node.profile.resolve(), previous)
        (node.root / 'cache-unavailable').unlink()
        recovered = node.run_sync()
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertEqual((node.profile.resolve() / 'commit').read_text().strip(), latest)
        self.assertEqual((node.state / 'last-success').read_text().strip(), latest)
        self.assertEqual(node.actions(), ['switch', 'switch'])
        self.assertFalse((node.state / 'health-failure').exists())
