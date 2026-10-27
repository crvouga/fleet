#!/usr/bin/env python3
"""The live image installs itself. A boot with no payload does not wipe."""

import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fleet-auto.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class AutoInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.log = self.root / "install"
        self.install = self.root / "fleet-install"
        write_executable(self.install, f"""\
            #!/bin/bash
            printf 'auto=%s args=%s\\n' "$FLEET_AUTO" "$*" > {self.log}
            """)
        self.env = os.environ.copy()
        self.screens = self.root / "screens"
        self.live = self.root / "fleet-live"
        write_executable(self.live, f"""\
            #!/bin/sh
            # A tick draws nothing once an outcome is recorded; tests stub sleep, so ignore them.
            [ "$1" = tick ] && exit 0
            printf '%s\\n' "$*" >> {self.screens}
            """)
        self.env.update({
            "FLEET_ALLOW_UNPRIVILEGED": "1",
            "FLEET_SKIP_REBOOT": "1",
            "FLEET_INSTALL": str(self.install),
            "FLEET_LIVE": str(self.live),
            "FLEET_LIVE_STATE": str(self.root / "live"),
            "FLEET_AUTO_STATE": str(self.root / "started"),
            "FLEET_INSTALL_LOG": str(self.root / "installer.log"),
            "FLEET_CONSOLE_INPUT": os.devnull,
            "FLEET_RETRY_SECONDS": "0",
            "FLEET_TICK_SECONDS": "3600",
        })

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_manifest_does_not_install(self):
        env = self.env.copy()
        env["FLEET_MANIFEST"] = str(self.root / "missing")
        result = subprocess.run(
            [str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("disk was not changed", result.stderr)
        self.assertFalse(self.log.exists())

    def test_manifest_runs_install_and_does_not_reboot(self):
        manifest = self.root / "manifest"
        manifest.write_text("ci /system\n")
        env = self.env.copy()
        env["FLEET_MANIFEST"] = str(manifest)
        result = subprocess.run(
            [str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text(), "auto=1 args=\n")
        self.assertIn("pull the stick", result.stderr)

    def test_temporary_failures_retry_inside_one_run_and_show_why(self):
        # A systemd restart between attempts failed the start job and let getty
        # log in over the installer. Retries must stay inside this process.
        manifest = self.root / "manifest"
        manifest.write_text("ci /system\n")
        attempts = self.root / "attempts"
        write_executable(self.install, f"""\
            #!/bin/bash
            echo x >> {attempts}
            [ "$(wc -l < {attempts})" -ge 3 ] && exit 0
            echo 'Waiting for Wi-Fi with working DNS and TLS.' >&2
            exit 75
            """)
        env = {**self.env, "FLEET_MANIFEST": str(manifest)}
        result = subprocess.run([str(SCRIPT)], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(attempts.read_text().split()), 3)
        screens = self.screens.read_text().splitlines()
        self.assertEqual([line.split()[0] for line in screens], ["wait", "wait", "done"])
        self.assertIn("--attempt 2", screens[1])
        # Each attempt's output reaches the journal; attempt.log holds only the latest.
        self.assertEqual(result.stdout.count("Waiting for Wi-Fi"), 2)
        self.assertEqual((self.root / "live/attempt.log").read_text(), "")

    def test_pre_wipe_failure_returns_to_source_but_never_reboots_after_disk_work(self):
        manifest = self.root / "manifest"
        manifest.write_text("ci /system\n")
        cmdline = self.root / "cmdline"
        cmdline.write_text("fleet.enroll=test-only-public-reference\n")
        binaries = self.root / "bin"
        binaries.mkdir()
        reboots = self.root / "reboots"
        write_executable(binaries / "sleep", "#!/bin/sh\nexit 0\n")
        systemctl = binaries / "systemctl"
        write_executable(systemctl, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$FLEET_TEST_REBOOTS"\n')
        write_executable(self.install, "#!/bin/bash\nexit 2\n")
        env = {**self.env, "FLEET_SKIP_REBOOT": "0", "FLEET_MANIFEST": str(manifest),
               "FLEET_CMDLINE": str(cmdline), "FLEET_SYSTEMCTL": str(systemctl), "FLEET_DONE_SECONDS": "0",
               "FLEET_TEST_REBOOTS": str(reboots), "PATH": str(binaries) + os.pathsep + self.env['PATH']}
        for erasing in (False, True):
            if erasing:
                (self.root / "installer.log.erasing").touch()
                reboots.unlink()
            result = subprocess.run([str(SCRIPT)], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 2 if erasing else 0, result.stderr)
            self.assertEqual(reboots.exists(), not erasing)
            self.assertNotIn("Installed.", result.stderr)
            # The stop screen says whether it returns, and never offers to after erasing.
            self.assertIn("stopped --status 2 --returning " + ("0" if erasing else "120"), self.screens.read_text().splitlines()[-1])

    def test_enter_at_the_console_stays_instead_of_returning(self):
        manifest = self.root / "manifest"
        manifest.write_text("ci /system\n")
        cmdline = self.root / "cmdline"
        cmdline.write_text("copytoram fleet.from=windows fleet.role=ci\n")
        keys = self.root / "keys"
        keys.write_text("\n")
        reboots = self.root / "reboots"
        systemctl = self.root / "systemctl"
        write_executable(systemctl, f'#!/bin/sh\necho "$1" >> {reboots}\n')
        write_executable(self.install, "#!/bin/bash\nexit 2\n")
        env = {**self.env, "FLEET_SKIP_REBOOT": "0", "FLEET_MANIFEST": str(manifest), "FLEET_CMDLINE": str(cmdline),
               "FLEET_SYSTEMCTL": str(systemctl), "FLEET_CONSOLE_INPUT": str(keys), "FLEET_RETURN_SECONDS": "3"}
        result = subprocess.run([str(SCRIPT)], capture_output=True, text=True, env=env, check=False, timeout=30)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(reboots.exists())
        self.assertEqual(self.screens.read_text().splitlines()[-1], "stayed")

    def test_network_wait_has_a_deadline_before_disk_work(self):
        manifest = self.root / "manifest"
        manifest.write_text("ci /system\n")
        started = self.root / "started"
        started.write_text("0\n")
        cmdline = self.root / "cmdline"
        cmdline.write_text("")
        write_executable(self.install, "#!/bin/bash\nexit 75\n")
        result = subprocess.run([str(SCRIPT)], capture_output=True, text=True,
            env={**self.env, "FLEET_SKIP_REBOOT": "0", "FLEET_NETWORK_WAIT_SECONDS": "0",
                 "FLEET_MANIFEST": str(manifest), "FLEET_AUTO_STATE": str(started),
                 "FLEET_CMDLINE": str(cmdline)})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("FLEET_NETWORK_WAIT_EXPIRED", result.stderr)

    def test_temporary_exit_after_disk_work_cannot_restart_the_whole_install(self):
        manifest = self.root / 'manifest'
        manifest.write_text('ci /system\n')
        log = self.root / 'installer.log'
        log.with_suffix('.log.erasing').touch()
        write_executable(self.install, '#!/bin/bash\nexit 75\n')
        result = subprocess.run([str(SCRIPT)], capture_output=True, text=True,
            env={**self.env, 'FLEET_MANIFEST': str(manifest), 'FLEET_INSTALL_LOG': str(log)})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('FLEET_INSTALL_STOPPED', result.stderr)
