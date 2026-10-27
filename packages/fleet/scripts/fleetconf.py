#!/usr/bin/env python3
"""Read the dynamic fleet configuration a node last applied.

Data only. The fleet API sends typed settings (packages/fleet-api/src/config/schema.ts)
and the agent writes the ones it understands to /nix/fleet-state/config.json.
Shell units read them through this tool. It never fails a unit: a missing or
corrupt file, a key that is absent, and a value of the wrong type all give the
caller's default, so the image's built-in values always work without the API.

    fleetconf get sync.paused false     prints true or false
    fleetconf get reboot.delayMaxSeconds 7200
    fleetconf get runners.extraLabels   prints one entry per line
    fleetconf dump                      prints every valid setting as JSON

Python standard library only.
"""
import json
import os
import re
import sys
import tempfile

DEFAULT_PATH = "/nix/fleet-state/config.json"

REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
LABEL_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,50}$")
# Labels the image already sets. A person cannot shadow them.
RESERVED_LABELS = ("self-hosted", "linux", "x64", "arm64", "nixos", "ci", "gpu", "high-mem")


def _int(low, high):
    return ("int", low, high)


# Mirrors RULES in packages/fleet-api/src/config/schema.ts. The server rejects
# bad values; the node checks again because it never trusts what it is sent.
SPEC = {
    "heartbeat.intervalSeconds": _int(15, 3600),
    "sync.paused": ("bool",),
    "sync.retryBootAfter": _int(0, 4102444800),
    "reboot.enabled": ("bool",),
    "reboot.delayMaxSeconds": _int(0, 86400),
    "disk.alertPercent": _int(50, 99),
    "capacity.reserveGiB": _int(0, 256),
    "capacity.perRunnerGiB": _int(1, 256),
    "capacity.perRunnerCores": _int(1, 128),
    "capacity.slotMax": _int(1, 64),
    "capacity.highMemGiB": _int(1, 4096),
    "runners.enabled": ("bool",),
    "runners.cordoned": ("bool",),
    "runners.reopenAfter": _int(0, 4102444800),
    "runners.repositories": ("list", 64, REPO_PATTERN, ()),
    "runners.extraLabels": ("list", 16, LABEL_PATTERN, RESERVED_LABELS),
}


def _valid(rule, value):
    kind = rule[0]
    if kind == "bool":
        return isinstance(value, bool)
    if kind == "int":
        return type(value) is int and rule[1] <= value <= rule[2]
    if kind == "list":
        if not isinstance(value, list) or len(value) > rule[1]:
            return False
        for item in value:
            if not isinstance(item, str) or not rule[2].fullmatch(item):
                return False
            if any(part in (".", "..") for part in item.split("/")):
                return False
            if item.lower() in rule[3]:
                return False
        return len(set(value)) == len(value)
    return False


def sanitize(document):
    """Flatten a nested document to {"section.key": value}, dropping anything invalid or unknown."""
    flat = {}
    if not isinstance(document, dict):
        return flat
    for section, entries in document.items():
        if not isinstance(section, str) or not isinstance(entries, dict):
            continue
        for key, value in entries.items():
            name = f"{section}.{key}"
            rule = SPEC.get(name)
            if rule is not None and _valid(rule, value):
                flat[name] = list(value) if isinstance(value, list) else value
    return flat


def nest(flat):
    """The inverse of sanitize: {"a.b": 1} -> {"a": {"b": 1}}."""
    document = {}
    for name, value in flat.items():
        section, key = name.split(".", 1)
        document.setdefault(section, {})[key] = value
    return document


def load(path=None):
    """Valid settings from the applied-config file. Any problem gives {}."""
    target = path or os.environ.get("FLEET_CONFIG") or DEFAULT_PATH
    try:
        with open(target, encoding="utf-8") as handle:
            raw = handle.read(262144)
        return sanitize(json.loads(raw))
    except (OSError, ValueError, RecursionError):
        return {}


def write_atomic(path, text, mode=0o600):
    """Write a file so a reader sees the old content or the new content, never half of it."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            # Durable before the rename: after a power cut a reader sees the old
            # file or the whole new one, never an empty or torn file. A lost
            # config.json once let a cordoned node start runners again.
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
        try:
            handle = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        except OSError:
            handle = None
        if handle is not None:
            try:
                os.fsync(handle)
            except OSError:
                pass
            finally:
                os.close(handle)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def render(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return "\n".join(value)
    return str(value)


def get(name, default, path=None):
    """The applied value for name, else default. Never raises."""
    settings = load(path)
    if name in settings:
        return render(settings[name])
    return default


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["get"] and len(argv) in (2, 3):
        value = get(argv[1], argv[2] if len(argv) == 3 else "")
        if value != "":
            print(value)
        return 0
    if argv[:1] == ["dump"] and len(argv) == 1:
        print(json.dumps(nest(load()), sort_keys=True))
        return 0
    print("usage: fleetconf get KEY [DEFAULT] | fleetconf dump", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
