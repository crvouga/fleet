#!/usr/bin/env python3
"""fleet-install runs on the machine. It does not read a work-computer key."""

import base64
import os
import pty
import secrets
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fleet-install.sh"


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class InstallTests(unittest.TestCase):
    def test_integration_failure_never_selects_or_erases_a_disk_and_keeps_a_copyable_code(self):
        for status in (2, 75):
            write_executable(self.bin / 'fleet-bootstrap-ready', f'#!/bin/bash\necho "FLEET_TEST_NOT_READY: fixture integration failure" >&2\nexit {status}\n')
            result = subprocess.run([str(SCRIPT), 'ci'], capture_output=True, text=True,
                env={**self.env, 'FLEET_AUTO': '1'})
            self.assertEqual(result.returncode, status, result.stderr)
            self.assertIn('FLEET_TEST_NOT_READY', result.stderr)
            self.assertFalse(self.log.exists())
            self.assertIn('FLEET_TEST_NOT_READY', Path(self.env['FLEET_INSTALL_LOG'] + '.diagnostic').read_text())

    def test_failed_wifi_readiness_stops_before_disk_or_secret_operations(self):
        write_executable(self.bin / "fleet-wifi-ready", "#!/bin/bash\nexit 2\n")
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env={**self.env, "FLEET_AUTO": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())

    def test_wifi_is_checked_before_wiping_and_persisted_after_partitioning(self):
        write_executable(self.bin / "fleet-wifi-ready", f"#!/bin/bash\nprintf 'wifi-ready\\n' >> '{self.log}'\n")
        write_executable(self.bin / "fleet-wifi-persist", f"#!/bin/bash\nprintf 'wifi-persist %s\\n' \"$1\" >> '{self.log}'\n")
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env={**self.env, "FLEET_AUTO": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        actions = self.log.read_text()
        self.assertLess(actions.index("wifi-ready"), actions.index("disko "))
        self.assertGreater(actions.index("wifi-persist"), actions.index("disko "))
        self.assertIn("wifi-persist " + str(self.mnt), actions)

    def devbox_env(self, key=None):
        self.manifest.write_text(f"devbox {self.system}\ndisko {self.disko}\n")
        env = self.env.copy()
        env["FLEET_AUTO"] = "1"
        env["FLEET_CMDLINE"] = str(self.root / "empty-cmdline")
        (self.root / "empty-cmdline").write_text("")
        if key is not None:
            path = self.root / "devbox.pub"
            path.write_text(key)
            env["FLEET_DEVBOX_SSH_KEY_FILE"] = str(path)
        return env

    def test_devbox_without_ssh_access_refuses_before_wiping(self):
        env = self.devbox_env(key="not a public key")
        result = subprocess.run([str(SCRIPT), "devbox"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Nothing was wiped", result.stderr)
        self.assertFalse(self.log.exists() and "disko " in self.log.read_text())

    def test_devbox_key_is_validated_before_wipe_and_persisted(self):
        key = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32).decode()
        env = self.devbox_env(key=key + " workstation\n")
        result = subprocess.run([str(SCRIPT), "devbox"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        actions = self.log.read_text()
        self.assertLess(actions.index("ssh-keygen -lf"), actions.index("disko "))
        self.assertEqual((self.mnt / "nix/fleet-state/devbox/authorized_keys").read_text(), key + "\n")

    def test_devbox_accepts_the_public_key_carried_through_kexec(self):
        key = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32).decode()
        env = self.devbox_env()
        Path(env["FLEET_CMDLINE"]).write_text("fleet.ssh=" + base64.urlsafe_b64encode(key.encode()).decode())
        result = subprocess.run([str(SCRIPT), "devbox"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.mnt / "nix/fleet-state/devbox/authorized_keys").read_text(), key + "\n")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "actions"
        self.mnt = self.root / "mnt"
        self.recorded = self.root / "recorded"
        self.system = self.root / "systems" / "ci"
        self.system.mkdir(parents=True)
        self.disko = self.root / "disko"
        write_executable(self.disko, f"""\
            #!/bin/bash
            printf 'disko %s\\n' "$(cat {self.recorded})" >> {self.log}
            mkdir -p {self.mnt}/nix/fleet-state
            """)
        write_executable(self.bin / "select-disk", f"""\
            #!/bin/bash
            printf 'select\\n' >> {self.log}
            cat {self.root}/disk
            """)
        write_executable(self.bin / "age-keygen", f"""\
            #!/bin/bash
            printf 'age %s\\n' "$*" >> {self.log}
            if [ "$1" = "-y" ]; then
              echo age1publicstub
              exit 0
            fi
            printf 'AGE-SECRET-KEY-STUB\\n' > "$2"
            """)
        write_executable(self.bin / "ssh-keygen", f"""\
            #!/bin/bash
            printf 'ssh-keygen %s\\n' "$*" >> {self.log}
            if [ "$1" = "-lf" ]; then
              echo "256 SHA256:stub $2"
              exit 0
            fi
            prev=""
            file=""
            for arg in "$@"; do
              if [ "$prev" = "-f" ]; then file=$arg; fi
              prev=$arg
            done
            printf 'priv\\n' > "$file"
            printf 'pub\\n' > "$file.pub"
            """)
        write_executable(self.bin / "nixos-install", f"""\
            #!/bin/bash
            printf 'install %s\\n' "$*" >> {self.log}
            """)
        (self.root / "disk").write_text("/dev/disk/by-path/pci-0000:01:00.0-nvme-1\n")
        manifest = self.root / "manifest"
        manifest.write_text(f"ci {self.system}\ndisko {self.disko}\n")
        self.manifest = manifest
        self.env = os.environ.copy()
        self.env.update({
            "PATH": f"{self.bin}:{os.environ.get('PATH', '')}",
            "FLEET_ALLOW_UNPRIVILEGED": "1",
            "FLEET_MANIFEST": str(manifest),
            "FLEET_MNT": str(self.mnt),
            "FLEET_RECORDED": str(self.recorded),
            "FLEET_INSTALL_LOG": str(self.root / "install.log"),
            "FLEET_SELECT_DISK": str(self.bin / "select-disk"),
            "FLEET_AGE_KEYGEN": str(self.bin / "age-keygen"),
            "FLEET_SSH_KEYGEN": str(self.bin / "ssh-keygen"),
            "FLEET_NIXOS_INSTALL": str(self.bin / "nixos-install"),
        })
        self.env.pop("FLEET_KEY_DIR", None)

    def tearDown(self):
        self.tmp.cleanup()

    def run_tty(self, args, typed, env=None):
        master, slave = pty.openpty()
        proc = subprocess.Popen(
            [str(SCRIPT), *args],
            stdin=slave,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env or self.env,
        )
        os.close(slave)
        os.write(master, typed.encode())
        try:
            out, err = proc.communicate(timeout=15)
        finally:
            os.close(master)
        return proc.returncode, out.decode(), err.decode()

    def test_missing_manifest_does_not_touch_a_disk(self):
        env = self.env.copy()
        env["FLEET_MANIFEST"] = str(self.root / "missing")
        result = subprocess.run(
            [str(SCRIPT), "ci"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("USB image", result.stderr)
        self.assertFalse(self.log.exists())

    def test_gpu_role_is_not_on_the_image(self):
        result = subprocess.run(
            [str(SCRIPT), "ci-gpu"],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())

    def test_auto_wipes_without_typing_the_path(self):
        env = self.env.copy()
        env["FLEET_AUTO"] = "1"
        result = subprocess.run(
            [str(SCRIPT), "ci"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        disk = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"disko {disk}", self.log.read_text())
        self.assertIn("Wiping that disk", result.stderr)
        self.assertNotIn("AGE-SECRET-KEY-STUB", result.stderr)

    def test_cmdline_role_uses_the_last_value(self):
        cmdline = self.root / "cmdline"
        cmdline.write_text("root=LABEL=nixos fleet.role=ci fleet.role=devbox\n")
        devbox = self.root / "systems" / "devbox"
        devbox.mkdir()
        key = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32).decode()
        env = self.devbox_env(key=key + "\n")
        self.manifest.write_text(
            f"ci {self.system}\ndevbox {devbox}\ndisko {self.disko}\n"
        )
        env["FLEET_CMDLINE"] = str(cmdline)
        result = subprocess.run(
            [str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"install --no-root-passwd --root {self.mnt} --system {devbox}", self.log.read_text())
        self.assertIn("Role: devbox", result.stderr)

    def test_non_tty_refuses_before_disko(self):
        result = subprocess.run(
            [str(SCRIPT), "ci"],
            input="/dev/disk/by-path/pci-0000:01:00.0-nvme-1\n",
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("without a terminal", result.stderr)
        self.assertFalse(self.log.exists() and "disko " in self.log.read_text())

    def test_wrong_path_does_not_wipe(self):
        code, _out, err = self.run_tty(["ci"], "nope\n")
        self.assertEqual(code, 1)
        self.assertIn("did not match", err)
        self.assertNotIn("disko ", self.log.read_text())

    def test_install_generates_a_key_and_does_not_print_it(self):
        disk = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
        code, _out, err = self.run_tty(["ci"], disk + "\n")
        self.assertEqual(code, 0, err)
        actions = self.log.read_text()
        self.assertIn(f"disko {disk}", actions)
        self.assertIn(f"install --no-root-passwd --root {self.mnt} --system {self.system}", actions)
        secret = (self.mnt / "nix/fleet-state/secrets/age.key").read_text()
        self.assertEqual(secret, "AGE-SECRET-KEY-STUB\n")
        self.assertEqual((self.mnt / "nix/fleet-state/secrets/age.pub").read_text(), "age1publicstub\n")
        self.assertIn("age1publicstub", err)
        self.assertNotIn("AGE-SECRET-KEY-STUB", err)
        self.assertTrue((self.mnt / "nix/fleet-state/ssh/ssh_host_ed25519_key").is_file())
        self.assertIn("Remove the USB", err)

    def test_existing_stick_key_is_reused(self):
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "ci.age").write_text("FROM-STICK\n")
        env = self.env.copy()
        env["FLEET_KEY_DIR"] = str(stick)
        disk = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
        code, _out, err = self.run_tty(["ci"], disk + "\n", env)
        self.assertEqual(code, 0, err)
        self.assertEqual((self.mnt / "nix/fleet-state/secrets/age.key").read_text(), "FROM-STICK\n")
        self.assertNotIn("age -o", self.log.read_text())

    def test_new_key_is_copied_to_an_empty_stick(self):
        stick = self.root / "stick"
        stick.mkdir()
        env = self.env.copy()
        env["FLEET_KEY_DIR"] = str(stick)
        disk = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
        code, _out, err = self.run_tty(["ci"], disk + "\n", env)
        self.assertEqual(code, 0, err)
        self.assertEqual((stick / "ci.age").read_text(), "AGE-SECRET-KEY-STUB\n")
        self.assertNotIn("AGE-SECRET-KEY-STUB", err)

    def enroll_env(self, reply, fail=False):
        write_executable(self.bin / "curl", f"""\
            #!/bin/bash
            printf 'curl %s\\n' "$*" >> {self.log}
            hdr=""; out=""; prev=""
            for arg in "$@"; do
              if [ "$prev" = "-H" ]; then hdr=${{arg#@}}; fi
              if [ "$prev" = "-o" ]; then out=$arg; fi
              prev=$arg
            done
            cp "$hdr" {self.root}/seen-header
            [ -f {self.root}/curl-fail ] && exit 22
            printf '%s' '{reply}' > "$out"
            """)
        if fail:
            (self.root / "curl-fail").write_text("1")
        env = self.env.copy()
        env.update({
            "FLEET_AUTO": "1",
            "FLEET_CURL": str(self.bin / "curl"),
            "FLEET_ENROLLED_DIR": str(self.root / "enrolled"),
            "FLEET_CMDLINE": str(self.root / "cmdline"),
        })
        (self.root / "cmdline").write_text("quiet fleet.role=ci fleet.enroll=hvs.wrapped-token-1 fleet.vault=https://vault.example\n")
        return env

    def test_enrollment_token_supplies_the_role_key_before_the_wipe(self):
        env = self.enroll_env('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED"}}}')
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        actions = self.log.read_text()
        self.assertLess(actions.index("curl "), actions.index("disko "))
        self.assertIn("https://vault.example/v1/sys/wrapping/unwrap", actions)
        self.assertNotIn("hvs.wrapped-token-1", actions)
        self.assertIn("hvs.wrapped-token-1", (self.root / "seen-header").read_text())
        self.assertEqual((self.mnt / "nix/fleet-state/secrets/age.key").read_text(), "AGE-SECRET-KEY-ENROLLED\n")
        self.assertNotIn("age -o", actions)
        for text in (result.stdout, result.stderr):
            self.assertNotIn("AGE-SECRET-KEY-ENROLLED", text)
            self.assertNotIn("hvs.wrapped-token-1", text)

    def test_a_refused_token_leaves_the_disk_alone(self):
        env = self.enroll_env("{}", fail=True)
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("disko", self.log.read_text())
        self.assertIn("Nothing was wiped", result.stderr)
        self.assertNotIn("hvs.wrapped-token-1", result.stderr)

    def test_a_token_without_an_age_key_leaves_the_disk_alone(self):
        env = self.enroll_env('{"data":{"data":{"other":"x"}}}')
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("disko", self.log.read_text())

    def test_the_install_log_follows_the_node_and_holds_no_secret(self):
        disk = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
        code, _out, err = self.run_tty(["ci"], disk + "\n")
        self.assertEqual(code, 0, err)
        kept = self.mnt / "nix/fleet-state/logs/install.log"
        body = kept.read_text()
        self.assertEqual(oct(kept.stat().st_mode & 0o777), "0o600")
        self.assertRegex(body, r"(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ role=ci ")
        # Each step the live screens show is also in the log, in order.
        steps = [line.split(" step ", 1)[1] for line in body.splitlines() if " step " in line]
        self.assertEqual(steps, ["network", "approval", "checks", "disk", "erase", "install"])
        for step in ("partitioning with disko", "disko done", "nixos-install done", "installed role=ci"):
            self.assertIn(step, body)
        self.assertIn("age key: generated on this machine", body)
        self.assertNotIn("AGE-SECRET-KEY", body)

    def test_a_failed_step_is_loud_and_says_where(self):
        write_executable(self.bin / "nixos-install", f"""\
            #!/bin/bash
            echo 'no space left' >&2
            exit 7
            """)
        disk = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
        code, _out, err = self.run_tty(["ci"], disk + "\n")
        self.assertNotEqual(code, 0)
        self.assertIn("FLEET-FAIL fleet-install stopped at line", err)
        self.assertIn("(exit 7)", err)
        self.assertIn(f"Log: {self.root / 'install.log'}", err)
        body = (self.root / "install.log").read_text()
        self.assertIn("FAIL exit 7", body)
        self.assertNotIn("installed role=ci", body)

    def test_the_log_says_where_the_key_came_from_and_never_the_token(self):
        env = self.enroll_env('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED"}}}')
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        body = (self.root / "install.log").read_text()
        self.assertIn("age key: from the enrollment token", body)
        self.assertNotIn("hvs.wrapped-token-1", body)
        self.assertNotIn("AGE-SECRET-KEY-ENROLLED", body)

    def test_a_refused_token_is_in_the_log(self):
        env = self.enroll_env("{}", fail=True)
        subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertIn("nothing wiped", (self.root / "install.log").read_text())

    def test_a_retry_in_the_same_boot_reuses_the_unwrapped_key(self):
        env = self.enroll_env('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED"}}}')
        subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        (self.root / "curl-fail").write_text("1")
        again = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual((self.mnt / "nix/fleet-state/secrets/age.key").read_text(), "AGE-SECRET-KEY-ENROLLED\n")

    def run_enrolled(self, reply, fail_after=False):
        env = self.enroll_env(reply)
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        return env, result

    def agent_dir(self):
        return self.mnt / "nix/fleet-state/agent"

    def test_the_fleet_api_role_token_is_installed_privately_and_never_printed(self):
        token = secrets.token_hex(24)
        env, result = self.run_enrolled('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED","api_token":"' + token + '"}}}')
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.agent_dir() / "role-token"
        self.assertEqual(installed.read_text(), token + "\n")
        self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.agent_dir().stat().st_mode & 0o777, 0o700)
        self.assertEqual([path.name for path in self.agent_dir().iterdir()], ["role-token"])
        for text in (result.stdout, result.stderr, (self.root / "install.log").read_text(), self.log.read_text()):
            self.assertNotIn(token, text)
        self.assertIn("fleet API role token: installed", (self.root / "install.log").read_text())

    def test_a_token_document_without_api_token_installs_without_one(self):
        env, result = self.run_enrolled('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED"}}}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.agent_dir().exists())
        self.assertEqual((self.mnt / "nix/fleet-state/secrets/age.key").read_text(), "AGE-SECRET-KEY-ENROLLED\n")

    def test_the_api_token_may_sit_in_an_unversioned_document(self):
        token = "flat.token_value-123"
        env, result = self.run_enrolled('{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED","api_token":"' + token + '"}}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.agent_dir() / "role-token").read_text(), token + "\n")

    def test_an_unusable_api_token_is_dropped_and_the_install_still_succeeds(self):
        for index, bad in enumerate(("has space in it", "short", "x" * 513, "semi;colon-token", "new\\nline-token", "")):
            with self.subTest(token=bad):
                reply = '{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED","api_token":"' + bad + '"}}}'
                (self.root / "enrolled").mkdir(exist_ok=True)
                for leftover in (self.root / "enrolled").iterdir():
                    leftover.unlink()
                env, result = self.run_enrolled(reply)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((self.agent_dir() / "role-token").exists())

    def test_a_non_string_api_token_is_dropped(self):
        env, result = self.run_enrolled('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED","api_token":12345678}}}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.agent_dir() / "role-token").exists())

    def test_a_retry_in_the_same_boot_keeps_the_api_token(self):
        token = "ci-role-token-retry-1234"
        env, first = self.run_enrolled('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED","api_token":"' + token + '"}}}')
        self.assertEqual(first.returncode, 0, first.stderr)
        (self.agent_dir() / "role-token").unlink()
        (self.root / "curl-fail").write_text("1")
        again = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual((self.agent_dir() / "role-token").read_text(), token + "\n")

    def test_a_refused_enrollment_never_leaves_a_token_on_the_new_disk(self):
        env = self.enroll_env("{}", fail=True)
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.agent_dir().exists())

    def test_the_stick_key_wins_over_a_token(self):
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "ci.age").write_text("FROM-STICK\n")
        env = self.enroll_env('{"data":{"data":{"age_key":"AGE-SECRET-KEY-ENROLLED"}}}')
        env["FLEET_KEY_DIR"] = str(stick)
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("curl ", self.log.read_text())
        self.assertEqual((self.mnt / "nix/fleet-state/secrets/age.key").read_text(), "FROM-STICK\n")

    def test_identical_role_keys_are_refused(self):
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "ci.age").write_text("SAME\n")
        (stick / "devbox.age").write_text("SAME\n")
        env = self.env.copy()
        env["FLEET_KEY_DIR"] = str(stick)
        result = subprocess.run(
            [str(SCRIPT), "devbox"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("must differ", result.stderr)
        self.assertFalse(self.log.exists())

    def test_comment_changes_cannot_hide_a_shared_role_identity(self):
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "ci.age").write_text("# ci\nSAME-IDENTITY\n")
        (stick / "devbox.age").write_text("# devbox\nSAME-IDENTITY\n")
        env = dict(self.env, FLEET_KEY_DIR=str(stick), FLEET_AUTO="1")
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("same recipient", result.stderr)
        self.assertNotIn("disko", self.log.read_text())

    def reject_bad_age_keys(self):
        write_executable(self.bin / "age-keygen", """\
            #!/bin/bash
            if [ "$1" = -y ]; then
              grep -q CORRUPT "$2" && exit 1
              echo age1validstub
              exit 0
            fi
            exit 1
            """)

    def test_invalid_stick_identity_is_refused_before_partitioning(self):
        self.reject_bad_age_keys()
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "ci.age").write_text("AGE-SECRET-KEY-CORRUPT\n")
        env = dict(self.env, FLEET_KEY_DIR=str(stick), FLEET_AUTO="1")
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Nothing was wiped", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertNotIn("AGE-SECRET-KEY-CORRUPT", result.stdout + result.stderr)

    def test_invalid_enrolled_identity_can_be_replaced_without_wiping(self):
        self.reject_bad_age_keys()
        env = self.enroll_env('{"data":{"data":{"age_key":"AGE-SECRET-KEY-CORRUPT"}}}')
        result = subprocess.run([str(SCRIPT), "ci"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertNotIn("disko", self.log.read_text())
        self.assertFalse((Path(env["FLEET_ENROLLED_DIR"]) / "ci.age").exists())
        self.assertNotIn("AGE-SECRET-KEY-CORRUPT", result.stdout + result.stderr)

    def test_changed_disk_selection_aborts(self):
        write_executable(self.bin / "select-disk", f"""\
            #!/bin/bash
            n=0
            if [ -f {self.root}/selects ]; then n=$(cat {self.root}/selects); fi
            n=$((n + 1))
            printf '%s\\n' "$n" > {self.root}/selects
            if [ "$n" -eq 1 ]; then
              echo /dev/disk/by-path/pci-0000:01:00.0-nvme-1
            else
              echo /dev/disk/by-path/pci-0000:02:00.0-nvme-1
            fi
            """)
        result = subprocess.run(
            [str(SCRIPT), "ci"],
            capture_output=True,
            text=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Disk selection changed", result.stderr)
        self.assertFalse(self.log.exists())
