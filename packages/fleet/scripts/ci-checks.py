#!/usr/bin/env python3
"""Evaluate checks once; build exact derivations and reuse proven VM results."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


GROUPS = ("roles", "runtime", "lifecycle", "image")
SPECIAL = {
    "runtime": {"vm", "devbox-vm", "native-vm", "cattle-vm", "wifi-vm"},
    "lifecycle": {"lifecycle", "follow-up"},
    "image": {"installer"},
}
CACHEABLE = {"runtime", "lifecycle"}
DRV = re.compile(r"/nix/store/[0-9a-z]{32}-[^/\s]+\.drv")


def partition(names):
    groups = {name: [] for name in GROUPS}
    for name in sorted(names):
        # New checks default to roles, so adding one never silently omits it.
        group = next((key for key, values in SPECIAL.items() if name in values), "roles")
        groups[group].append(name)
    return groups


def context(group):
    return {
        "version": 1, "group": group,
        "runner": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "nix": subprocess.check_output(["nix", "--version"], text=True).strip(),
    }


def evaluate(group):
    if group not in GROUPS:
        raise ValueError(f"unknown check group: {group}")
    # Git references preserve self.rev. path:. would build revision=unknown.
    names = json.loads(subprocess.check_output([
        "nix", "eval", "--no-write-lock-file", "--json",
        ".#checks.x86_64-linux", "--apply", "builtins.attrNames",
    ], text=True))
    selected = partition(names)[group]
    if not selected:
        raise ValueError(f"empty check group: {group}")
    nix_names = "[" + " ".join(json.dumps(name).replace("${", "\\${") for name in selected) + "]"
    expression = "checks: builtins.listToAttrs (map (name: { inherit name; value = checks.${name}.drvPath; }) " + nix_names + ")"
    checks = json.loads(subprocess.check_output([
        "nix", "eval", "--no-write-lock-file", "--json",
        ".#checks.x86_64-linux", "--apply", expression,
    ], text=True))
    if set(checks) != set(selected):
        raise ValueError("Nix did not evaluate every selected check")
    plan = {"context": context(group), "checks": checks}
    validate(plan, group)
    return plan


def validate(plan, group):
    if plan.get("context", {}).get("group") != group or not plan.get("checks"):
        raise ValueError("missing checks or wrong group in Nix plan")
    if any(not isinstance(drv, str) or not DRV.fullmatch(drv) for drv in plan["checks"].values()):
        raise ValueError("invalid derivation in Nix plan")
    if any(name not in partition(plan["checks"])[group] for name in plan["checks"]):
        raise ValueError("Nix plan includes checks from another group")


def read_results(path, expected):
    if not path or not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        records = data["passed"]
        if data["context"] != expected or not isinstance(records, dict):
            raise ValueError("cache context changed")
        for record in records.values():
            if not DRV.fullmatch(record["derivation"]) or not record["revision"]:
                raise ValueError("invalid success record")
        return records
    except (KeyError, TypeError, ValueError):
        print("Ignoring invalid or incompatible Nix results; running the checks again", flush=True)
        return {}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
    temporary.replace(path)


def realized_checks(checks):
    """Only Nix-registered successful outputs can become partial proof records."""
    passed = []
    for name, drv in checks:
        try:
            outputs = subprocess.check_output(["nix-store", "--query", "--outputs", drv], text=True).splitlines()
            if outputs and subprocess.run(["nix-store", "--check-validity", *outputs],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                passed.append((name, drv))
        except subprocess.CalledProcessError:
            pass
    return passed


def save_results(cache, plan, records):
    if cache:
        write_json(cache, {"context": plan["context"], "passed": {
            name: records[name] for name in plan["checks"] if name in records
        }})


def run(group, plan=None, cache=None, fresh=False):
    if group not in GROUPS:
        raise ValueError(f"unknown check group: {group}")
    plan = evaluate(group) if plan is None else plan
    validate(plan, group)
    if plan["context"] != context(group):
        raise ValueError("Nix plan no longer matches the runner or Nix version")
    if cache and group not in CACHEABLE:
        raise ValueError("role closures and installer images must always be materialized")
    records = {} if fresh else read_results(cache, plan["context"])
    pending = []
    for name, drv in sorted(plan["checks"].items()):
        record = records.get(name, {})
        if record.get("derivation") == drv:
            print(f"PASS cached {name}: {drv} (validated by {record['revision']})", flush=True)
        else:
            pending.append((name, drv))
    if group == "roles":
        # Still validate every flake output, including ci-gpu, apps and shells.
        subprocess.run([
            "nix", "flake", "check", "--no-build", "--no-write-lock-file",
            "--system", "x86_64-linux",
        ], check=True)
    if pending:
        jobs = "2" if group in CACHEABLE else "4"
        cores = "2" if group in CACHEABLE else "4"
        print(f"{group}: building {', '.join(name for name, _ in pending)}", flush=True)
        try:
            subprocess.run([
                "nix", "build", "--no-write-lock-file", "--max-jobs", jobs, "--cores", cores,
                *(["--keep-going"] if cache else []),
                "-L", "-o", "result-iso" if group == "image" else f"result-{group}",
                *(drv + "^*" for _, drv in pending),
            ], check=True)
        except subprocess.CalledProcessError:
            if cache:
                for name, drv in realized_checks(pending):
                    records[name] = {"derivation": drv, "revision": os.environ.get("GITHUB_SHA", "local")}
                save_results(cache, plan, records)
            raise
        for name, drv in pending:
            records[name] = {"derivation": drv, "revision": os.environ.get("GITHUB_SHA", "local")}
    save_results(cache, plan, records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("group", choices=GROUPS)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args()
    if args.plan_only:
        if args.plan is None:
            parser.error("--plan-only requires --plan")
        write_json(args.plan, evaluate(args.group))
    else:
        run(args.group, json.loads(args.plan.read_text()) if args.plan else None, args.cache, args.fresh)


if __name__ == "__main__":
    main()
