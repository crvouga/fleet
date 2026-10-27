"""Test discovery, isolation and failure propagation of the parallel runner."""
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


RUNNER = Path(__file__).with_name("run.py")


class PythonRunnerTests(unittest.TestCase):
    def invoke(self, files, *args):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests").mkdir()
            for name, source in files.items():
                (root / "tests" / name).write_text(textwrap.dedent(source))
            code = (
                "import importlib.util, pathlib, sys; "
                "spec = importlib.util.spec_from_file_location('runner', sys.argv[1]); "
                "runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner); "
                "runner.ROOT = pathlib.Path(sys.argv[2]); "
                "sys.argv = [sys.argv[0], *sys.argv[3:]]; sys.exit(runner.main())"
            )
            return subprocess.run(
                [sys.executable, "-B", "-c", code, str(RUNNER), directory, *args],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20,
            )

    def test_files_run_concurrently_in_separate_processes(self):
        # Both files must start before either can finish; a serial scheduler
        # fails the rendezvous. One module's environment cannot leak to another.
        source = '''
            import os, time, unittest
            from pathlib import Path
            class Rendezvous(unittest.TestCase):
                def test_isolated(self):
                    self.assertNotIn('FLEET_TEST_RUNNER_ISOLATION', os.environ)
                    os.environ['FLEET_TEST_RUNNER_ISOLATION'] = __name__
                    Path(__name__).touch()
                    deadline = time.monotonic() + 5
                    while len(list(Path('.').glob('test_ready_*'))) < 2:
                        if time.monotonic() > deadline:
                            self.fail('the other process did not start')
                        time.sleep(0.02)
        '''
        result = self.invoke({"test_ready_a.py": source, "test_ready_b.py": source}, "--workers", "2")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("2 files completed; 0 failed", result.stdout)

    def test_failure_does_not_hide_another_file(self):
        result = self.invoke({
            "test_bad.py": "raise RuntimeError('intentional import failure')",
            "test_good.py": "import unittest\nclass Good(unittest.TestCase):\n def test_ok(self): pass\n",
        })
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("test_good.py", result.stdout)
        self.assertIn("2 files completed; 1 failed: test_bad.py", result.stdout)

    def test_empty_discovery_and_invalid_workers_fail(self):
        for args in [[], ["--workers", "0"]]:
            with self.subTest(args=args):
                self.assertEqual(self.invoke({}, *args).returncode, 2)

    def test_pattern_selects_the_platform_suite(self):
        result = self.invoke({
            "test_wizard_example.py": "import unittest\nclass Good(unittest.TestCase):\n def test_ok(self): pass\n",
            "test_other.py": "raise RuntimeError('must not run')",
        }, "--pattern", "test_wizard*.py")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("1 files completed; 0 failed", result.stdout)

    def test_independent_methods_in_one_file_run_concurrently(self):
        result = self.invoke({"test_split.py": '''
            import time, unittest
            from pathlib import Path
            class Split(unittest.TestCase):
                def rendezvous(self):
                    Path(self._testMethodName).touch()
                    deadline = time.monotonic() + 5
                    while len(list(Path('.').glob('test_ready_*'))) < 2:
                        if time.monotonic() > deadline:
                            self.fail('the other batch did not start')
                        time.sleep(0.02)
                def test_ready_a(self): self.rendezvous()
                def test_ready_b(self): self.rendezvous()
        '''}, "--batch-size", "1", "--workers", "2")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("1 files completed; 0 failed", result.stdout)

    def test_class_and_module_fixtures_are_kept_together(self):
        for fixture in ["class", "module"]:
            setup = '''
                def setUpModule():
                    if Path('fixture-called').exists():
                        raise RuntimeError('module fixture ran twice')
                    Path('fixture-called').touch()
            ''' if fixture == "module" else '''
                @classmethod
                def setUpClass(cls):
                    if Path('fixture-called').exists():
                        raise RuntimeError('class fixture ran twice')
                    Path('fixture-called').touch()
            '''
            methods = "\n".join(f"    def test_case_{n}(self): self.assertTrue(Path('fixture-called').exists())" for n in range(6))
            prefix = "from pathlib import Path\nimport unittest\n"
            if fixture == "module":
                source = prefix + textwrap.dedent(setup) + "\nclass Shared(unittest.TestCase):\n" + methods
            else:
                source = prefix + "class Shared(unittest.TestCase):\n" + textwrap.indent(textwrap.dedent(setup), "    ") + methods
            with self.subTest(fixture=fixture):
                result = self.invoke({"test_shared.py": source}, "--batch-size", "1", "--workers", "4")
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn("Ran 6 tests", result.stdout)

    def test_dynamic_discovery_runs_each_test_exactly_once(self):
        result = self.invoke({"test_dynamic.py": '''
            import unittest
            class Generated(unittest.TestCase): pass
            def make(number):
                def test(self): print('VISITED-' + str(number), flush=True)
                return test
            for number in range(9):
                setattr(Generated, 'test_case_' + str(number), make(number))
        '''}, "--batch-size", "2")
        self.assertEqual(result.returncode, 0, result.stdout)
        for number in range(9):
            self.assertEqual(result.stdout.count("VISITED-" + str(number)), 1, result.stdout)

    def test_large_files_cannot_starve_other_files(self):
        result = self.invoke({
            "test_large.py": '''
                import time, unittest
                from pathlib import Path
                class Large(unittest.TestCase):
                    def rendezvous(self):
                        deadline = time.monotonic() + 5
                        while not Path('other-file-ran').exists():
                            if time.monotonic() > deadline:
                                self.fail('another file was starved')
                            time.sleep(0.02)
                    def test_a(self): self.rendezvous()
                    def test_b(self): self.rendezvous()
                    def test_c(self): self.rendezvous()
                    def test_d(self): self.rendezvous()
            ''',
            "test_small.py": '''
                import unittest
                from pathlib import Path
                class Small(unittest.TestCase):
                    def test_signal(self): Path('other-file-ran').touch()
            ''',
        }, "--batch-size", "1", "--workers", "2")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("2 files completed; 0 failed", result.stdout)

    def test_batches_cannot_observe_each_others_temporary_files(self):
        result = self.invoke({"test_private_temp.py": '''
            import tempfile, unittest
            from pathlib import Path
            class PrivateTemp(unittest.TestCase):
                def verify(self):
                    marker = Path(tempfile.gettempdir()) / 'another-batch-marker'
                    self.assertFalse(marker.exists(), 'a prior batch shared this temp directory')
                    marker.touch()
                def test_a(self): self.verify()
                def test_b(self): self.verify()
        '''}, "--batch-size", "1", "--workers", "1")
        self.assertEqual(result.returncode, 0, result.stdout)
