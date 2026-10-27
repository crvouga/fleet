"""Every check runs or has an exact derivation success record; failures never cache."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("ci_checks", Path(__file__).parents[1] / "scripts/ci-checks.py")
ci_checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci_checks)


def drv(letter):
    return f"/nix/store/{letter * 32}-fixture.drv"


def context(group):
    return {"version": 1, "group": group, "runner": "fixture", "nix": "nix fixture"}


def plan(group, checks):
    return {"context": context(group), "checks": checks}


class CheckScheduling(unittest.TestCase):
    def setUp(self):
        self.mock_context = patch.object(ci_checks, "context", side_effect=context)
        self.mock_context.start()
        self.addCleanup(self.mock_context.stop)

    def test_every_check_runs_once_and_new_checks_are_not_lost(self):
        names = ["ci", "devbox", "roles", "agent-units", "cattle", "future-check"]
        names += [name for group in ci_checks.SPECIAL.values() for name in group]
        groups = ci_checks.partition(names)
        self.assertCountEqual([name for group in groups.values() for name in group], names)
        self.assertIn("future-check", groups["roles"])
        self.assertEqual(groups["image"], ["installer"])

    @patch.object(subprocess, "check_output", side_effect=['["node", "installer", "vm"]', json.dumps({"installer": drv("a")})])
    @patch.object(subprocess, "run")
    def test_image_evaluates_git_once_and_builds_exact_derivation(self, run, output):
        ci_checks.run("image")
        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertEqual(command[-1], drv("a") + "^*")
        self.assertEqual(command[command.index("-o") + 1], "result-iso")
        for call in output.call_args_list:
            self.assertIn(".#checks.x86_64-linux", call.args[0])
            self.assertNotIn("path:.", " ".join(call.args[0]))
        self.assertTrue(run.call_args.kwargs["check"])

    @patch.object(subprocess, "run")
    def test_full_flake_evaluation_still_runs_before_building_roles(self, run):
        ci_checks.run("roles", plan("roles", {"node": drv("a")}))
        self.assertIn("--no-build", run.call_args_list[0].args[0])
        self.assertEqual(run.call_args_list[1].args[0][-1], drv("a") + "^*")

    @patch.object(subprocess, "check_output", return_value='["node"]')
    def test_missing_image_fails_instead_of_succeeding_empty(self, output):
        with self.assertRaises(ValueError):
            ci_checks.run("image")

    def test_unknown_group_fails(self):
        with self.assertRaises(ValueError):
            ci_checks.run("typo")

    @patch.object(subprocess, "run")
    def test_only_unchanged_successful_derivations_can_reuse_a_result(self, build):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "results.json"
            original = plan("runtime", {"vm": drv("a"), "native-vm": drv("b")})
            with patch.dict("os.environ", {"GITHUB_SHA": "first-commit"}):
                ci_checks.run("runtime", original, cache)
            build.assert_called_once()
            build.reset_mock()
            ci_checks.run("runtime", original, cache)
            build.assert_not_called()
            updated = plan("runtime", {"vm": drv("c"), "native-vm": drv("b")})
            with patch.dict("os.environ", {"GITHUB_SHA": "second-commit"}):
                ci_checks.run("runtime", updated, cache)
            self.assertEqual(build.call_args.args[0][-1], drv("c") + "^*")
            self.assertNotIn(drv("b") + "^*", build.call_args.args[0])
            saved = json.loads(cache.read_text())["passed"]
            self.assertEqual(saved["vm"]["revision"], "second-commit")
            self.assertEqual(saved["native-vm"]["revision"], "first-commit")

    @patch.object(ci_checks, "realized_checks", return_value=[])
    @patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, "nix"))
    def test_failed_build_never_writes_a_success_record(self, build, realized):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "results.json"
            with self.assertRaises(subprocess.CalledProcessError):
                ci_checks.run("runtime", plan("runtime", {"vm": drv("a")}), cache)
            self.assertEqual(json.loads(cache.read_text())["passed"], {})

    @patch.object(subprocess, "run")
    def test_fresh_run_ignores_success_records(self, build):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "results.json"
            current = plan("runtime", {"vm": drv("a")})
            ci_checks.run("runtime", current, cache)
            build.reset_mock()
            ci_checks.run("runtime", current, cache, fresh=True)
            build.assert_called_once()

    @patch.object(subprocess, "run")
    def test_invalid_and_incompatible_cache_entries_rebuild(self, build):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "results.json"
            for bad in ["not json", json.dumps({"context": {}, "passed": {}}), json.dumps({"context": context("runtime"), "passed": {"vm": {"derivation": "not a drv", "revision": "old"}}})]:
                with self.subTest(cache=bad):
                    cache.write_text(bad)
                    build.reset_mock()
                    ci_checks.run("runtime", plan("runtime", {"vm": drv("a")}), cache)
                    build.assert_called_once()

    @patch.object(subprocess, "run")
    def test_roles_and_images_cannot_be_replaced_by_success_records(self, build):
        for group, name in [("roles", "node"), ("image", "installer")]:
            with self.subTest(group=group), self.assertRaises(ValueError):
                ci_checks.run(group, plan(group, {name: drv("a")}), Path("forbidden-cache"))
        build.assert_not_called()

    @patch.object(subprocess, "run")
    def test_invalid_plan_or_changed_evaluator_fails_before_building(self, build):
        for bad in [plan("runtime", {}), plan("runtime", {"vm": "bad path"}), plan("runtime", {"node": drv("a")}), {"context": {**context("runtime"), "runner": "other"}, "checks": {"vm": drv("a")}}]:
            with self.subTest(plan=bad), self.assertRaises(ValueError):
                ci_checks.run("runtime", bad)
        build.assert_not_called()


class ResourceScheduling(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(ci_checks, "context", side_effect=context)
        patcher.start()
        self.addCleanup(patcher.stop)

    @patch.object(subprocess, "run")
    def test_only_non_vm_groups_use_the_whole_runner(self, build):
        for group, name in [("roles", "node"), ("image", "installer"), ("runtime", "vm"), ("lifecycle", "follow-up")]:
            with self.subTest(group=group):
                ci_checks.run(group, plan(group, {name: drv("a")}))
                command = build.call_args.args[0]
                expected = "2" if group in ci_checks.CACHEABLE else "4"
                self.assertEqual(command[command.index("--max-jobs") + 1], expected)
                self.assertEqual(command[command.index("--cores") + 1], expected)


class PartialResults(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(ci_checks, "context", side_effect=context)
        patcher.start()
        self.addCleanup(patcher.stop)

    @patch.object(ci_checks, "realized_checks", return_value=[("vm", drv("a"))])
    @patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, "nix"))
    def test_failed_group_preserves_only_independently_realized_successes(self, build, realized):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "results.json"
            with self.assertRaises(subprocess.CalledProcessError):
                ci_checks.run("runtime", plan("runtime", {"vm": drv("a"), "native-vm": drv("b")}), cache)
            self.assertEqual(set(json.loads(cache.read_text())["passed"]), {"vm"})
            self.assertIn("--keep-going", build.call_args.args[0])
