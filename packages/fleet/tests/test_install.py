#!/usr/bin/env python3
"""fleet-install runs on the machine and installs the role-less base system.
It takes no role, reads no work-computer key and never handles an age key."""

import json
import os
import pty
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "fleet-install.sh"
DISK = "/dev/disk/by-path/pci-0000:01:00.0-nvme-1"
TOKEN = "enroll.token_value-1234"
GIT_TOKEN = "github_pat_Fixture~Read+Token/Value=="
GIT_KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQy"
GIT_KEY = ("-----BEGIN OPENSSH PRIVATE KEY-----\n" + GIT_KEY_BODY + "\nNTUxOQAAACBGaXh0dXJlS2V5Rm9yVGVzdHNPbmx5\n"
           "-----END OPENSSH PRIVATE KEY-----\n")


def write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "actions"
        self.mnt = self.root / "mnt"
        self.recorded = self.root / "recorded"
        self.system = self.root / "systems" / "base"
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
        (self.root / "disk").write_text(DISK + "\n")
        self.manifest = self.root / "manifest"
        self.manifest.write_text(f"base {self.system}\ndisko {self.disko}\n")
        self.cmdline = self.root / "cmdline"
        self.cmdline.write_text("quiet\n")
        self.enrolled = self.root / "enrolled"
        self.env = os.environ.copy()
        for name in ("FLEET_KEY_DIR", "FLEET_ENROLL_TOKEN", "FLEET_AUTO", "FLEET_GIT_CREDENTIAL_FILE"):
            self.env.pop(name, None)
        self.env.update({
            "PATH": f"{self.bin}:{os.environ.get('PATH', '')}",
            "FLEET_ALLOW_UNPRIVILEGED": "1",
            "FLEET_MANIFEST": str(self.manifest),
            "FLEET_MNT": str(self.mnt),
            "FLEET_RECORDED": str(self.recorded),
            "FLEET_INSTALL_LOG": str(self.root / "install.log"),
            "FLEET_SELECT_DISK": str(self.bin / "select-disk"),
            "FLEET_SSH_KEYGEN": str(self.bin / "ssh-keygen"),
            "FLEET_NIXOS_INSTALL": str(self.bin / "nixos-install"),
            "FLEET_CMDLINE": str(self.cmdline),
            "FLEET_ENROLLED_DIR": str(self.enrolled),
            "FLEET_ENROLLMENT_HANDOFF": str(self.root / "handoff-token"),
            "FLEET_GIT_CREDENTIAL_HANDOFF": str(self.root / "handoff-git"),
        })

    def tearDown(self):
        self.tmp.cleanup()

    def auto(self, *args, **extra):
        return subprocess.run([str(SCRIPT), *args], capture_output=True, text=True,
                              env={**self.env, "FLEET_AUTO": "1", **extra}, check=False)

    def run_tty(self, args, typed, env=None):
        master, slave = pty.openpty()
        proc = subprocess.Popen([str(SCRIPT), *args], stdin=slave, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env or self.env)
        os.close(slave)
        os.write(master, typed.encode())
        try:
            out, err = proc.communicate(timeout=15)
        finally:
            os.close(master)
        return proc.returncode, out.decode(), err.decode()

    def agent_dir(self):
        return self.mnt / "nix/fleet-state/agent"

    def wiped(self):
        return self.log.exists() and "disko " in self.log.read_text()

    # ---- what is installed -----------------------------------------------------

    def test_installs_base_without_a_role_or_an_age_key(self):
        code, _out, err = self.run_tty([], DISK + "\n")
        self.assertEqual(code, 0, err)
        actions = self.log.read_text()
        self.assertIn(f"disko {DISK}", actions)
        self.assertIn(f"install --no-root-passwd --root {self.mnt} --system {self.system}", actions)
        # The node creates its own age identity on first boot.
        self.assertFalse((self.mnt / "nix/fleet-state/secrets").exists())
        self.assertTrue((self.mnt / "nix/fleet-state/ssh/ssh_host_ed25519_key").is_file())
        self.assertEqual((self.mnt / "nix/fleet-state/installed").read_text(), "status=installed\n")
        self.assertNotIn("Role:", err)
        self.assertIn("Assign its role in the Fleet app", err)

    def test_a_role_argument_is_refused_before_anything(self):
        for role in ("ci", "devbox", "ci-gpu"):
            with self.subTest(role=role):
                result = self.auto(role)
                self.assertEqual(result.returncode, 2)
                self.assertIn("role is assigned in the Fleet app", result.stderr)
                self.assertFalse(self.log.exists())

    def test_an_old_boot_entry_role_is_ignored_with_a_log_line(self):
        self.cmdline.write_text("root=LABEL=nixos fleet.role=ci fleet.role=devbox\n")
        result = self.auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"--system {self.system}", self.log.read_text())
        self.assertIn("ignoring fleet.role=devbox", (self.root / "install.log").read_text())

    def test_a_manifest_without_base_does_not_touch_a_disk(self):
        self.manifest.write_text(f"ci {self.system}\ndisko {self.disko}\n")
        result = self.auto()
        self.assertEqual(result.returncode, 1)
        self.assertIn("base system is not on this image", result.stderr)
        self.assertFalse(self.wiped())

    def test_missing_manifest_does_not_touch_a_disk(self):
        result = self.auto(FLEET_MANIFEST=str(self.root / "missing"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("USB image", result.stderr)
        self.assertFalse(self.log.exists())

    # ---- the optional enrollment token -------------------------------------------

    def assert_token_installed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.agent_dir() / "enrollment-token"
        self.assertEqual(installed.read_text(), TOKEN + "\n")
        self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.agent_dir().stat().st_mode & 0o777, 0o700)
        for text in (result.stdout, result.stderr, (self.root / "install.log").read_text(), self.log.read_text()):
            self.assertNotIn(TOKEN, text)
        self.assertIn("enrollment token: installed", (self.root / "install.log").read_text())
        self.assertNotIn(TOKEN, self.cmdline.read_text())

    def test_a_token_from_the_private_handoff_is_installed_privately_and_never_printed(self):
        (self.root / "handoff-token").write_text(TOKEN + "\n")
        result = self.auto()
        self.assert_token_installed(result)
        self.assertIn("from the private handoff", (self.root / "install.log").read_text())

    def test_a_token_from_a_fleet_key_volume_is_installed(self):
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "enrollment.token").write_text(TOKEN + "\n")
        result = self.auto(FLEET_KEY_DIR=str(stick))
        self.assert_token_installed(result)
        self.assertIn("from the FLEET-KEY volume", (self.root / "install.log").read_text())

    def test_a_token_from_the_environment_is_installed(self):
        self.assert_token_installed(self.auto(FLEET_ENROLL_TOKEN=TOKEN))

    def test_without_a_token_nothing_is_written_for_one(self):
        result = self.auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.agent_dir() / "enrollment-token").exists())
        self.assertFalse((self.enrolled / "enrollment-token").exists())
        self.assertIn("enrollment token: none", (self.root / "install.log").read_text())

    def test_a_malformed_token_is_refused_before_wiping_and_never_printed(self):
        for bad in ("short", "has space in it", "semi;colon-token", "x" * 513):
            with self.subTest(token=bad[:20]):
                (self.root / "handoff-token").write_text(bad + "\n")
                result = self.auto()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("Nothing was wiped", result.stderr)
                self.assertNotIn(bad, result.stdout + result.stderr)
                self.assertFalse(self.wiped())

    def test_readiness_receives_the_token_file_not_the_token(self):
        seen = self.root / "ready-args"
        write_executable(self.bin / "fleet-bootstrap-ready", f'#!/bin/bash\nprintf "%s\\n" "$@" > {seen}\ncat "$2" >> {seen}\n')
        (self.root / "handoff-token").write_text(TOKEN + "\n")
        result = self.auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(seen.read_text().splitlines(), [str(self.system), str(self.enrolled / "enrollment-token"), TOKEN])

    def test_the_live_node_credential_follows_the_node(self):
        (self.enrolled / "agent").mkdir(parents=True)
        (self.enrolled / "agent/node.secret").write_text("a" * 64 + "\n")
        result = self.auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.agent_dir() / "node.secret"
        self.assertEqual(installed.read_text(), "a" * 64 + "\n")
        self.assertEqual(installed.stat().st_mode & 0o777, 0o600)

    # ---- the optional Git read credential of a private repository -----------------

    def repo_auth(self, auth):
        (self.system / "etc/fleet").mkdir(parents=True, exist_ok=True)
        (self.system / "etc/fleet/bootstrap.json").write_text(json.dumps({"version": 1, "repoAuth": auth}))

    def secrets_dir(self):
        return self.mnt / "nix/fleet-state/secrets"

    def assert_git_installed(self, result, name, value):
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.secrets_dir() / name
        self.assertEqual(installed.read_text(), value)
        self.assertEqual(installed.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.secrets_dir().stat().st_mode & 0o777, 0o700)
        self.assertEqual(sorted(path.name for path in self.secrets_dir().iterdir()), [name])
        secret = value.strip().splitlines()[1] if value.startswith("-----") else value.strip()
        for text in (result.stdout, result.stderr, (self.root / "install.log").read_text(), self.log.read_text(),
                     self.cmdline.read_text()):
            self.assertNotIn(secret, text)
        self.assertIn(f"git read credential: installed as {name}", (self.root / "install.log").read_text())
        self.assertFalse((self.enrolled / "git-credential").exists(), "the staged copy does not outlive the install")

    def test_a_git_token_file_from_the_environment_is_installed_at_the_fixed_path(self):
        self.repo_auth("token")
        supplied = self.root / "git-token"
        supplied.write_text(GIT_TOKEN + "\n")
        self.assert_git_installed(self.auto(FLEET_GIT_CREDENTIAL_FILE=str(supplied)), "git-read-token", GIT_TOKEN + "\n")

    def test_a_git_key_from_the_private_handoff_is_installed_at_the_fixed_path(self):
        self.repo_auth("ssh")
        (self.root / "handoff-git").write_text(GIT_KEY.replace("\n", "\r\n"))
        result = self.auto()
        self.assert_git_installed(result, "git-read-key", GIT_KEY)
        self.assertIn("ssh from the private handoff", (self.root / "install.log").read_text())

    def test_git_credentials_from_a_fleet_key_volume_are_installed(self):
        for auth, name, value in (("ssh", "git-read-key", GIT_KEY), ("token", "git-read-token", GIT_TOKEN + "\n")):
            with self.subTest(auth=auth):
                self.tearDown()
                self.setUp()
                self.repo_auth(auth)
                stick = self.root / "stick"
                stick.mkdir()
                (stick / name).write_text(value)
                self.assert_git_installed(self.auto(FLEET_KEY_DIR=str(stick)), name, value)

    def test_a_private_repository_without_a_credential_is_refused_before_any_disk_work(self):
        for auth in ("ssh", "token"):
            with self.subTest(auth=auth):
                self.repo_auth(auth)
                result = self.auto()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(f"FLEET_GIT_CREDENTIAL_MISSING: this fleet follows a private repository (repo.auth = {auth}). "
                              "Supply its read credential with --git-credential-file or a FLEET-KEY volume.", result.stderr)
                self.assertFalse(self.log.exists(), "no disk was selected or erased")
                self.assertIn("FLEET_GIT_CREDENTIAL_MISSING", Path(self.env["FLEET_INSTALL_LOG"] + ".diagnostic").read_text())

    def test_a_git_credential_of_the_wrong_kind_is_refused_before_any_disk_work(self):
        token_file, key_file = self.root / "git-token", self.root / "git-key"
        token_file.write_text(GIT_TOKEN + "\n")
        key_file.write_text(GIT_KEY)
        stick = self.root / "stick"
        stick.mkdir()
        (stick / "git-read-key").write_text(GIT_TOKEN + "\n")  # a token in the key's file
        for auth, extra in (("ssh", {"FLEET_GIT_CREDENTIAL_FILE": str(token_file)}),
                            ("token", {"FLEET_GIT_CREDENTIAL_FILE": str(key_file)}),
                            ("ssh", {"FLEET_KEY_DIR": str(stick)})):
            with self.subTest(auth=auth, extra=sorted(extra)):
                self.repo_auth(auth)
                result = self.auto(**extra)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("FLEET_GIT_CREDENTIAL_WRONG_KIND", result.stderr)
                self.assertNotIn(GIT_TOKEN, result.stdout + result.stderr)
                self.assertNotIn(GIT_KEY_BODY, result.stdout + result.stderr)
                self.assertFalse(self.log.exists())
                self.assertFalse((self.enrolled / "git-credential").exists())

    def test_a_malformed_git_credential_is_refused_and_never_printed(self):
        self.repo_auth("token")
        for bad in ("short", "has space in it", "x" * 1025, GIT_TOKEN + "\n" + GIT_TOKEN,
                    GIT_KEY + "trailing text", GIT_KEY.replace("-----END", "-----FINISH"),
                    "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "A" * 17000 + "\n-----END OPENSSH PRIVATE KEY-----\n"):
            with self.subTest(bad=bad[:20]):
                (self.root / "handoff-git").write_text(bad)
                result = self.auto()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("FLEET_GIT_CREDENTIAL_INVALID", result.stderr)
                self.assertNotIn("FLEET-FAIL", result.stderr, "a refusal, not a crash")
                self.assertIn("Nothing was wiped", result.stderr)
                for line in bad.splitlines():
                    if len(line) >= 8 and "OPENSSH" not in line:
                        self.assertNotIn(line, result.stdout + result.stderr + (self.root / "install.log").read_text())
                self.assertFalse(self.log.exists())

    def test_a_public_repository_ignores_a_supplied_credential_with_a_log_line(self):
        for metadata in ("none", None):
            with self.subTest(repo_auth=metadata):
                self.tearDown()
                self.setUp()
                if metadata:
                    self.repo_auth(metadata)
                (self.root / "handoff-git").write_text(GIT_TOKEN + "\n")
                result = self.auto()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(self.secrets_dir().exists())
                self.assertIn("ignored; this fleet's repository is public", (self.root / "install.log").read_text())
                self.assertNotIn(GIT_TOKEN, (self.root / "install.log").read_text())

    def test_an_unknown_repo_auth_is_refused_before_any_disk_work(self):
        self.repo_auth("password")
        result = self.auto()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("FLEET_METADATA_INVALID", result.stderr)
        self.assertFalse(self.log.exists())

    # ---- checks before the wipe --------------------------------------------------

    def test_integration_failure_never_selects_or_erases_a_disk_and_keeps_a_copyable_code(self):
        for status in (2, 75):
            write_executable(self.bin / 'fleet-bootstrap-ready', f'#!/bin/bash\necho "FLEET_TEST_NOT_READY: fixture integration failure" >&2\nexit {status}\n')
            result = self.auto()
            self.assertEqual(result.returncode, status, result.stderr)
            self.assertIn('FLEET_TEST_NOT_READY', result.stderr)
            self.assertFalse(self.log.exists())
            self.assertIn('FLEET_TEST_NOT_READY', Path(self.env['FLEET_INSTALL_LOG'] + '.diagnostic').read_text())

    def test_failed_wifi_readiness_stops_before_disk_operations(self):
        write_executable(self.bin / "fleet-wifi-ready", "#!/bin/bash\nexit 2\n")
        result = self.auto()
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())

    def test_wifi_is_checked_before_wiping_and_persisted_after_partitioning(self):
        write_executable(self.bin / "fleet-wifi-ready", f"#!/bin/bash\nprintf 'wifi-ready\\n' >> '{self.log}'\n")
        write_executable(self.bin / "fleet-wifi-persist", f"#!/bin/bash\nprintf 'wifi-persist %s\\n' \"$1\" >> '{self.log}'\n")
        result = self.auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        actions = self.log.read_text()
        self.assertLess(actions.index("wifi-ready"), actions.index("disko "))
        self.assertGreater(actions.index("wifi-persist"), actions.index("disko "))
        self.assertIn("wifi-persist " + str(self.mnt), actions)

    def test_auto_wipes_without_typing_the_path(self):
        result = self.auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"disko {DISK}", self.log.read_text())
        self.assertIn("Wiping that disk", result.stderr)

    def test_non_tty_refuses_before_disko(self):
        result = subprocess.run([str(SCRIPT)], input=DISK + "\n", capture_output=True, text=True, env=self.env, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("without a terminal", result.stderr)
        self.assertFalse(self.wiped())

    def test_wrong_path_does_not_wipe(self):
        code, _out, err = self.run_tty([], "nope\n")
        self.assertEqual(code, 1)
        self.assertIn("did not match", err)
        self.assertNotIn("disko ", self.log.read_text())

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
        result = subprocess.run([str(SCRIPT)], capture_output=True, text=True, env=self.env, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Disk selection changed", result.stderr)
        self.assertFalse(self.log.exists())

    # ---- the record ---------------------------------------------------------------

    def test_the_install_log_follows_the_node_and_holds_no_secret(self):
        (self.root / "handoff-token").write_text(TOKEN + "\n")
        code, _out, err = self.run_tty([], DISK + "\n")
        self.assertEqual(code, 0, err)
        kept = self.mnt / "nix/fleet-state/logs/install.log"
        body = kept.read_text()
        self.assertEqual(oct(kept.stat().st_mode & 0o777), "0o600")
        self.assertRegex(body, r"(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ disk=")
        # Each step the live screens show is also in the log, in order.
        steps = [line.split(" step ", 1)[1] for line in body.splitlines() if " step " in line]
        self.assertEqual(steps, ["network", "approval", "checks", "disk", "erase", "install"])
        for step in ("partitioning with disko", "disko done", "nixos-install done", "installed the Fleet base system"):
            self.assertIn(step, body)
        self.assertNotIn(TOKEN, body)

    def test_a_failed_step_is_loud_and_says_where(self):
        write_executable(self.bin / "nixos-install", """\
            #!/bin/bash
            echo 'no space left' >&2
            exit 7
            """)
        code, _out, err = self.run_tty([], DISK + "\n")
        self.assertNotEqual(code, 0)
        self.assertIn("FLEET-FAIL fleet-install stopped at line", err)
        self.assertIn("(exit 7)", err)
        self.assertIn(f"Log: {self.root / 'install.log'}", err)
        body = (self.root / "install.log").read_text()
        self.assertIn("FAIL exit 7", body)
        self.assertNotIn("installed the Fleet base system", body)
        self.assertFalse((self.mnt / "nix/fleet-state/installed").exists())


if __name__ == "__main__":
    unittest.main()
