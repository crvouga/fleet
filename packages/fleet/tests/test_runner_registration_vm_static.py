"""Static guard for the runner-registration NixOS VM test (no Nix, no VM here).

`checks.runner-registration-vm` (tests/runner-registration.nix) has never run
when this file is written: the machine that wrote it has no Nix. These tests
keep it wired, well formed and honest about what it relies on, and they run
the things the VM test relies on (the fake controller, runner_control.py, the
agent, the readiness texts) against the real node scripts, so that the first
CI run is not also the first time those meet. The VM test itself is the proof.
"""
import ast
import builtins
import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
BASELINE = "2b3fe38"  # the commit before the controller-brokered runner change


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------- Nix text

def nix_problem(text):
    """None when every (), [], {} and ${} nests correctly outside strings and comments,
    else a short description. Understands "..." and ''...'' strings (with their
    escapes and ${} interpolation), # and /* */ comments."""
    stack = []
    i, n = 0, len(text)
    closing = {")": ("(",), "]": ("[",), "}": ("{", "${")}
    while i < n:
        top = stack[-1] if stack else None
        char = text[i]
        if top == '"':
            if char == "\\":
                i += 2
            elif char == '"':
                stack.pop()
                i += 1
            elif text.startswith("${", i):
                stack.append("${")
                i += 2
            else:
                i += 1
            continue
        if top == "''":
            if text.startswith("'''", i) or text.startswith("''$", i):
                i += 3
            elif text.startswith("''\\", i):
                i += 4
            elif text.startswith("''", i):
                stack.pop()
                i += 2
            elif text.startswith("${", i):
                stack.append("${")
                i += 2
            else:
                i += 1
            continue
        if char == "#":
            newline = text.find("\n", i)
            i = n if newline < 0 else newline
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                return "unterminated /* comment"
            i = end + 2
        elif char == '"':
            stack.append('"')
            i += 1
        elif text.startswith("''", i):
            stack.append("''")
            i += 2
        elif char in "([{":
            stack.append(char)
            i += 1
        elif char in ")]}":
            line = text.count("\n", 0, i) + 1
            if not stack or stack.pop() not in closing[char]:
                return f"unbalanced {char!r} at line {line}"
            i += 1
        else:
            i += 1
    return f"unterminated {stack[-1]!r}" if stack else None


def nix_files():
    return sorted(path for path in ROOT.rglob("*.nix") if "node_modules" not in path.parts and ".fleet-local" not in path.parts)


def changed_nix_files():
    """Nix files under packages/fleet that differ from the baseline commit (None without git history)."""
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--name-only", BASELINE, "--", "."],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
        untracked = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "--others", "--exclude-standard", "--full-name", "--", "."],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    names = {line for line in (out + untracked).splitlines() if line.endswith(".nix")}
    top = Path(subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip())
    return sorted(top / name for name in names if (top / name).exists())


class NixDelimiters(unittest.TestCase):
    def test_the_checker_understands_nix_strings(self):
        good = [
            "{ a = ''x ${ toString (1 + 2) } '''y''' ''${notInterpolation} #notAComment ''; b = \"q${ \"}\" }\"; } # }",
            "let f = x: [ x (x) { y = x; } ]; in f 1",
            "''\n  echo \"''${HOME}\" # ) not code\n''",
        ]
        bad = ["{ a = [ 1 ; }", "{ a = ''x; }", "{ a = \"x; }", "( ]", "{ a = 1; }}", "/* x"]
        for text in good:
            self.assertIsNone(nix_problem(text), text)
        for text in bad:
            self.assertIsNotNone(nix_problem(text), text)

    def test_every_nix_file_has_balanced_delimiters(self):
        files = nix_files()
        self.assertGreater(len(files), 20)
        for path in files:
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertIsNone(nix_problem(path.read_text()))

    def test_every_nix_file_changed_since_the_runner_change_is_covered(self):
        changed = changed_nix_files()
        if changed is None:
            self.skipTest("no git history to compare with " + BASELINE)
        for path in changed:
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertIsNone(nix_problem(path.read_text()))
        self.assertIn(ROOT / "tests/runner-registration.nix", changed)


# ------------------------------------------------------------ registered and wired

class Wiring(unittest.TestCase):
    def setUp(self):
        self.outputs = (ROOT / "outputs.nix").read_text()
        self.test = (TESTS / "runner-registration.nix").read_text()
        self.checks = load("ci_checks_for_runner_registration", "scripts/ci-checks.py")

    def test_outputs_registers_the_check_with_the_shared_arguments(self):
        self.assertRegex(self.outputs, r"(?m)^\s+runner-registration-vm = import \./tests/runner-registration\.nix testArgs;$")
        self.assertRegex(self.test, r"^\{ pkgs, lib, sopsModule, diskoModule \}: let")

    def test_ci_runs_it_in_a_job_group_not_by_default_in_roles(self):
        groups = self.checks.partition(["runner-registration-vm", "vm", "future-check"])
        self.assertIn("runner-registration-vm", groups["lifecycle"])
        self.assertNotIn("runner-registration-vm", groups["roles"])
        self.assertIn("lifecycle", self.checks.CACHEABLE, "its successes are cached per derivation, so a rerun does not repeat a passed VM")

    def test_every_nixos_vm_test_in_outputs_has_an_explicit_ci_group(self):
        grouped = set().union(*self.checks.SPECIAL.values())
        registered = re.findall(r"(?m)^\s+([a-z][a-z0-9-]*) = import \./tests/([a-z0-9-]+)\.nix testArgs", self.outputs)
        self.assertTrue(registered)
        for name, file in registered:
            if "runNixOSTest" in (ROOT / "tests" / (file + ".nix")).read_text():
                with self.subTest(check=name):
                    self.assertIn(name, grouped, "a VM test left in the default `roles` group slows it past its budget")

    def test_the_just_target_lists_it_with_the_other_vm_tests(self):
        self.assertIn("checks.x86_64-linux.runner-registration-vm", (ROOT / "justfile").read_text())

    def test_the_vm_uses_the_real_ci_role_with_a_controller_and_no_github_app(self):
        self.assertIn("../hosts/ci.nix", self.test)
        self.assertRegex(self.test, r'fleetApi = \{ url = "http://127\.0\.0\.1:\$\{toString brokerPort\}"; \};')
        for key in ('appId = "";', 'installationId = "";', "repositories = [ ];", "secretsFile = null;"):
            self.assertIn(key, self.test)
        # Only the listener is replaced; the token provider and runner-control stay real.
        self.assertNotIn("registrationProvider", self.test)
        self.assertNotIn("drainProvider", self.test)
        self.assertIn("package = mock;", self.test)

    def test_the_script_and_the_vm_agree_on_the_port_state_directory_and_slots(self):
        script = (TESTS / "runner_registration_vm.py").read_text()
        self.assertIn("testScript = builtins.readFile ./runner_registration_vm.py;", self.test)
        self.assertEqual(re.search(r"brokerPort = (\d+);", self.test).group(1), re.search(r"(?m)^PORT = (\d+)$", script).group(1))
        self.assertEqual(re.search(r'brokerState = "([^"]+)";', self.test).group(1), re.search(r'(?m)^STATE = "([^"]+)"$', script).group(1))
        self.assertIn('lib.genAttrs [ "slot-1" "slot-2" ]', self.test)
        self.assertIn('SLOTS = ("slot-1", "slot-2")', script)
        self.assertIn("RuntimeDirectory = \"fake-controller\";", self.test)
        self.assertIn("runner_registration_broker.py", self.test)

    def test_the_broker_is_ordered_before_the_agent_and_the_slots_it_serves(self):
        self.assertIn('before = [ "fleet-agent.service" "fleet-capacity.service" ];', self.test)
        self.assertIn('Type = "notify";', self.test)
        broker = (TESTS / "runner_registration_broker.py").read_text()
        self.assertIn("READY=1", broker)


# --------------------------------------------------------------- the test script

DRIVER_GLOBALS = {"machine", "start_all", "retry"}
# Methods of the pinned NixOS test driver (nixos/lib/test-driver machine/__init__.py).
MACHINE_API = {"succeed", "fail", "execute", "wait_for_unit", "wait_until_succeeds", "wait_until_fails", "sleep", "nested", "wait_for_file"}


def defined_names(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
    return names


class TestScript(unittest.TestCase):
    def setUp(self):
        self.path = TESTS / "runner_registration_vm.py"
        self.source = self.path.read_text()
        self.tree = ast.parse(self.source)

    def test_it_compiles(self):
        compile(self.source, str(self.path), "exec")
        done = subprocess.run([sys.executable, "-m", "py_compile", str(self.path)], capture_output=True, text=True,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_it_only_uses_what_the_test_driver_provides(self):
        used = {node.id for node in ast.walk(self.tree) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
        unknown = used - defined_names(self.tree) - set(dir(builtins)) - DRIVER_GLOBALS
        self.assertEqual(unknown, set())
        methods = {node.attr for node in ast.walk(self.tree)
                   if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "machine"}
        self.assertLessEqual(methods, MACHINE_API)

    def test_it_would_pass_the_driver_lint(self):
        # The driver runs `ruff check --select F` and `ty check`. Two classic F failures, checked here.
        for node in ast.walk(self.tree):
            if isinstance(node, ast.JoinedStr):
                self.assertTrue(any(isinstance(part, ast.FormattedValue) for part in node.values),
                                f"f-string without a placeholder at line {node.lineno}")
        imported = {alias.name for node in ast.walk(self.tree) if isinstance(node, ast.Import) for alias in node.names}
        used = {node.id for node in ast.walk(self.tree) if isinstance(node, ast.Name)}
        self.assertLessEqual(imported, used, "unused import")
        self.assertNotIn("''", self.source.replace("'''", ""), "two quotes in a row would end a Nix string if this ever moved inline")

    def test_it_asserts_everything_the_task_lists(self):
        required = [
            "/v1/runner-registration", "/run/fleet/tokens/slot-1", "600 root root", "configure-args", "PLACEHOLDER",
            "assign-used", "github-app-key", "app_id=", "journalctl", "fleet-ci.slice", "CPUWeight", "IOWeight",
            "TasksMax", "OOMScoreAdjust", "MemoryHigh", "MemoryMax", "memory.high", "memory.max", "oom_score_adj",
            "NoNewPrivileges", "ProtectSystem", "PrivateTmp", "status=75", "status=78", "runners_drained",
            "FLEET_GITHUB_UNAVAILABLE", "FLEET_RUNNER_NOT_ALLOWED", "FLEET_GITHUB_KEY", "NRestarts", "fleet-drain",
            "fleet-resume", "/nix/fleet-state/withdrawn", '"future"', "fleet-agent once", "runner-control register",
        ]
        for text in required:
            with self.subTest(text=text):
                self.assertIn(text, self.source)


# ------------------------------------------------------- options used by the modules

# Derived by review against nixpkgs 7c8764b7 (the pin in flake.lock, nixos-26.05):
# nixos/lib/systemd-unit-options.nix (sliceOptions.sliceConfig, serviceConfig),
# nixos/modules/system/boot/systemd.nix (systemd.slices),
# nixos/modules/services/continuous-integration/github-runner/{options,service}.nix.
MODULE_OPTIONS = {
    "runners.nix": {
        "assertions", "environment.systemPackages", 'environment.etc."fleet-slots".text', 'environment.etc."fleet/runner.conf".text',
        "users.groups", "users.users", "systemd.tmpfiles.rules", "services.github-runners", "systemd.slices.fleet-ci", "systemd.services",
    },
    "ci-runner.nix": {
        "imports", "_module.args.registrationProvider", "_module.args.drainProvider", "programs.nix-ld.enable",
        "virtualisation.podman", "systemd.services.fleet-capacity", "sops.secrets",
    },
    "agent.nix": {"environment.systemPackages", "systemd.tmpfiles.rules", "systemd.services.fleet-agent"},
    "onboarding.nix": {'environment.etc."fleet/bootstrap.json".text'},
}
# services.github-runners.<name>.*, as declared by the pinned module.
GITHUB_RUNNER_OPTIONS = {
    "enable", "url", "tokenFile", "tokenType", "name", "runnerGroup", "extraLabels", "noDefaultLabels", "replace",
    "extraPackages", "extraEnvironment", "serviceOverrides", "package", "ephemeral", "user", "group", "workDir", "nodeRuntimes",
}
# systemd.exec(5), systemd.service(5), systemd.resource-control(5), systemd.slice(5) settings.
SYSTEMD_SETTINGS = {
    "Slice", "CPUWeight", "IOWeight", "TasksMax", "OOMScoreAdjust", "Restart", "RestartSec", "UMask", "ExecStopPost",
    "ReadWritePaths", "PrivateUsers", "RestrictNamespaces", "RestrictSUIDSGID", "SystemCallFilter", "NoNewPrivileges",
    "CPUAccounting", "MemoryAccounting", "IOAccounting", "TasksAccounting", "MemoryHigh", "MemoryMax",
    "Type", "ExecStart", "ExecStartPre",
}
# Options only valid inside a block this file does not model; each is a systemd/NixOS name used at a depth we skip.
UNIT_OPTIONS = {"description", "wantedBy", "requires", "after", "wants", "before", "unitConfig", "serviceConfig", "restartIfChanged", "path", "script", "environment"}


def top_level_paths(text):
    text = re.split(r"(?m)^in \{", text, maxsplit=1)[1]  # the module body, not its `let` bindings
    return set(re.findall(r"(?m)^  ([A-Za-z_][\w.]*(?:\.\"[^\"]+\"(?:\.[\w]+)*|(?:\.[\w-]+)*))\s*=", text))


def block(text, start, opener="{"):
    """The text from the first `opener` after `start` to its matching closer (comment- and string-naive but enough for these modules)."""
    begin = text.index(opener, text.index(start))
    pairs = {"{": "}", "[": "]"}
    depth = 0
    for position in range(begin, len(text)):
        if text[position] == opener:
            depth += 1
        elif text[position] == pairs[opener]:
            depth -= 1
            if depth == 0:
                return text[begin:position + 1]
    raise AssertionError("unbalanced block after " + start)


def keys_of(body):
    return set(re.findall(r"(?m)^\s+([A-Za-z][A-Za-z0-9]*) = ", body))


class ModuleOptions(unittest.TestCase):
    def test_changed_modules_set_only_reviewed_options(self):
        for module, allowed in MODULE_OPTIONS.items():
            with self.subTest(module=module):
                found = top_level_paths((ROOT / "modules" / module).read_text())
                self.assertLessEqual(found, allowed, f"{module} sets an option nobody reviewed against nixpkgs 26.05")
                self.assertTrue(found, module)

    def test_github_runner_options_exist_in_the_pinned_module(self):
        text = (ROOT / "modules/runners.nix").read_text()
        body = block(text, "services.github-runners = ")  # the attribute set given to each slot
        options = set(re.findall(r"(?m)^    ([A-Za-z]+) = ", body))
        self.assertLessEqual(options, GITHUB_RUNNER_OPTIONS)
        self.assertLessEqual({"enable", "url", "tokenFile", "serviceOverrides", "ephemeral", "extraLabels"}, options)

    def test_systemd_settings_are_known_names(self):
        runners = (ROOT / "modules/runners.nix").read_text()
        overrides = keys_of(block(runners, "serviceOverrides = {"))
        slice_keys = keys_of(block(runners, "sliceConfig = {"))
        agent_keys = keys_of(block((ROOT / "modules/agent.nix").read_text(), "serviceConfig = {"))
        for keys in (overrides, slice_keys, agent_keys):
            self.assertLessEqual(keys, SYSTEMD_SETTINGS)
        self.assertLessEqual({"Slice", "CPUWeight", "IOWeight", "TasksMax", "OOMScoreAdjust"}, overrides)
        self.assertLessEqual({"MemoryHigh", "MemoryMax"}, slice_keys)
        self.assertIn("OOMScoreAdjust", agent_keys)

    def test_the_slice_is_declared_with_sliceConfig_not_serviceConfig_and_follows_the_slots(self):
        text = (ROOT / "modules/runners.nix").read_text()
        declaration = block(text, "systemd.slices.fleet-ci = ")
        self.assertIn("sliceConfig = {", declaration)
        self.assertNotIn("serviceConfig", declaration)
        self.assertIn("lib.mkIf (ids != [ ])", text, "a template with no slots must not declare an unused slice")
        # The slot units name exactly the slice that is declared.
        self.assertIn('Slice = "fleet-ci.slice";', text)

    def test_unit_options_in_the_vm_test_module_are_ordinary_ones(self):
        text = (TESTS / "runner-registration.nix").read_text()
        body = block(text, "systemd.services.fake-controller = ")
        self.assertLessEqual(keys_of(block(body, "serviceConfig = {")), {"Type", "ExecStart", "RuntimeDirectory", "RuntimeDirectoryMode", "Restart"})
        self.assertLessEqual(set(re.findall(r"(?m)^      ([A-Za-z]+) = ", body)), UNIT_OPTIONS)

    def test_resource_values_are_consistent(self):
        text = (ROOT / "modules/runners.nix").read_text()
        high, maximum = (int(n) for n in re.findall(r'Memory(?:High|Max) = "(\d+)%"', text))
        self.assertLess(high, maximum)
        self.assertLess(maximum, 100)
        for value in re.findall(r"(?:CPUWeight|IOWeight) = (\d+);", text):
            self.assertTrue(1 <= int(value) <= 10000)
        self.assertGreater(int(re.search(r"OOMScoreAdjust = (\d+);", text).group(1)), 0)
        self.assertGreaterEqual(int(re.search(r"OOMScoreAdjust = (-\d+);", (ROOT / "modules/agent.nix").read_text()).group(1)), -1000)


class ScriptBundles(unittest.TestCase):
    """Each `runCommand` in the tool definitions is ONE directory on the node: every sibling a
    script imports has to be copied into that same derivation (the older packaging test pools
    all of them, which hid that the agent bundle lacked runner_job.py)."""

    def bundles(self, definition):
        text = (ROOT / "modules" / definition).read_text()
        found = {}
        for name, body in re.findall(r'runCommand "([\w-]+)" \{ \} \'\'(.*?)\n\s*\'\';', text, re.S):
            found[name] = re.findall(r"cp \$\{\.\./scripts/([\w.]+)\}", body)
        return found

    def test_every_sibling_import_is_in_the_same_bundle(self):
        local = {path.stem for path in (ROOT / "scripts").glob("*.py")}
        for definition in ("fleet-tools.nix", "installer.nix"):
            bundles = self.bundles(definition)
            self.assertTrue(bundles, definition)
            for name, files in bundles.items():
                for file in files:
                    source = (ROOT / "scripts" / file).read_text()
                    wanted = set(re.findall(r"(?m)^\s*(?:import|from)\s+([a-z_]+)", source)) & local
                    with self.subTest(bundle=name, file=file):
                        self.assertLessEqual({stem + ".py" for stem in wanted} - {file}, set(files))

    def test_the_agent_starts_from_exactly_its_installed_bundle(self):
        files = self.bundles("fleet-tools.nix")["fleet-node-scripts"]
        self.assertIn("runner_job.py", files)
        self.assertIn("credential_rotation.py", files)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            for file in files:
                (root / "scripts" / file).write_bytes((ROOT / "scripts" / file).read_bytes())
            env = {**os.environ, "FLEET_API_URL": "https://fleet.example", "FLEET_AGENT_STATE": str(root / "state"),
                   "FLEET_RUN": str(root / "run"), "FLEET_ETC": str(root / "etc")}
            done = subprocess.run([sys.executable, "-I", "-B", str(root / "scripts/agent.py"), "status"], env=env,
                                  capture_output=True, text=True, timeout=30)
            self.assertEqual(done.returncode, 0, done.stderr)


# ------------------------- what the VM test relies on, against the real node scripts

NODE_ID = "ab" * 32
SECRET = "cd" * 32


def runner_control():
    spec = importlib.util.spec_from_file_location("runner_control_vm_static", ROOT / "scripts/runner_control.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"jwt": types.SimpleNamespace(encode=lambda *a, **k: "signed-jwt")}):
        spec.loader.exec_module(module)
    return module


class FakeController(unittest.TestCase):
    """The broker the VM runs, driven by the real runner_control.py and agent.py."""

    def setUp(self):
        broker = load("runner_registration_broker", "tests/runner_registration_broker.py")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "broker"
        self.broker, self.server = broker.serve(self.state, 0)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))
        self.run_dir, self.agent_state = self.root / "run", self.root / "state"
        (self.run_dir).mkdir()
        self.agent_state.mkdir()
        (self.run_dir / "node").write_text(f"role=ci\nhostname=ci-abab\nmachine_id={NODE_ID}\nrunner_prefix=ci-abab\n")
        (self.agent_state / "node.secret").write_text(SECRET + "\n")
        self.broker.secrets[NODE_ID] = SECRET
        self.control = runner_control()

    def mode(self, name, word):
        (self.state / name).write_text(word + "\n")

    def requests(self):
        return [json.loads(line) for line in (self.state / "requests.jsonl").read_text().splitlines()]

    def register(self, slot="slot-1"):
        env = {
            "FLEET_RUN": str(self.run_dir), "FLEET_AGENT_STATE": str(self.agent_state), "FLEET_SLOT": slot,
            "FLEET_API_URL": self.url, "FLEET_REGISTER_STATUS": str(self.run_dir / "register" / (slot + ".json")),
            "FLEET_ASSIGN_USED_FILE": str(self.run_dir / "assign-used" / slot),
            "FLEET_ASSIGN_GROUP_FILE": str(self.run_dir / "assign-group" / slot),
        }
        output = self.run_dir / "tokens" / slot
        # Exactly the arguments runners.nix passes: the placeholder target and no App.
        argv = ["runner_control.py", "register", "repository", "fleet-controller/unassigned", "", "", "/run/secrets/github-app-key", str(output)]
        with patch.object(sys, "argv", argv), patch.dict(os.environ, env), patch.object(self.control.time, "sleep") as sleep, \
                contextlib.redirect_stderr(io.StringIO()):
            code = self.control.run()
        record = json.loads((self.run_dir / "register" / (slot + ".json")).read_text())
        return code, record, output, sleep

    def test_ok_grants_a_private_token_and_records_the_controllers_repository(self):
        code, record, output, _ = self.register()
        self.assertEqual((code, record["code"], record["exit"]), (0, "ok", 0))
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual((output.parent).stat().st_mode & 0o777, 0o700)
        issued = [json.loads(line) for line in (self.state / "issued.jsonl").read_text().splitlines()]
        self.assertEqual([entry["token"] for entry in issued], [output.read_text()])
        self.assertFalse(output.read_text().startswith("gh"), "the upstream module would take it for a PAT")
        self.assertEqual((self.run_dir / "assign-used/slot-1").read_text().strip(), "acme/ci-fixture")
        granted = self.requests()[-1]
        self.assertEqual((granted["node"], granted["slot"], granted["repository"], granted["status"]), (NODE_ID, "slot-1", False, 200))

    def test_unavailable_retries_with_one_key_then_exits_75(self):
        self.mode("registration", "unavailable")
        code, record, output, sleep = self.register()
        self.assertEqual((code, record["code"], record["exit"]), (75, "FLEET_GITHUB_UNAVAILABLE", 75))
        keys = [request["key"] for request in self.requests()]
        self.assertEqual((len(keys), len(set(keys))), (3, 1), "three attempts, one idempotency key")
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 1], "Retry-After: 1 is honoured")
        self.assertFalse(output.exists())
        self.register()  # a second attempt is a new invocation with its own key
        self.assertEqual(len({request["key"] for request in self.requests()}), 2)

    def test_the_vm_must_see_one_new_key_per_attempt_and_recovery_after_an_outage(self):
        self.mode("registration", "unavailable")
        self.register()
        self.mode("registration", "ok")
        code, record, output, _ = self.register()
        self.assertEqual((code, record["code"]), (0, "ok"))
        self.assertTrue(output.exists())

    def test_forbidden_and_notfound_are_refusals_with_the_recorded_public_reason(self):
        self.mode("registration", "forbidden")
        code, record, output, _ = self.register()
        self.assertEqual((code, record["code"], record["exit"]), (78, "runners_drained", 78))
        self.assertIn("Runner admission is closed", record["message"])
        self.assertFalse(output.exists())
        self.mode("registration", "notfound")
        code, record, _, _ = self.register()
        self.assertEqual((code, record["code"], record["exit"]), (78, "FLEET_RUNNER_NOT_ALLOWED", 78))
        self.assertIn("HTTP 404", record["message"])

    def test_the_readiness_texts_the_vm_looks_for_are_what_the_node_reports(self):
        readiness = load("node_readiness_for_vm_static", "scripts/node_readiness.py")
        paths = types.SimpleNamespace(run=self.run_dir, systemctl="systemctl")

        def systemd(argv, timeout):
            if "show" in argv:
                return 0, "Id=github-runner-slot-1.service\nActiveState=activating\nNRestarts=1\n"
            return 3, "activating\nactive\n"

        (self.run_dir / "slot-count").write_text("2\n")
        for slot in ("slot-1", "slot-2"):
            (self.run_dir / slot).mkdir(exist_ok=True)
            (self.run_dir / slot / "prerequisites").write_text("ok\n")
        for mode, expected in (("unavailable", "FLEET_GITHUB_UNAVAILABLE"), ("forbidden", "runners_drained"), ("notfound", "FLEET_RUNNER_NOT_ALLOWED")):
            with self.subTest(mode=mode):
                self.mode("registration", mode)
                self.register()
                text = " ".join(readiness.controller_owned_issues(paths, systemd, 2))
                self.assertIn(expected, text)
                self.assertIn("slot-1", text)

    def test_the_legacy_branch_never_calls_the_controller(self):
        key = self.root / "github-app-key"
        key.write_text("not-an-rsa-private-key\n")
        raised = types.SimpleNamespace(encode=lambda *a, **k: (_ for _ in ()).throw(ValueError("not a key")))
        argv = ["runner_control.py", "register", "organization", "acme", "123", "456", str(key), str(self.root / "legacy-token")]
        env = {"FLEET_API_URL": self.url, "FLEET_SLOT": "slot-1", "FLEET_REGISTER_STATUS": str(self.root / "legacy.json")}
        self.control.jwt = raised
        with patch.object(sys, "argv", argv), patch.dict(os.environ, env), contextlib.redirect_stderr(io.StringIO()):
            code = self.control.run()
        self.assertEqual((code, json.loads((self.root / "legacy.json").read_text())["code"]), (78, "FLEET_GITHUB_KEY"))
        self.assertFalse((self.root / "legacy-token").exists())
        self.assertFalse((self.state / "requests.jsonl").exists(), "the controller must not be contacted")

    def run_agent_once(self):
        env = {**os.environ, "FLEET_API_URL": self.url, "FLEET_AGENT_STATE": str(self.agent_state), "FLEET_RUN": str(self.run_dir),
               "FLEET_ETC": str(self.root / "etc"), "FLEET_PROC": str(self.root / "proc"), "FLEET_SYS": str(self.root / "sys"),
               "FLEET_SYSTEMCTL": "/nonexistent/systemctl", "FLEET_SYSTEMD_RUN": "/nonexistent/systemd-run"}
        return subprocess.run([sys.executable, "-I", "-B", str(ROOT / "scripts/agent.py"), "once"], env=env,
                              capture_output=True, text=True, timeout=60, cwd=self.root)

    def test_the_agent_registers_and_heartbeats_whatever_optional_fields_the_controller_sends(self):
        for answer in ("minimal", "future", "minimal"):
            with self.subTest(answer=answer):
                self.mode("heartbeat", answer)
                done = self.run_agent_once()
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        heartbeats = [r for r in self.requests() if r["path"] == "/v1/heartbeat"]
        self.assertEqual([r["status"] for r in heartbeats], [200, 200, 200])
        self.assertEqual({r["node"] for r in heartbeats}, {NODE_ID})
        self.assertFalse([r for r in self.requests() if r["path"] == "/v1/credential/rotate"])
        self.assertTrue(all(isinstance(r["readiness"], list) for r in heartbeats))


if __name__ == "__main__":
    unittest.main()
