#!/usr/bin/env python3
"""fleet-sync pulls main, builds locally and keeps the current system on failure."""

import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fleet-sync.sh"
FLEETCONF = Path(__file__).parents[1] / "scripts" / "fleetconf.py"
FLEET_ROLES = Path(__file__).parents[1] / "scripts" / "fleet_roles.py"
REGISTRY = Path(__file__).parents[1] / "roles.json"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.origin = self.root / "origin"
        self.flake = self.origin / "packages" / "fleet"
        self.flake.mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        write_executable(self.bin / "timeout", "#!/bin/bash\ncase \"$1\" in --kill-after=*) shift;; esac\nshift\nexec \"$@\"\n")
        self.log = self.root / "actions"
        self.nix_log = self.root / "nix-args"
        self.profile = self.root / "profile"
        self.booted = self.root / "booted"
        self.state = self.root / "state"
        self._git(["init", "-b", "main", str(self.origin)])
        self._git(["-C", str(self.origin), "config", "user.email", "test@example.invalid"])
        self._git(["-C", str(self.origin), "config", "user.name", "test"])
        write_executable(self.bin / "nix", f"""\
            #!/bin/bash
            set -euo pipefail
            printf '%s\\n' "$*" >> {self.nix_log}
            jobs=""
            prev=""
            flake=""
            if [ "$1 $2" = 'store verify' ]; then exit 1; fi
            for arg in "$@"; do
              if [ "$prev" = "--max-jobs" ]; then jobs=$arg; fi
              prev=$arg
              case "$arg" in
                git+file:*) flake=$arg ;;
              esac
            done
            if [ "$jobs" != 2 ]; then
              echo 'bounded local build required' >&2
              exit 2
            fi
            checkout=''${{flake#git+file://}}
            checkout=''${{checkout%%\?*}}/packages/fleet
            if [ -f "$checkout/NOT_IN_CACHE" ]; then
              echo 'not in cache' >&2
              exit 1
            fi
            rev=$(git -C "$checkout" rev-parse HEAD)
            work={self.root}/closures/$rev
            mkdir -p "$work/bin"
            if [ -f "$checkout/bootstrap.json" ]; then
              mkdir -p "$work/etc/fleet"
              cp "$checkout/bootstrap.json" "$work/etc/fleet/bootstrap.json"
            fi
            if [ -f "$checkout/KERNEL_CHANGE" ]; then
              printf 'changed-%s\\n' "$rev" > "$work/kernel-src"
            else
              printf 'same\\n' > "$work/kernel-src"
            fi
            ln -sf "$work/kernel-src" "$work/kernel"
            ln -sf "$work/kernel-src" "$work/initrd"
            ln -sf "$work/kernel-src" "$work/kernel-modules"
            printf '%s\\n' "$rev" > "$work/commit"
            cat > "$work/bin/switch-to-configuration" <<'EOF'
            #!/bin/bash
            printf '%s\\n' "$1" >> {self.log}
            EOF
            chmod +x "$work/bin/switch-to-configuration"
            if [ -f "$checkout/FAIL_ACTIVATION" ]; then
              printf 'exit 7\\n' >> "$work/bin/switch-to-configuration"
            fi
            printf '%s\\n' "$work"
            """)
        write_executable(self.bin / "nix-env", f"""\
            #!/bin/bash
            set -euo pipefail
            prev=""
            profile=""
            target=""
            for arg in "$@"; do
              if [ "$prev" = "-p" ]; then profile=$arg; fi
              if [ "$prev" = "--set" ]; then target=$arg; fi
              prev=$arg
            done
            mkdir -p "$(dirname "$profile")"
            ln -sfn "$target" "$profile"
            """)
        write_executable(self.bin / "systemctl", f"""\
            #!/bin/bash
            if [ "$1" = reboot ]; then printf '%s\\n' reboot >> {self.log}; fi
            exit 0
            """)
        write_executable(self.bin / "drain", f"""\
            #!/bin/bash
            printf '%s\\n' drain >> {self.log}
            if [ -f {self.root}/fail-drain ]; then exit 1; fi
            """)
        write_executable(self.bin / "sleep", f"""\
            #!/bin/bash
            printf '%s\\n' sleep >> {self.log}
            exit 0
            """)
        write_executable(self.bin / "resume", f"#!/bin/bash\nprintf '%s\\n' resume >> {self.log}\n")
        write_executable(self.bin / "cattle", """\
            import os,sys
            if sys.argv[1:] == ['print-id'] and not os.environ.get('FAIL_ID'):
                print('abcd')
            else:
                sys.exit(1)
            """)
        write_executable(self.bin / "health", f"""\
            #!/bin/bash
            if [ -f {self.root}/fail-health ]; then
              echo 'github unreachable' >&2
              exit 1
            fi
            exit 0
            """)
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.bin}:{self.env.get('PATH', '')}"
        self.env.update({
            "SYNC_ENV": str(self.root / "sync.env"),
            "STATE_DIR": str(self.state),
            "FLEET_NIX": str(self.bin / "nix"),
            "FLEET_NIX_ENV": str(self.bin / "nix-env"),
            "FLEET_SYSTEMCTL": str(self.bin / "systemctl"),
            "FLEET_GIT": "git",
            "FLEET_PROFILE": str(self.profile),
            "BOOTED_SYSTEM": str(self.booted),
            "PYTHON": sys.executable,
            "CATTLE_PY": str(self.bin / "cattle"),
            "FLEET_ROLES_PY": str(FLEET_ROLES),
            "FLEET_HEALTH": str(self.bin / "health"),
            "FLEET_REPORT": str(self.root / "health-failure"),
            "FLEET_REBOOT_PENDING": str(self.root / "reboot-pending"),
            # The real reader, pointed at a file the test writes (absent by default).
            "FLEETCONF": str(self.bin / "fleetconf"),
            "FLEET_CONFIG": str(self.root / "applied-config.json"),
            "FAIL_ID": "",
        })
        write_executable(self.bin / "fleetconf", f"""\
            #!/bin/bash
            exec {shlex.quote(sys.executable)} -I {shlex.quote(str(FLEETCONF))} "$@"
            """)
        self.write_env(cache="https://cache.invalid/fleet", delay="0")

    def tearDown(self):
        self.tmp.cleanup()

    def write_env(self, cache, delay, url=None, branch="main"):
        repo = url if url is not None else f"file://{self.origin}"
        text = "\n".join([
            "ROLE=ci",
            "FLAKE_ATTR=ci",
            f"BRANCH={branch}",
            f"REPO_URL={repo}",
            "FLAKE_DIR=packages/fleet",
            f"DELAY_MAX={delay}",
            f"DRAIN_COMMAND={self.bin}/drain",
            f"RESUME_COMMAND={self.bin}/resume",
            "DRAIN_TIMEOUT=5",
            f"CACHE_URL={cache}",
            "GIT_KEY=",
            "GIT_TOKEN=",
            "",
        ])
        (self.root / "sync.env").write_text(text)

    def commit(self, name, body="marker"):
        (self.flake / name).write_text(body)
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", name])

    def run_sync(self):
        return subprocess.run(
            ["bash", str(SCRIPT)],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def actions(self):
        if not self.log.exists():
            return []
        return [line for line in self.log.read_text().splitlines() if line]

    def test_unconfigured_repository_does_not_switch(self):
        self.write_env(cache="https://cache.invalid/fleet", delay="0", url="https://github.com/TODO/workspace.git")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.profile.exists())
        self.assertFalse(self.nix_log.exists())

    def commit_registry(self, change):
        registry = json.loads(REGISTRY.read_text())
        change(registry)
        self.commit("roles.json", json.dumps(registry))

    def test_registry_with_this_role_switches(self):
        self.commit_registry(lambda registry: None)
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["switch"])

    def test_retired_role_reports_the_registry_and_never_builds(self):
        def retire_ci(registry):
            ci = next(role for role in registry["roles"] if role["name"] == "ci")
            for key in ("settings", "secrets", "closures"):
                del ci[key]
            ci["state"] = "retired"
            registry["installerDefault"] = "devbox"
        self.commit_registry(retire_ci)
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FLEET_ROLE_RETIRED: roles.json retired role ci", result.stderr)
        self.assertFalse(self.nix_log.exists())
        self.assertFalse(self.profile.exists())
        report = (self.root / "health-failure").read_text()
        self.assertTrue(report.startswith("mode=sync\nFLEET_ROLE_RETIRED:"), report)

    def test_removed_closure_reports_the_registry_and_never_builds(self):
        self.write_env(cache="https://cache.invalid/fleet", delay="0")
        (self.root / "sync.env").write_text((self.root / "sync.env").read_text().replace("FLAKE_ATTR=ci", "FLAKE_ATTR=ci-retired"))
        self.commit_registry(lambda registry: None)
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FLEET_CLOSURE_REMOVED: roles.json no longer builds ci-retired", result.stderr)
        self.assertFalse(self.nix_log.exists())

    def test_unreadable_registry_stops_before_building(self):
        self.commit("roles.json", "{not json")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("roles.json: not JSON", result.stderr)
        self.assertFalse(self.nix_log.exists())

    def test_local_build_without_private_cache_switches(self):
        self.commit("marker")
        self.write_env(cache="", delay="0")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.profile.exists())
        self.assertIn("--max-jobs 2 --cores 2", self.nix_log.read_text())

    def test_failed_local_build_does_not_switch(self):
        self.commit("NOT_IN_CACHE", "")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("local system build failed", result.stderr)
        self.assertIn("--max-jobs 2 --cores 2", self.nix_log.read_text())
        self.assertFalse(self.profile.exists())
        self.assertEqual(self.actions(), [])

    def test_cache_hit_switches_to_main(self):
        self.commit("marker")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        applied = (self.profile.resolve() / "commit").read_text().strip()
        expected = self._git(["-C", str(self.origin), "rev-parse", "HEAD"]).stdout.strip()
        self.assertEqual(applied, expected)
        self.assertEqual(self.actions(), ["switch"])
        args = self.nix_log.read_text()
        self.assertIn("git+file://", args)
        self.assertIn("rev=" + expected, args)
        self.assertIn("&dir=packages/fleet#", args)

    def test_same_revision_does_not_switch_services_twice(self):
        self.commit("marker")
        self.assertEqual(self.run_sync().returncode, 0)
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["switch"])
        self.assertIn("already running revision", result.stdout)

    def test_failed_reboot_request_rolls_back_and_resumes_runners(self):
        self.commit("good")
        self.assertEqual(self.run_sync().returncode, 0)
        previous = self.profile.resolve()
        self.seed_booted()
        self.commit("KERNEL_CHANGE", "1")
        write_executable(self.bin / "systemctl", "#!/bin/bash\nif [ \"$1\" = reboot ]; then exit 1; fi\nexit 0\n")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.profile.resolve(), previous)
        self.assertEqual(self.actions()[-1], "resume")
        self.assertFalse((self.root / 'update-draining').exists())
        self.assertTrue((self.root / 'agent-drained').exists())
        self.assertIn("reboot request failed", (self.root / "health-failure").read_text())

    def test_activation_errors_restore_the_previous_generation_before_any_health_probe(self):
        self.commit('good')
        self.assertEqual(self.run_sync().returncode, 0)
        previous = self.profile.resolve()
        self.commit('FAIL_ACTIVATION')
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.profile.resolve(), previous)
        report = (self.root / 'health-failure').read_text()
        self.assertIn('mode=switch', report)
        self.assertIn('FLEET_ACTIVATION_FAILED', report)

    def test_failed_rollback_is_reported_as_failure_instead_of_a_successful_rollback(self):
        self.commit('good')
        self.assertEqual(self.run_sync().returncode, 0)
        previous = self.profile.resolve()
        with (previous / 'bin/switch-to-configuration').open('a') as stream:
            stream.write('exit 9\n')
        self.commit('FAIL_ACTIVATION')
        self.assertNotEqual(self.run_sync().returncode, 0)
        self.assertIn('mode=rollback-failed', (self.root / 'health-failure').read_text())
        self.assertIn('FLEET_ROLLBACK_FAILED', (self.root / 'health-failure').read_text())

    def test_local_build_generation_uses_upstream_health_without_private_cache_verification(self):
        self.commit('bootstrap.json', json.dumps({'updateMode': 'local', 'cacheUrl': None, 'cachePublicKey': None}))
        self.env.pop('FLEET_HEALTH')
        self.env['PYTHON'] = sys.executable
        curl_log = self.root / 'curl-args'
        write_executable(self.bin / 'curl', f'#!/bin/sh\nprintf "%s\\n" "$*" >> {curl_log}\nexit 0\n')
        self.env['FLEET_CURL'] = str(self.bin / 'curl')
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('https://cache.nixos.org/nix-cache-info', curl_log.read_text())
        self.assertNotIn('cache.invalid', curl_log.read_text())
        self.assertNotIn('store verify', self.nix_log.read_text())

    def test_new_generation_must_verify_its_own_cache_url_and_signing_key_or_roll_back(self):
        self.commit('good')
        self.assertEqual(self.run_sync().returncode, 0)
        previous = self.profile.resolve()
        key = 'new-cache:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
        self.commit('bootstrap.json', json.dumps({'cacheUrl': 'https://new-cache.invalid/fleet', 'cachePublicKey': key}))
        self.env.pop('FLEET_HEALTH')
        self.env['PYTHON'] = sys.executable
        write_executable(self.bin / 'curl', '#!/bin/sh\nexit 0\n')
        self.env['FLEET_CURL'] = str(self.bin / 'curl')
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.profile.resolve(), previous)
        command = next(line for line in self.nix_log.read_text().splitlines() if line.startswith('store verify'))
        self.assertIn('--store https://new-cache.invalid/fleet', command)
        self.assertIn('--no-contents', command)
        self.assertIn('--option trusted-public-keys ' + key, command)

    def test_failed_drain_does_not_reboot(self):
        self.commit("marker")
        self.seed_booted()
        (self.flake / "KERNEL_CHANGE").write_text("1")
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", "kernel"])
        (self.root / "fail-drain").write_text("1")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.actions(), ["drain", "resume"])
        self.assertFalse(any(line == "boot" for line in self.actions()))

    def test_reboot_drains_then_waits(self):
        self.commit("marker")
        self.seed_booted()
        (self.flake / "KERNEL_CHANGE").write_text("1")
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", "kernel"])
        self.write_env(cache="https://cache.invalid/fleet", delay="30")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["sleep", "drain", "boot", "reboot"])

    def test_follow_up_commit_switches(self):
        self.commit("first")
        first = self.run_sync()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.commit("second")
        second = self.run_sync()
        self.assertEqual(second.returncode, 0, second.stderr)
        applied = (self.profile.resolve() / "commit").read_text().strip()
        expected = self._git(["-C", str(self.origin), "rev-parse", "HEAD"]).stdout.strip()
        self.assertEqual(applied, expected)
        self.assertEqual(self.actions(), ["switch", "switch"])
        self.assertFalse((self.root / "health-failure").exists())

    def test_health_failure_restores_the_previous_generation(self):
        self.commit("good")
        good = self.run_sync()
        self.assertEqual(good.returncode, 0, good.stderr)
        kept = self.profile.resolve()
        (self.root / "fail-health").write_text("1")
        self.commit("bad")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rolling back", result.stderr)
        self.assertEqual(self.profile.resolve(), kept)
        self.assertNotIn("reboot", self.actions())
        report = (self.root / "health-failure").read_text()
        self.assertIn("github unreachable", report)
        self.assertIn("mode=switch", report)

    def test_reboot_health_failure_does_not_reboot(self):
        self.commit("good")
        good = self.run_sync()
        self.assertEqual(good.returncode, 0, good.stderr)
        kept = self.profile.resolve()
        self.booted.mkdir()
        for name in ("kernel", "initrd", "kernel-modules"):
            (self.booted / name).symlink_to(kept / name)
        self.log.write_text("")
        (self.flake / "KERNEL_CHANGE").write_text("1")
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", "kernel"])
        (self.root / "fail-health").write_text("1")
        self.write_env(cache="https://cache.invalid/fleet", delay="30")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rolling back", result.stderr)
        self.assertEqual(self.profile.resolve(), kept)
        self.assertNotIn("reboot", self.actions())
        self.assertEqual(self.actions().count("boot"), 2)
        self.assertIn("drain", self.actions())
        self.assertEqual(self.actions()[-1], "resume")

    def test_health_failure_without_a_previous_generation_exits(self):
        self.commit("only")
        (self.root / "fail-health").write_text("1")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no previous generation", result.stderr)
        self.assertIn("github unreachable", (self.root / "health-failure").read_text())

    def test_default_probe_rolls_back_when_github_is_down(self):
        self.commit("good")
        good = self.run_sync()
        self.assertEqual(good.returncode, 0, good.stderr)
        kept = self.profile.resolve()
        del self.env["FLEET_HEALTH"]
        write_executable(self.bin / "curl", f"""\
            #!/bin/bash
            url=""
            for arg in "$@"; do url=$arg; done
            printf '%s\\n' "$url" >> {self.root}/curl-urls
            echo 'connection refused' >&2
            exit 1
            """)
        write_executable(self.bin / "systemctl", f"""\
            #!/bin/bash
            if [ "$1" = cat ]; then exit 0; fi
            if [ "$1" = is-failed ]; then
              echo inactive
              exit 1
            fi
            if [ "$1" = reboot ]; then printf '%s\\n' reboot >> {self.log}; fi
            exit 0
            """)
        self.env["FLEET_CURL"] = str(self.bin / "curl")
        self.commit("bad")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.profile.resolve(), kept)
        urls = (self.root / "curl-urls").read_text()
        self.assertIn("https://github.com", urls)
        self.assertNotIn("reboot", self.actions())

    def test_default_probe_fails_when_the_sync_timer_is_failed(self):
        self.commit("good")
        good = self.run_sync()
        self.assertEqual(good.returncode, 0, good.stderr)
        kept = self.profile.resolve()
        del self.env["FLEET_HEALTH"]
        write_executable(self.bin / "curl", """\
            #!/bin/bash
            exit 0
            """)
        write_executable(self.bin / "systemctl", f"""\
            #!/bin/bash
            if [ "$1" = cat ]; then exit 0; fi
            if [ "$1" = is-active ]; then
              exit 3
            fi
            if [ "$1" = reboot ]; then printf '%s\\n' reboot >> {self.log}; fi
            exit 0
            """)
        self.env["FLEET_CURL"] = str(self.bin / "curl")
        self.commit("bad")
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fleet-sync.timer is not active", result.stderr)
        self.assertEqual(self.profile.resolve(), kept)

    def test_missing_id_does_not_drain(self):
        self.commit("marker")
        self.seed_booted()
        (self.flake / "KERNEL_CHANGE").write_text("1")
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", "kernel"])
        self.write_env(cache="https://cache.invalid/fleet", delay="30")
        self.env["FAIL_ID"] = "1"
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not rebooting", result.stderr)
        self.assertEqual(self.actions(), [])

    def configure(self, document):
        text = document if isinstance(document, str) else json.dumps(document)
        (self.root / "applied-config.json").write_text(text)

    def kernel_change(self, delay="30"):
        self.commit("marker")
        self.seed_booted()
        (self.flake / "KERNEL_CHANGE").write_text("1")
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", "kernel"])
        self.write_env(cache="https://cache.invalid/fleet", delay=delay)

    def test_a_paused_fleet_does_not_fetch_build_or_switch(self):
        self.commit("marker")
        self.configure({"sync": {"paused": True}})
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("paused by the fleet configuration", result.stderr)
        self.assertFalse(self.profile.exists())
        self.assertFalse(self.nix_log.exists())
        self.assertFalse((self.state / "repo").exists())
        self.assertEqual(self.actions(), [])
        self.configure({"sync": {"paused": False}})
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.actions(), ["switch"])

    def test_missing_corrupt_or_failing_settings_leave_sync_working(self):
        self.commit("marker")
        for content in ("{not json", "[]", '{"sync": {"paused": "yes"}}', '{"sync": 5}'):
            with self.subTest(content=content):
                self.configure(content)
                result = self.run_sync()
                self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["switch"])
        write_executable(self.bin / "broken-fleetconf", """\
            #!/bin/bash
            echo 'boom' >&2
            exit 3
            """)
        self.env["FLEETCONF"] = str(self.bin / "broken-fleetconf")
        self.env.pop("FLEET_CONFIG")
        self.log.write_text("")
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.actions(), [])
        del self.env["FLEETCONF"]
        self.assertEqual(self.run_sync().returncode, 0)

    def test_disabled_reboots_switch_without_draining_or_rebooting_and_record_it(self):
        self.kernel_change()
        self.configure({"reboot": {"enabled": False}})
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["switch"])
        self.assertIn("reboot is pending", result.stderr)
        pending = (self.root / "reboot-pending").read_text()
        self.assertTrue(pending.startswith("toplevel="), pending)
        self.assertEqual(os.path.realpath(pending.strip().split("=", 1)[1]), os.path.realpath(self.profile))
        # Enabling reboots again drains, waits and reboots on the next poll.
        self.configure({"reboot": {"enabled": True}})
        self.log.write_text("")
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.actions(), ["sleep", "drain", "boot", "reboot"])

    def test_a_sync_with_no_kernel_change_clears_the_pending_marker(self):
        self.commit("marker")
        (self.root / "reboot-pending").write_text("toplevel=/old\n")
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertFalse((self.root / "reboot-pending").exists())

    def test_a_failed_health_check_still_rolls_back_when_reboots_are_disabled(self):
        self.commit("good")
        self.assertEqual(self.run_sync().returncode, 0)
        kept = self.profile.resolve()
        self.booted.mkdir()
        for name in ("kernel", "initrd", "kernel-modules"):
            (self.booted / name).symlink_to(kept / name)
        (self.flake / "KERNEL_CHANGE").write_text("1")
        self._git(["-C", str(self.origin), "add", "packages"])
        self._git(["-C", str(self.origin), "commit", "-m", "kernel"])
        (self.root / "fail-health").write_text("1")
        self.configure({"reboot": {"enabled": False}})
        result = self.run_sync()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rolling back", result.stderr)
        self.assertEqual(self.profile.resolve(), kept)
        self.assertFalse((self.root / "reboot-pending").exists())

    def test_the_reboot_delay_can_be_changed_or_removed(self):
        self.kernel_change(delay="30")
        self.configure({"reboot": {"delayMaxSeconds": 0}})
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.actions(), ["drain", "boot", "reboot"])
        self.log.write_text("")
        self.write_env(cache="https://cache.invalid/fleet", delay="0")
        self.configure({"reboot": {"delayMaxSeconds": 45}})
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.actions(), ["sleep", "drain", "boot", "reboot"])

    def booted_switch(self, body):
        (self.booted / "bin").mkdir(exist_ok=True)
        write_executable(self.booted / "bin" / "switch-to-configuration", body)

    def boot(self, identity):
        boot_file = self.root / "boot_id"
        boot_file.write_text(identity + "\n")
        self.env["FLEET_BOOT_ID_FILE"] = str(boot_file)

    def test_a_kernel_that_falls_back_is_quarantined_instead_of_rebooting_forever(self):
        # Before: the next run saw the old kernel, installed the same kernel again
        # and drained and rebooted into it on every poll.
        self.kernel_change(delay="0")
        self.booted_switch(f"#!/bin/bash\nprintf 'booted-%s\\n' \"$1\" >> {self.log}\n")
        self.env["RECOVERY_PY"] = str(SCRIPT.with_name("recovery.py"))
        self.env["FLEET_RECOVERY_STATE"] = str(self.root / "recovery")
        self.boot("boot-a")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions()[-3:], ["drain", "boot", "reboot"])
        self.assertIn("boot_id=boot-a", (self.state / "pending-boot").read_text())
        # systemd-boot ran out of tries and fell back: the booted system is the old one.
        self.boot("boot-b")
        self.log.write_text("")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["booted-boot", "switch"], "the working system is the default again; no drain, no reboot")
        self.assertFalse((self.state / "pending-boot").exists())
        quarantine = json.loads((self.state / "quarantine.json").read_text())
        self.assertIn("not certain", quarantine["reason"])
        self.assertIn("reason=quarantined", (self.root / "reboot-pending").read_text())
        events = [json.loads(p.read_text()) for p in (self.root / "recovery" / "outbox").glob("*.json")]
        self.assertEqual([event["kind"] for event in events], ["update-quarantined"])
        # Later polls keep the node working on the old kernel without rebooting.
        self.log.write_text("")
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertNotIn("reboot", self.actions())
        # A person presses Retry the update: the next poll reboots into it again.
        self.configure({"sync": {"retryBootAfter": quarantine["atEpoch"] + 1}})
        self.log.write_text("")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions()[-3:], ["drain", "boot", "reboot"])
        self.assertFalse((self.state / "quarantine.json").exists())

    def test_a_new_kernel_lifts_the_quarantine(self):
        self.kernel_change(delay="0")
        self.booted_switch("#!/bin/bash\nexit 0\n")
        self.boot("boot-a")
        self.run_sync()
        self.boot("boot-b")
        self.run_sync()
        self.assertTrue((self.state / "quarantine.json").exists())
        (self.flake / "KERNEL_CHANGE").write_text("2")
        self._git(["-C", str(self.origin), "commit", "-am", "another kernel"])
        self.log.write_text("")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions()[-3:], ["drain", "boot", "reboot"])
        self.assertFalse((self.state / "quarantine.json").exists())

    def test_a_reboot_that_comes_up_is_not_quarantined(self):
        self.kernel_change(delay="0")
        self.boot("boot-a")
        self.run_sync()
        pending = (self.state / "pending-boot").read_text()
        toplevel = next(line.split("=", 1)[1] for line in pending.splitlines() if line.startswith("toplevel="))
        self.booted.rename(self.root / "old-booted")
        self.booted.symlink_to(toplevel)
        self.boot("boot-b")
        self.log.write_text("")
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.state / "quarantine.json").exists())
        self.assertTrue((self.state / "pending-boot").exists(), "boot-health clears it once the boot is blessed")

    def seed_booted(self):
        kernel = self.root / "old-kernel"
        kernel.write_text("same")
        self.booted.mkdir()
        for name in ("kernel", "initrd", "kernel-modules"):
            (self.booted / name).symlink_to(kernel)

    def _git(self, args):
        return subprocess.run(["git", *args], check=True, text=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
