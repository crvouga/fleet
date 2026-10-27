#!/usr/bin/env python3
"""The shell that Nix embeds in units, run for real against stand-ins.

No Nix is needed: each script is cut out of its module between fixed markers
and the few Nix interpolations are replaced. A marker that moves fails loudly.
These are the pieces that make the fleet API's runner settings take effect:
labels and repository per slot, the slot count, and the disk threshold. The
Nix itself is evaluated by `nix flake check`.
"""

import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
FLEETCONF = ROOT / "scripts" / "fleetconf.py"


def write_executable(path, body):
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def cut(path, start, end):
    text = (ROOT / path).read_text()
    first = text.index(start) + len(start)
    return text[first:text.index(end, first)]


class ScriptCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fleet = self.root / "run/fleet"
        self.fleet.mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "log"
        self.log.write_text("")
        write_executable(self.bin / "fleetconf", f"""\
            #!/bin/bash
            exec {shlex.quote(sys.executable)} -I {shlex.quote(str(FLEETCONF))} "$@"
            """)
        write_executable(self.bin / "flock", "#!/bin/bash\nexit 0\n")
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FLEET_CONFIG": str(self.root / "applied.json"),
            "LOG": str(self.log),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def script(self, name, text):
        """Write `text` as an executable, with /run/fleet pointing at the temporary directory."""
        path = self.root / name
        path.write_text("#!/bin/bash\n" + text.replace("''${", "${").replace("/run/fleet", str(self.fleet)))
        path.chmod(0o755)
        return path

    def run_script(self, path, *args, env=None):
        return subprocess.run([str(path), *args], capture_output=True, text=True, env={**self.env, **(env or {})}, check=False)

    def logged(self):
        return [line for line in self.log.read_text().splitlines() if line]


class ListenerWrapperTests(ScriptCase):
    def setUp(self):
        super().setUp()
        text = cut("modules/runners.nix", 'pkgs.writeShellScriptBin "Runner.Listener" \'\'\n', "'') {};")
        text = re.sub(r"real=\$\{pkgs\.github-runner[^\n]*", f"real={self.bin}/real", text)
        self.wrapper = self.script("listener", text)
        write_executable(self.bin / "real", "#!/bin/bash\nprintf '%s\\n' \"$@\"\n")
        (self.fleet / "assign-used").mkdir()
        (self.fleet / "runner-labels").write_text("x64\ngpu\nfast\n")

    def configure(self, *args, slot="slot-1"):
        done = self.run_script(self.wrapper, "configure", *args, env={"FLEET_SLOT": slot})
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.splitlines()

    ARGS = ("--unattended", "--url", "https://github.com/org", "--labels", "nixos,ci", "--runnergroup", "grp", "--name", "n")

    def test_without_an_assignment_the_url_and_group_stay_and_labels_are_appended(self):
        out = self.configure(*self.ARGS)
        self.assertEqual(out[out.index("--url") + 1], "https://github.com/org")
        self.assertEqual(out[out.index("--labels") + 1], "nixos,ci,x64,gpu,fast")
        self.assertEqual(out[out.index("--runnergroup") + 1], "grp")

    def test_an_assigned_repository_replaces_the_url_and_drops_the_runner_group(self):
        (self.fleet / "assign-used/slot-1").write_text("owner/repo\n")
        out = self.configure(*self.ARGS)
        self.assertEqual(out[out.index("--url") + 1], "https://github.com/owner/repo")
        self.assertNotIn("--runnergroup", out)
        self.assertNotIn("grp", out)
        self.assertEqual(out[out.index("--labels") + 1], "nixos,ci,x64,gpu,fast")
        self.assertEqual(out[-2:], ["--name", "n"])
        other = self.configure(*self.ARGS, slot="slot-2")
        self.assertEqual(other[other.index("--url") + 1], "https://github.com/org")

    def test_equals_forms_are_rewritten_too(self):
        (self.fleet / "assign-used/slot-1").write_text("owner/repo\n")
        out = self.configure("--url=https://github.com/org", "--labels=nixos", "--runnergroup=grp")
        self.assertEqual(out[1:], ["--url=https://github.com/owner/repo", "--labels=nixos,x64,gpu,fast"])

    def test_an_assignment_alone_changes_nothing_else_and_a_bad_one_is_ignored(self):
        (self.fleet / "runner-labels").unlink()
        (self.fleet / "assign-used/slot-1").write_text("owner/repo\n")
        out = self.configure(*self.ARGS)
        self.assertEqual(out[out.index("--labels") + 1], "nixos,ci")
        for bad in ("not a repo", "../x/y;rm", "a/b/c", ""):
            (self.fleet / "assign-used/slot-1").write_text(bad + "\n")
            out = self.configure(*self.ARGS)
            self.assertEqual(out[out.index("--url") + 1], "https://github.com/org")
            self.assertEqual(out[out.index("--runnergroup") + 1], "grp")

    def test_only_configure_is_rewritten(self):
        (self.fleet / "assign-used/slot-1").write_text("owner/repo\n")
        done = self.run_script(self.wrapper, "run", "--startuptype", "service", env={"FLEET_SLOT": "slot-1"})
        self.assertEqual(done.stdout.splitlines(), ["run", "--startuptype", "service"])

    def test_a_label_with_a_comma_is_refused(self):
        (self.fleet / "runner-labels").write_text("a,b\n")
        done = self.run_script(self.wrapper, "configure", *self.ARGS, env={"FLEET_SLOT": "slot-1"})
        self.assertNotEqual(done.returncode, 0)


class RegisterWrapperTests(ScriptCase):
    def setUp(self):
        super().setUp()
        text = cut("modules/runners.nix", 'pkgs.writeShellScript "fleet-register-${id}" \'\'\n', "  '';\n  targets")
        text = text.replace("${pkgs.coreutils}/bin/", "").replace("${id}", "slot-1")
        text = re.sub(r"scope=\$\{lib\.escapeShellArg settings\.github\.scope\}", "scope=organization", text)
        text = re.sub(r"target=\$\{lib\.escapeShellArg target\}", "target=static-org", text)
        text = re.sub(r"exec \$\{token\} register[^\n]*", f'exec {self.bin}/token register "$scope" "$target" 1 2 key out', text)
        write_executable(self.bin / "token", "#!/bin/bash\nprintf '%s\\n' \"$*\"\n")
        self.register = self.script("register", text)
        (self.fleet / "assign").mkdir()

    def used(self):
        return self.fleet / "assign-used/slot-1"

    def test_no_assignment_registers_at_the_static_scope_and_records_nothing(self):
        done = self.run_script(self.register)
        self.assertEqual(done.stdout.strip(), "register organization static-org 1 2 key out")
        self.assertFalse(self.used().exists())

    def test_an_assignment_registers_the_repository_and_records_it_readable_by_the_runner(self):
        (self.fleet / "assign/slot-1").write_text("owner/repo\n")
        done = self.run_script(self.register)
        self.assertEqual(done.stdout.strip(), "register repository owner/repo 1 2 key out")
        self.assertEqual(self.used().read_text(), "owner/repo\n")
        self.assertEqual(self.used().stat().st_mode & 0o777, 0o644)

    def test_the_record_follows_the_assignment_and_never_outlives_it(self):
        (self.fleet / "assign/slot-1").write_text("owner/repo\n")
        self.run_script(self.register)
        (self.fleet / "assign/slot-1").unlink()
        done = self.run_script(self.register)
        self.assertIn("organization static-org", done.stdout)
        self.assertFalse(self.used().exists())

    def test_a_hostile_assignment_falls_back_to_the_static_scope(self):
        for bad in ("a b/c", "owner/repo;touch x", "$(id)/x", "owner/repo/extra", "\n"):
            (self.fleet / "assign/slot-1").write_text(bad + "\n")
            done = self.run_script(self.register)
            self.assertIn("organization static-org", done.stdout, bad)
            self.assertFalse(self.used().exists())


class CapacityScriptTests(ScriptCase):
    def setUp(self):
        super().setUp()
        text = cut("modules/ci-runner.nix", "    script = ''\n", "    '';\n  };")
        text = text.replace("${tools.fleetconf}/bin/fleetconf", str(self.bin / "fleetconf")).replace("${toString settings.capacity.slotMax}", "8")
        self.capacity = self.script("capacity", "set -e\n" + text)
        (self.fleet / "gate").write_text("")
        self.active = self.root / "active"
        write_executable(self.bin / "systemctl", """\
            #!/bin/bash
            printf 'systemctl %s\\n' "$*" >> "$LOG"
            if [ "$1" = is-active ]; then
              grep -qx "${@: -1}" "$ACTIVE" && exit 0
              exit 3
            fi
            """)
        self.env["ACTIVE"] = str(self.active)
        self.set_active(range(1, 5))
        (self.fleet / "slot-count").write_text("2\n")
        for n in range(1, 9):
            (self.fleet / f"slot-{n}").mkdir()

    def set_active(self, numbers):
        self.active.write_text("".join(f"github-runner-slot-{n}.service\n" for n in numbers))

    def stops(self):
        return [line.rsplit(" ", 1)[1] for line in self.logged() if line.startswith("systemctl stop")]

    def test_starts_the_counted_slots_and_stops_idle_surplus_ones(self):
        done = self.run_script(self.capacity)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("systemctl start github-runner-slot-1.service github-runner-slot-2.service", self.logged())
        self.assertEqual(self.stops(), ["github-runner-slot-3.service", "github-runner-slot-4.service"])
        self.assertFalse((self.fleet / "capacity-pending").exists())

    def test_a_busy_surplus_slot_is_never_stopped_and_is_remembered(self):
        (self.fleet / "slot-3/busy").write_text("1\n")
        done = self.run_script(self.capacity)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.stops(), ["github-runner-slot-4.service"])
        self.assertEqual((self.fleet / "capacity-pending").read_text(), "slot-3\n")
        (self.fleet / "slot-3/busy").unlink()
        self.log.write_text("")
        self.run_script(self.capacity)
        self.assertEqual(self.stops(), ["github-runner-slot-3.service", "github-runner-slot-4.service"])
        self.assertFalse((self.fleet / "capacity-pending").exists())

    def test_a_raised_count_starts_more_and_stops_nothing(self):
        (self.fleet / "slot-count").write_text("4\n")
        self.run_script(self.capacity)
        self.assertIn("systemctl start " + " ".join(f"github-runner-slot-{n}.service" for n in range(1, 5)), self.logged())
        self.assertEqual(self.stops(), [])

    def test_disabled_or_cordoned_runners_start_nothing(self):
        for document in ('{"runners": {"enabled": false}}', '{"runners": {"cordoned": true}}'):
            (self.root / "applied.json").write_text(document)
            self.log.write_text("")
            done = self.run_script(self.capacity)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(self.logged(), [])

    def test_a_corrupt_config_changes_nothing(self):
        (self.root / "applied.json").write_text("{nope")
        self.run_script(self.capacity)
        self.assertIn("systemctl start github-runner-slot-1.service github-runner-slot-2.service", self.logged())

    def test_a_bad_slot_count_still_fails_the_unit_as_before(self):
        (self.fleet / "slot-count").write_text("many\n")
        self.assertNotEqual(self.run_script(self.capacity).returncode, 0)


class DiskScriptTests(ScriptCase):
    def setUp(self):
        super().setUp()
        text = cut("modules/base.nix", "  systemd.services.fleet-disk = {", "  systemd.timers.fleet-disk")
        text = cut_script(text)
        text = text.replace("${fleetTools.fleetconf}/bin/fleetconf", str(self.bin / "fleetconf")).replace("${toString settings.disk.alertPercent}", "90")
        self.mounts = [self.root / "nix", self.root / "boot"]
        for mount in self.mounts:
            mount.mkdir()
        text = text.replace("for mount in /nix /boot; do", "for mount in " + " ".join(map(str, self.mounts)) + "; do")
        self.disk = self.script("disk", "set -e\n" + text)
        write_executable(self.bin / "df", """\
            #!/bin/bash
            printf 'Filesystem 1K-blocks Used Available Capacity Mounted\\nx 100 %s 1 %s%% %s\\n' "$USED" "$USED" "$2"
            """)

    def used(self, percent, **env):
        return self.run_script(self.disk, env={"USED": str(percent), **env})

    def test_the_built_in_threshold_applies_without_settings(self):
        self.assertEqual(self.used(89).returncode, 0)
        self.assertEqual(self.used(90).returncode, 1)

    def test_the_api_threshold_applies_in_both_directions(self):
        (self.root / "applied.json").write_text('{"disk": {"alertPercent": 70}}')
        self.assertEqual(self.used(75).returncode, 1)
        (self.root / "applied.json").write_text('{"disk": {"alertPercent": 99}}')
        self.assertEqual(self.used(95).returncode, 0)

    def test_unusable_settings_fall_back_to_the_built_in_threshold(self):
        for document in ("{broken", '{"disk": {"alertPercent": "50"}}', '{"disk": {"alertPercent": 10}}', "[]"):
            (self.root / "applied.json").write_text(document)
            with self.subTest(document=document):
                self.assertEqual(self.used(80).returncode, 0)
                self.assertEqual(self.used(92).returncode, 1)

    def test_a_missing_reader_falls_back_too(self):
        (self.bin / "fleetconf").unlink()
        write_executable(self.bin / "fleetconf", "#!/bin/bash\nexit 9\n")
        self.assertEqual(self.used(80).returncode, 0)
        self.assertEqual(self.used(95).returncode, 1)


def cut_script(text):
    first = text.index("script = ''\n") + len("script = ''\n")
    return text[first:text.index("    '';", first)]


if __name__ == "__main__":
    unittest.main()
