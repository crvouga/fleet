#!/usr/bin/env python3
"""Select expensive PR lanes; unknown changes and missing diffs run everything."""
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet_roles  # noqa: E402  (a sibling file, not an installed package)


FLEET = "packages/fleet/"
# Active roles' settings files. roles.json itself is not role-only: it decides
# which closures the installer image carries.
ROLE_FILES = {FLEET + role.settings for role in fleet_roles.load().roles if role.is_active}
ROLE_DIRECTORIES = tuple(FLEET + name + "/" for name in ("hosts", "hardware", "settings"))


def documentation(path):
    return path in {FLEET + "README.md", FLEET + "AGENTS.md"} or (
        path.startswith(FLEET + "docs/") and PurePosixPath(path).suffix == ".md"
    )


def fleet_scope(path):
    return path.startswith((FLEET, ".github/")) or path in {"bun.lock", "package.json"} or (
        "/" not in path and path.startswith("tsconfig") and path.endswith(".json")
    )


def only_documentation(paths, event):
    return event == "pull_request" and bool(paths) and all(documentation(path) for path in paths)


def classify(paths, event, affected):
    if event == "workflow_dispatch":
        affected = True
    if paths is not None and any(fleet_scope(path) for path in paths):
        affected = True
    if not affected:
        return {"fleet": False, "nix": False, "installer": False}
    if event != "pull_request" or paths is None:
        return {"fleet": True, "nix": True, "installer": True}
    # Other applications do not supply installer inputs. Unknown root files
    # remain relevant so CI/toolchain changes cannot accidentally skip a lane.
    relevant = [path for path in paths if not (path.startswith("packages/") and not path.startswith(FLEET))]
    if not relevant:
        return {"fleet": True, "nix": True, "installer": True}
    role_only = lambda path: path in ROLE_FILES or (path.startswith(ROLE_DIRECTORIES) and path.endswith(".nix"))
    return {
        "fleet": True,
        "nix": not all(documentation(path) for path in relevant),
        "installer": not all(documentation(path) or role_only(path) for path in relevant),
    }


def changed_paths(base, directory=None):
    if not re.fullmatch(r"[0-9a-f]{40,64}", base):
        raise ValueError("missing PR base commit")
    available = subprocess.run(["git", "cat-file", "-e", base + "^{commit}"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=directory)
    if available.returncode:
        subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", base], check=True, cwd=directory)
    parent = subprocess.check_output(["git", "rev-parse", "--verify", "HEAD^1"], cwd=directory, text=True).strip()
    if parent != base:
        raise ValueError("event base does not match the tested merge parent")
    # HEAD is GitHub's tested merge commit. Comparing its tree to the base
    # avoids merge-base history downloads. Disable rename detection so BOTH
    # deleted and added paths contribute, including runtime -> docs renames.
    data = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"], cwd=directory)
    return [path for path in data.decode().split("\0") if path]


def main():
    affected = os.environ.get("FLEET_AFFECTED") != "false"
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    paths = None
    if event == "pull_request":
        try:
            paths = changed_paths(os.environ.get("BASE_SHA", ""))
        except (ValueError, OSError, subprocess.SubprocessError):
            affected = True
            print("PR diff unavailable; running all Fleet build lanes", flush=True)
    result = classify(paths, event, affected)
    result["docs_only"] = only_documentation(paths, event)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for name, selected in result.items():
            output.write(f"{name}={str(selected).lower()}\n")
            print(f"Fleet {name}: {str(selected).lower()}", flush=True)


if __name__ == "__main__":
    main()
