#!/usr/bin/env python3
"""Create the missing per-role age keys and wire them in.

Writes private keys to the operator-owned local JSON file (the
`fleet_age_keys` input) and the matching public recipients to .sops.yaml.
Existing keys are kept, so running it twice changes nothing. Private keys are
never printed and never written under a tracked path.

Keys are created for the active roles in roles.json. A retired role's existing
key stays in the input until an operator-reviewed change removes it.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet_roles  # noqa: E402  (a sibling file, not an installed package)

REGISTRY = fleet_roles.load()
ROLES = REGISTRY.view("active")
# The sops file each active role's recipient encrypts: secrets/fleet.yaml -> fleet.
FILES = {role.name: Path(role.secrets).stem for role in REGISTRY.roles if role.is_active}
KNOWN = frozenset(REGISTRY.view("known"))
HERE = Path(__file__).resolve().parent.parent
DEFAULT_OUT = Path.home() / ".config" / "fleet" / "fleet-age-keys.auto.tfvars.json"


def generate(tool):
    text = subprocess.run([tool], check=True, capture_output=True, text=True).stdout
    secret = next((line.strip() for line in text.splitlines() if line.startswith("AGE-SECRET-KEY-")), "")
    public = next((line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("# public key:")), "")
    if not secret or not public.startswith("age1"):
        raise RuntimeError("age-keygen gave no key")
    return secret, public


def public_of(tool, secret):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "key"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secret + "\n")
        return subprocess.run([tool, "-y", str(path)], check=True, capture_output=True, text=True).stdout.strip()


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def sops_text(publics):
    lines = ["# One age recipient per active role in roles.json. Roles never share a key.", "creation_rules:"]
    for role in ROLES:
        lines += [f"  - path_regex: secrets/{FILES[role]}\\.(yaml|yml|json)$", f"    age: {publics[role]}"]
    return "\n".join(lines) + "\n"


def main(argv):
    out = Path(os.environ.get("FLEET_KEYS_OUT") or DEFAULT_OUT)
    sops = Path(os.environ.get("FLEET_SOPS") or HERE / ".sops.yaml")
    tool = os.environ.get("FLEET_AGE_KEYGEN", "age-keygen")
    keys = {}
    if out.is_file():
        keys = dict(json.loads(out.read_text()).get("fleet_age_keys") or {})
    created = []
    for role in ROLES:
        if role not in keys:
            keys[role], _ = generate(tool)
            created.append(role)
    if len(set(keys.values())) != len(keys):
        print("Two roles share a key. Fix the input by hand.", file=sys.stderr)
        return 1
    unknown = sorted(set(keys) - KNOWN)
    if unknown:
        # The vault root's validation refuses these too; stop before it does.
        print("Keys for roles not in roles.json: " + ", ".join(unknown) + ". Remove them from " + str(out) + ".", file=sys.stderr)
        return 1
    if created:
        write_private(out, {"fleet_age_keys": keys})
    publics = {role: public_of(tool, keys[role]) for role in ROLES}
    sops.write_text(sops_text(publics))
    print(f"created: {', '.join(created) or 'none'}", file=sys.stderr)
    print(f"private keys: {out} (private; back up securely and import into your optional secret store)", file=sys.stderr)
    print(f"public recipients: {sops}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
