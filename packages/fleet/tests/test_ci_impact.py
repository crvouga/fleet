"""PR fast paths must not skip changed runtime inputs or release builds."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("ci_impact", Path(__file__).parents[1] / "scripts/ci-impact.py")
impact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(impact)
FULL = {"fleet": True, "nix": True, "installer": True}


class FleetImpactTests(unittest.TestCase):
    def test_documentation_pr_avoids_binary_builds(self):
        self.assertEqual(impact.classify(["packages/fleet/docs/installer.md", "packages/fleet/README.md"], "pull_request", True),
                         {"fleet": True, "nix": False, "installer": False})

    def test_role_configuration_pr_keeps_nix_and_skips_unaffected_packagers(self):
        for path in ["fleet.nix", "devbox.nix", "hosts/ci.nix", "settings/shared.nix", "hardware/gpu.nix"]:
            with self.subTest(path=path):
                self.assertEqual(impact.classify(["packages/fleet/" + path], "pull_request", True),
                                 {"fleet": True, "nix": True, "installer": False})

    def test_unknown_and_packaging_inputs_run_every_lane(self):
        for path in ["packages/fleet/wizard/main.py", "packages/fleet/scripts/decide.py", "packages/fleet/flake.nix", "packages/fleet/flake.lock",
                     "packages/fleet/modules/installer-package.nix", "packages/fleet/tests/test_wizard.py", "packages/fleet/future-input.dat",
                     ".github/workflows/ci.yml", "package.json", "bun.lock", "tsconfig.strict.json"]:
            with self.subTest(path=path):
                self.assertEqual(impact.classify([path], "pull_request", True), FULL)

    def test_main_merge_queue_and_manual_runs_keep_full_release_validation(self):
        for event in ["push", "merge_group", "workflow_dispatch"]:
            self.assertEqual(impact.classify(["packages/fleet/README.md"], event, True), FULL)

    def test_empty_missing_or_invalid_scope_cannot_authorize_a_skip(self):
        for paths in [[], None, ["packages/portfolio/projects.ts"]]:
            self.assertEqual(impact.classify(paths, "pull_request", True), FULL)
        with self.assertRaises(ValueError):
            impact.changed_paths("not a commit")

    def test_other_application_changes_do_not_expand_role_only_impact(self):
        self.assertEqual(impact.classify(["packages/fleet/fleet.nix", "packages/portfolio/projects.ts"], "pull_request", True),
                         {"fleet": True, "nix": True, "installer": False})
        self.assertEqual(impact.classify(["packages/portfolio/projects.ts"], "pull_request", False),
                         {"fleet": False, "nix": False, "installer": False})

    def test_actual_runtime_diff_overrides_a_false_path_filter(self):
        self.assertEqual(impact.classify(["packages/fleet/scripts/fleet-node.sh"], "pull_request", False), FULL)

    def test_rename_from_runtime_to_documentation_keeps_the_deleted_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", *args], cwd=root, text=True).strip()
            git("init", "--quiet")
            old = root / "packages/fleet/scripts/runtime.py"
            old.parent.mkdir(parents=True)
            old.write_text("fixture source\n")
            git("add", ".")
            git("commit", "--quiet", "-m", "fixture")
            base = git("rev-parse", "HEAD")
            new = root / "packages/fleet/docs/runtime.md"
            new.parent.mkdir(parents=True)
            old.rename(new)
            git("add", "--all")
            git("commit", "--quiet", "-m", "rename fixture")
            paths = impact.changed_paths(base, root)
            self.assertCountEqual(paths, ["packages/fleet/scripts/runtime.py", "packages/fleet/docs/runtime.md"])
            self.assertEqual(impact.classify(paths, "pull_request", True), FULL)
            (root / "packages/fleet/docs/another.md").write_text("fixture docs\n")
            git("add", "--all")
            git("commit", "--quiet", "-m", "advance fixture")
            with self.assertRaises(ValueError):
                impact.changed_paths(base, root)

    def test_integration_skip_requires_every_changed_file_to_be_fleet_documentation(self):
        docs = ["packages/fleet/docs/installer.md"]
        self.assertTrue(impact.only_documentation(docs, "pull_request"))
        for paths in [None, [], [*docs, "packages/fleet-api/src/server.ts"], [*docs, "package.json"], [*docs, "packages/fleet/fleet.nix"]]:
            self.assertFalse(impact.only_documentation(paths, "pull_request"))
        self.assertFalse(impact.only_documentation(docs, "merge_group"))

    def test_manual_selection_does_not_depend_on_a_path_filter(self):
        self.assertEqual(impact.classify(None, "workflow_dispatch", False), FULL)

    def test_standalone_manual_cli_writes_every_required_output(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            result = subprocess.run(["python3", "-B", str(Path(__file__).parents[1] / "scripts/ci-impact.py")],
                                    env={**os.environ, "FLEET_AFFECTED": "false", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_OUTPUT": str(output)},
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertEqual(output.read_text(), "fleet=true\nnix=true\ninstaller=true\ndocs_only=false\n")
