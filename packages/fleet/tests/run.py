#!/usr/bin/env python3
"""Run every unittest in bounded, isolated processes, preserving shared fixtures."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys
import time
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "FLEET_TEST_MANIFEST:"


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def shared_fixture(cls, name):
    method = getattr(cls, name, None)
    base = getattr(unittest.TestCase, name)
    return getattr(method, "__func__", method) is not getattr(base, "__func__", base)


def worker(root, filename, selection, listing):
    suite = unittest.TestLoader().discover(str(root / "tests"), pattern=filename)
    tests = list(flatten(suite))
    if listing:
        modules = {sys.modules[test.__class__.__module__] for test in tests}
        if Path(filename).stem in sys.modules:
            modules.add(sys.modules[Path(filename).stem])
        shared_module = any(
            any(hasattr(module, name) for name in ("setUpModule", "tearDownModule", "load_tests"))
            for module in modules
        )
        entries = [{"id": test.id(), "class": f"{test.__class__.__module__}.{test.__class__.__qualname__}",
                    "shared": any(shared_fixture(test.__class__, name) for name in ("setUpClass", "tearDownClass"))}
                   for test in tests]
        print(MANIFEST + json.dumps({"module_fixture": shared_module, "tests": entries}), flush=True)
        return 0
    if selection is not None:
        wanted = set(selection)
        selected = [test for test in tests if test.id() in wanted]
        if len(wanted) != len(selection) or {test.id() for test in selected} != wanted:
            raise ValueError("test selection no longer matches discovery")
        if wanted != {test.id() for test in tests}:
            suite = unittest.TestSuite(selected)
        tests = selected
    if not tests:
        raise ValueError(f"no tests found in {filename}")
    return int(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())


def command(root, filename):
    return [sys.executable, "-B", str(Path(__file__).resolve()), "--directory", str(root), "--worker", filename]


def isolated_run(arguments, root, timeout=None):
    with tempfile.TemporaryDirectory(prefix="fleet-test-batch-") as temporary:
        env = {**os.environ, "TMPDIR": temporary, "TEMP": temporary, "TMP": temporary}
        return subprocess.run(arguments, cwd=root, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=timeout)


def discover(root, path):
    result = isolated_run(command(root, path.name) + ["--list"], root, timeout=60)
    lines = [line[len(MANIFEST):] for line in result.stdout.splitlines() if line.startswith(MANIFEST)]
    if result.returncode or len(lines) != 1:
        raise RuntimeError(f"discovery failed for {path.name}:\n{result.stdout}")
    return json.loads(lines[0])


def batches(manifest, size):
    tests = manifest["tests"]
    if not tests:
        raise ValueError("discovery returned no tests")
    if manifest["module_fixture"] or len(tests) <= size:
        return [[test["id"] for test in tests]]
    classes = {}
    for test in tests:
        classes.setdefault(test["class"], []).append(test)
    result = []
    for members in classes.values():
        width = len(members) if any(test["shared"] for test in members) else size
        result.extend([[test["id"] for test in members[start:start + width]]
                       for start in range(0, len(members), width)])
    return result


def run_batch(root, path, selection):
    started = time.monotonic()
    result = isolated_run(command(root, path.name) + ["--tests", *selection], root)
    return result, time.monotonic() - started


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT)
    parser.add_argument("--pattern", default="test_*.py")
    parser.add_argument("--workers", type=int, default=min(8, max(1, (os.cpu_count() or 1) * 2)))
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--worker", help=argparse.SUPPRESS)
    parser.add_argument("--list", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--tests", nargs="*", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.workers < 1 or args.batch_size < 1:
        parser.error("--workers and --batch-size must be positive")
    root = args.directory.resolve()
    if args.worker:
        return worker(root, args.worker, args.tests, args.list)
    files = sorted((root / "tests").glob(args.pattern), key=lambda path: (-path.stat().st_size, path.name))
    if not files:
        parser.error("no test files matched")
    started = time.monotonic()
    failed = set()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        discovery = {pool.submit(discover, root, path): path for path in files}
        planned = {}
        for future in as_completed(discovery):
            path = discovery[future]
            try:
                planned[path] = batches(future.result(), args.batch_size)
            except Exception as error:
                print(f"{path.name}: {error}", file=sys.stderr, flush=True)
                failed.add(path.name)
        # Interleave modules so a large file cannot delay the first batch of
        # another slow suite until most workers have already finished.
        queue = [(path, planned[path][index])
                 for index in range(max((len(parts) for parts in planned.values()), default=0))
                 for path in files if index < len(planned.get(path, []))]
        pending = {pool.submit(run_batch, root, path, selection): (path, selection) for path, selection in queue}
        for future in as_completed(pending):
            path, selection = pending[future]
            try:
                result, duration = future.result()
                print(f"\n--- {path.name} / {selection[0]} ({len(selection)} tests, {duration:.1f}s) ---\n{result.stdout}", flush=True)
                if result.returncode:
                    failed.add(path.name)
            except Exception as error:
                print(f"{path.name}: {error}", file=sys.stderr, flush=True)
                failed.add(path.name)
    elapsed = time.monotonic() - started
    print(f"{len(files)} files completed; {len(failed)} failed: {', '.join(sorted(failed))} (wall={elapsed:.1f}s, workers={args.workers})", flush=True)
    return int(bool(failed))


if __name__ == "__main__":
    sys.exit(main())
