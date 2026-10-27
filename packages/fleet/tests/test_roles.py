#!/usr/bin/env python3
"""roles.json is the one definition of a role, and every copy follows it."""
import copy
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
SCRIPT = PACKAGE / "scripts" / "fleet_roles.py"
spec = importlib.util.spec_from_file_location("fleet_roles", SCRIPT)
roles = importlib.util.module_from_spec(spec)
sys.modules["fleet_roles"] = roles  # dataclasses resolve their module by name
spec.loader.exec_module(roles)
DOCUMENT = json.loads((PACKAGE / "roles.json").read_text())


def changed(edit):
    document = copy.deepcopy(DOCUMENT)
    edit(document)
    return document


def role_in(document, name):
    return next(role for role in document["roles"] if role["name"] == name)


class RegistryTests(unittest.TestCase):
    def test_the_fleet_is_ci_and_devbox_and_keeps_retired_state(self):
        registry = roles.load()
        self.assertEqual(registry.view("active"), ("ci", "devbox"))
        self.assertEqual(registry.view("known"), ("ci", "web", "cache", "netboot", "devbox"))
        self.assertEqual(registry.view("installer"), ("ci", "devbox"))
        self.assertEqual(registry.view("published"), ("ci", "ci-gpu", "devbox"))
        self.assertEqual(registry.installer_default, "ci")
        self.assertEqual([closure.attr for closure in registry.role("ci").closures], ["ci", "ci-gpu"])

    def test_the_repository_has_no_stale_copy_and_no_orphaned_role_file(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "check"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_each_rule_refuses_a_broken_registry_and_names_it(self):
        def retire_default(document):
            ci = role_in(document, "ci")
            for key in ("settings", "secrets", "closures"):
                del ci[key]
            ci["state"] = "retired"

        cases = {
            "names repeat": lambda d: d["roles"].append(copy.deepcopy(role_in(d, "web"))),
            "state must be active or retired": lambda d: role_in(d, "web").update(state="paused"),
            "(retired) has exactly": lambda d: role_in(d, "web").update(settings="web.nix"),
            "(active) has exactly": lambda d: role_in(d, "devbox").pop("closures"),
            "the first closure is devbox itself": lambda d: role_in(d, "devbox")["closures"][0].update(
                attr="devbox-gpu", host="hosts/devbox-gpu.nix", installer=False),
            "must use host hosts/ci-gpu.nix": lambda d: role_in(d, "ci")["closures"][1].update(host="hosts/ci.nix"),
            "must be ci or ci-<capability>": lambda d: role_in(d, "ci")["closures"][1].update(
                attr="gpu", host="hosts/gpu.nix"),
            "only the closure ci itself can be on the installer": lambda d: role_in(d, "ci")["closures"][1].update(
                installer=True),
            "must be on the installer and published": lambda d: role_in(d, "devbox")["closures"][0].update(
                published=False),
            "installerDefault": retire_default,
            "secrets is secrets/<name>.yaml": lambda d: role_in(d, "ci").update(secrets="../fleet.yaml"),
            "settings is a .nix file": lambda d: role_in(d, "ci").update(settings="hosts/../../x.nix"),
            "two active roles share a secrets file": lambda d: role_in(d, "devbox").update(
                secrets="secrets/fleet.yaml"),
            "top level has exactly": lambda d: d.update(extra=True),
            "version must be": lambda d: d.update(version=2),
            "shadows a flake output": lambda d: d["roles"].append({
                "name": "node", "state": "active", "title": "Node", "summary": "A test role.",
                "settings": "node.nix", "secrets": "secrets/node.yaml",
                "closures": [{"attr": "node", "host": "hosts/node.nix", "installer": True, "published": True}]}),
        }
        for message, edit in cases.items():
            with self.subTest(message), self.assertRaises(roles.RegistryError) as caught:
                roles.parse(changed(edit))
            self.assertIn(message, str(caught.exception))

    def test_a_single_role_renders_as_a_python_tuple(self):
        self.assertEqual(roles.render(("ci",), "python-tuple"), '"ci",')
        self.assertEqual(roles.render(("ci", "devbox"), "words"), "ci devbox")
        self.assertEqual(roles.render(("ci", "devbox"), "json-hcl"), '\\"ci\\", \\"devbox\\"')
        with self.assertRaises(roles.RegistryError):
            roles.render((), "words")


class PlacementTests(unittest.TestCase):
    def test_an_active_closure_may_follow_the_repository(self):
        registry = roles.load()
        self.assertIsNone(roles.placement(registry, "ci", "ci"))
        self.assertIsNone(roles.placement(registry, "ci", "ci-gpu"))
        self.assertIsNone(roles.placement(registry, "devbox", "devbox"))

    def test_retired_removed_and_missing_closures_say_what_to_do(self):
        registry = roles.load()
        self.assertTrue(roles.placement(registry, "web", "web").startswith("FLEET_ROLE_RETIRED: roles.json retired role web"))
        self.assertIn("as one of: ci, devbox", roles.placement(registry, "web", "web"))
        self.assertTrue(roles.placement(registry, "ci", "ci-tpu").startswith("FLEET_CLOSURE_REMOVED"))
        self.assertTrue(roles.placement(registry, "kiosk", "kiosk").startswith("FLEET_ROLE_REMOVED"))

    def test_the_command_exits_three_with_one_line(self):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "placement", str(PACKAGE / "roles.json"), "netboot", "netboot"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, roles.PLACEMENT_EXIT_GONE)
        self.assertEqual(len(result.stdout.strip().splitlines()), 1)


class CopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for copy_entry in roles.COPIES:
            target = self.root / copy_entry.path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(roles.REPOSITORY / copy_entry.path, target)

    def tearDown(self):
        self.tmp.cleanup()

    def test_sync_rewrites_every_stale_copy_once_and_check_then_passes(self):
        registry = roles.parse(changed(lambda d: role_in(d, "web").update(state="retired")))
        bigger = roles.Registry(registry.installer_default, registry.roles + (
            roles.Role("kiosk", "retired", "Kiosk", "A test role.", None, None, ()),))
        self.assertEqual(roles.stale_copies(roles.load(), self.root), [])
        stale = roles.stale_copies(bigger, self.root)
        self.assertTrue(stale)
        rewritten = roles.sync(bigger, self.root)
        self.assertEqual(roles.stale_copies(bigger, self.root), [])
        self.assertEqual(roles.sync(bigger, self.root), [])
        self.assertIn("packages/fleet-api/schema.hcl", rewritten)
        self.assertIn("'kiosk'", (self.root / "packages/fleet-api/schema.hcl").read_text())
        # An active-only copy does not learn a retired role.
        self.assertNotIn("kiosk", (self.root / "packages/fleet/scripts/decide.py").read_text())

    def test_a_copy_whose_line_was_edited_away_fails_loudly(self):
        path = self.root / "packages/fleet/scripts/agent.py"
        path.write_text(path.read_text().replace("ROLES = (", "KNOWN_ROLES = ("))
        with self.assertRaises(roles.RegistryError) as caught:
            roles.stale_copies(roles.load(), self.root)
        self.assertIn("packages/fleet/scripts/agent.py has 0 role lists", str(caught.exception))


class ConsumerTests(unittest.TestCase):
    def test_python_consumers_hold_the_registry_view(self):
        sys.path.insert(0, str(PACKAGE / "scripts"))
        sys.path.insert(0, str(PACKAGE / "wizard"))
        try:
            import decide
            import server
        finally:
            sys.path.remove(str(PACKAGE / "wizard"))
            sys.path.remove(str(PACKAGE / "scripts"))
        registry = roles.load()
        self.assertEqual(decide.ROLES, registry.view("active"))
        self.assertEqual(decide.ROLE_CHOICES, "ci or devbox")
        # The wizard describes every role it offers, and nothing else.
        self.assertEqual(set(server.ROLE_INFO), set(registry.view("active")))

    def test_retired_role_files_are_gone_and_active_role_files_exist(self):
        self.assertEqual(roles.file_problems(roles.load()), [])
        registry = roles.parse(changed(lambda d: None))
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package / "hosts").mkdir()
            (package / "web.nix").write_text("{}")
            problems = roles.file_problems(registry, package)
        self.assertIn("retired role web still has web.nix; delete it", problems)
        self.assertIn("role ci needs fleet.nix", problems)


if __name__ == "__main__":
    unittest.main()
