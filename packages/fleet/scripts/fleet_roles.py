#!/usr/bin/env python3
"""The fleet role registry (roles.json) and every copy of it.

roles.json is the only place a role is defined. Code that runs from this
repository reads it through load(). Code that must stand alone keeps a copy of
one view: node scripts and the bundled fleet-node.sh have no checkout, the
fleet-controller deployment does not contain this package, and the deployment files
must show a role change in their own reviewed diff. `sync` rewrites every copy
and `check` fails when one differs, so a role change is one edit to roles.json
followed by `sync`.

Roles are assigned by the fleet controller after installation, never by the
installer. Every machine installs the role-less `base` closure, which the flake
defines itself (hosts/base.nix, base.nix); it is not a registry entry and no
role may be named after it. See ARCHITECTURE.md.

Views:
  known      every role in the registry, active or retired. SQLite keeps node
             rows until a reviewed change deletes the role from the registry.
  active     roles the controller may assign and nodes may converge to.
  closures   closure attributes of active roles, in registry order. The
             controller picks <role>-<capability> from these by hardware.
  published  closure attributes the Fleet cache workflow builds and signs
             (base is always published in addition).

  python3 scripts/fleet_roles.py check
  python3 scripts/fleet_roles.py sync
  python3 scripts/fleet_roles.py validate PACKAGE_DIRECTORY
  python3 scripts/fleet_roles.py list known|active|closures|published
  python3 scripts/fleet_roles.py require-active ROLE
  python3 fleet_roles.py placement REGISTRY ROLE CLOSURE   (fleet-sync, on a node)
  python3 fleet_roles.py secrets REGISTRY ROLE             (fleet-sync, on a node)
"""
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
REPOSITORY = PACKAGE.parent.parent
REGISTRY_PATH = PACKAGE / "roles.json"

REGISTRY_VERSION = 2
# Version 1 also named the installer's default role and which closures the
# installer carried. Deployed nodes parse the roles.json of the revision they
# fetch with the parser of the revision they run, so roles.json stays version 1
# until every node runs this parser; the legacy keys are then accepted and
# ignored. Phase 2 of ARCHITECTURE.md's rollout moves the file to version 2.
LEGACY_VERSION = 1
LEGACY_CLOSURE_KEYS = frozenset(("attr", "host", "installer", "published"))
LEGACY_TOP_KEYS = frozenset(("version", "installerDefault", "roles"))
REGISTRY_BYTES_MAX = 64 * 1024
ROLES_MAX = 16
CLOSURES_PER_ROLE_MAX = 8
TEXT_LENGTH_MAX = 240
STATES = ("active", "retired")
ACTIVE_KEYS = frozenset(("name", "state", "title", "summary", "settings", "secrets", "closures"))
RETIRED_KEYS = frozenset(("name", "state", "title", "summary"))
CLOSURE_KEYS = frozenset(("attr", "host", "published"))
TOP_KEYS = frozenset(("version", "roles"))
ROLE_NAME = re.compile(r"[a-z][a-z0-9]{0,15}")
CLOSURE_ATTR = re.compile(r"[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,16}){0,4}")
SETTINGS_PATH = re.compile(r"[a-z][a-z0-9-]{0,31}\.nix")
SECRETS_PATH = re.compile(r"secrets/[a-z][a-z0-9-]{0,31}\.yaml")
# Flake outputs that are not role closures. A role must not shadow them.
RESERVED_ATTRS = frozenset(("base", "installer", "node", "default", "disko", "bootstrap", "fleet-installer", "fleet-node", "nixos-anywhere"))

# The role-less closure every machine installs. fleet-sync and node.conf use
# this name where a role would be.
BASE = "base"


class RegistryError(ValueError):
    """roles.json breaks a rule. The message names the rule and the value."""


def require(condition, message):
    if not condition:
        raise RegistryError("roles.json: " + message)


@dataclass(frozen=True)
class Closure:
    attr: str
    host: str
    is_published: bool


@dataclass(frozen=True)
class Role:
    name: str
    state: str
    title: str
    summary: str
    settings: "str | None"
    secrets: "str | None"
    closures: "tuple[Closure, ...]"

    @property
    def is_active(self):
        return self.state == "active"


@dataclass(frozen=True)
class Registry:
    roles: "tuple[Role, ...]"

    def view(self, name):
        if name == "known":
            return tuple(role.name for role in self.roles)
        if name == "active":
            return tuple(role.name for role in self.roles if role.is_active)
        if name == "closures":
            return tuple(closure.attr for role in self.roles if role.is_active for closure in role.closures)
        if name == "published":
            return tuple(closure.attr for role in self.roles for closure in role.closures if closure.is_published)
        raise RegistryError("unknown view " + repr(name) + "; use known, active, closures or published")

    def role(self, name):
        found = [role for role in self.roles if role.name == name]
        require(len(found) == 1, "no role named " + repr(name))
        return found[0]


def parse_text(value, what):
    require(isinstance(value, str) and 0 < len(value) <= TEXT_LENGTH_MAX and "\n" not in value,
            what + " must be one line of 1 to " + str(TEXT_LENGTH_MAX) + " characters")
    return value


def parse_closure(role_name, value, keys=CLOSURE_KEYS):
    require(isinstance(value, dict) and set(value) == keys,
            "role " + role_name + ": each closure has exactly " + ", ".join(sorted(keys)))
    attr = value["attr"]
    require(isinstance(attr, str) and CLOSURE_ATTR.fullmatch(attr) is not None,
            "role " + role_name + ": closure attr " + repr(attr) + " is not a lowercase name")
    # cattle.py derives the role from the host file name, so a closure is
    # always the role itself or the role plus capability suffixes.
    require(attr == role_name or attr.startswith(role_name + "-"),
            "role " + role_name + ": closure " + attr + " must be " + role_name + " or " + role_name + "-<capability>")
    require(attr not in RESERVED_ATTRS, "closure " + attr + " shadows a flake output")
    require(value["host"] == "hosts/" + attr + ".nix",
            "role " + role_name + ": closure " + attr + " must use host hosts/" + attr + ".nix")
    require(isinstance(value["published"], bool),
            "role " + role_name + ": closure " + attr + " published is true or false")
    return Closure(attr, value["host"], value["published"])


def parse_role(value, closure_keys=CLOSURE_KEYS):
    require(isinstance(value, dict), "every role is an object")
    name = value.get("name")
    require(isinstance(name, str) and ROLE_NAME.fullmatch(name) is not None,
            "role name " + repr(name) + " is not a lowercase name of at most 16 characters")
    require(name != BASE, "role name " + BASE + " is the role-less closure every machine installs")
    state = value.get("state")
    require(state in STATES, "role " + name + ": state must be active or retired")
    keys = ACTIVE_KEYS if state == "active" else RETIRED_KEYS
    require(set(value) == keys, "role " + name + " (" + state + ") has exactly " + ", ".join(sorted(keys)))
    title = parse_text(value["title"], "role " + name + " title")
    summary = parse_text(value["summary"], "role " + name + " summary")
    if state == "retired":
        return Role(name, state, title, summary, None, None, ())
    settings = value["settings"]
    require(isinstance(settings, str) and SETTINGS_PATH.fullmatch(settings) is not None,
            "role " + name + ": settings is a .nix file at the package root")
    secrets = value["secrets"]
    require(isinstance(secrets, str) and SECRETS_PATH.fullmatch(secrets) is not None,
            "role " + name + ": secrets is secrets/<name>.yaml")
    closures_value = value["closures"]
    require(isinstance(closures_value, list) and 0 < len(closures_value) <= CLOSURES_PER_ROLE_MAX,
            "role " + name + ": closures holds 1 to " + str(CLOSURES_PER_ROLE_MAX) + " entries")
    closures = tuple(parse_closure(name, closure, closure_keys) for closure in closures_value)
    primary = closures[0]
    # The primary closure is what the controller assigns when no capability
    # variant matches the hardware. Nodes converge from the published cache.
    require(primary.attr == name, "role " + name + ": the first closure is " + name + " itself")
    require(primary.is_published, "role " + name + ": its first closure must be published")
    return Role(name, state, title, summary, settings, secrets, closures)


def parse(document):
    version = document.get("version") if isinstance(document, dict) else None
    require(version in (LEGACY_VERSION, REGISTRY_VERSION),
            "version must be " + str(REGISTRY_VERSION) + " (or " + str(LEGACY_VERSION) + " during the rollout)")
    legacy = version == LEGACY_VERSION
    top_keys = LEGACY_TOP_KEYS if legacy else TOP_KEYS
    require(set(document) == top_keys, "top level has exactly " + ", ".join(sorted(top_keys)))
    roles_value = document["roles"]
    require(isinstance(roles_value, list) and 0 < len(roles_value) <= ROLES_MAX,
            "roles holds 1 to " + str(ROLES_MAX) + " entries")
    closure_keys = LEGACY_CLOSURE_KEYS if legacy else CLOSURE_KEYS
    roles = tuple(parse_role(role, closure_keys) for role in roles_value)
    names = [role.name for role in roles]
    require(len(set(names)) == len(names), "role names repeat: " + ", ".join(names))
    attrs = [closure.attr for role in roles for closure in role.closures]
    require(len(set(attrs)) == len(attrs), "closure attrs repeat: " + ", ".join(attrs))
    secrets = [role.secrets for role in roles if role.is_active]
    require(len(set(secrets)) == len(secrets), "two active roles share a secrets file")
    settings = [role.settings for role in roles if role.is_active]
    require(len(set(settings)) == len(settings), "two active roles share a settings file")
    active = [role for role in roles if role.is_active]
    require(len(active) > 0, "at least one role is active")
    return Registry(roles)


def load(path=REGISTRY_PATH):
    data = Path(path).read_bytes()
    require(len(data) <= REGISTRY_BYTES_MAX, "larger than " + str(REGISTRY_BYTES_MAX) + " bytes")
    try:
        document = json.loads(data)
    except ValueError as error:
        raise RegistryError("roles.json: not JSON: " + str(error)) from None
    return parse(document)


PLACEMENT_EXIT_GONE = 3


def placement(registry, role_name, attr):
    """Why a node cannot converge to this role and closure at the fetched
    revision, or None when it can. The answer names what to do, for the
    dashboard. The base closure always exists."""
    if role_name == BASE or attr == BASE:
        if role_name == BASE and attr == BASE:
            return None
        return "FLEET_TARGET_INVALID: base is only ever the closure of the base role."
    roles = [role for role in registry.roles if role.name == role_name]
    active = ", ".join(registry.view("active"))
    if not roles:
        return ("FLEET_ROLE_REMOVED: roles.json no longer defines role " + role_name
                + ". Assign this node one of: " + active + ", or no role, in the fleet controller.")
    role = roles[0]
    if not role.is_active:
        return ("FLEET_ROLE_RETIRED: roles.json retired role " + role_name + " (" + role.summary
                + ") Assign this node one of: " + active + ", or no role, in the fleet controller.")
    if attr not in [closure.attr for closure in role.closures]:
        return ("FLEET_CLOSURE_REMOVED: roles.json no longer builds " + attr + " for role " + role_name
                + ". The controller assigns another closure of " + role_name + " at the next report.")
    return None


def secrets_file(registry, role_name):
    """The role's SOPS file relative to the package, or None (base, unknown or retired roles)."""
    roles = [role for role in registry.roles if role.name == role_name and role.is_active]
    return roles[0].secrets if roles else None


def file_problems(registry, package=PACKAGE):
    """Each active role's files exist and no retired role leaves its files behind."""
    problems = []
    for path in (BASE + ".nix", "hosts/" + BASE + ".nix"):
        if not (package / path).is_file():
            problems.append("the base closure needs " + path)
    for role in registry.roles:
        if role.is_active:
            for path in [role.settings] + [closure.host for closure in role.closures]:
                if not (package / path).is_file():
                    problems.append("role " + role.name + " needs " + path)
        else:
            for path in [role.name + ".nix", "hosts/" + role.name + ".nix", "tests/" + role.name + ".nix"]:
                if (package / path).exists():
                    problems.append("retired role " + role.name + " still has " + path + "; delete it")
    return problems


# --- Copies -------------------------------------------------------------------


@dataclass(frozen=True)
class Copy:
    path: str  # relative to the repository root
    view: str
    style: str
    pattern: "re.Pattern[str]"
    count: int = 1


def render(names, style):
    require(len(names) > 0, "a copy is never empty")
    if style == "python-tuple":
        text = ", ".join('"' + name + '"' for name in names)
        return text + "," if len(names) == 1 else text
    if style == "python-set" or style == "hcl":
        return ", ".join('"' + name + '"' for name in names)
    if style == "words":
        return " ".join(names)
    if style == "single-quoted":
        return ", ".join("'" + name + "'" for name in names)
    if style == "json-hcl":
        return ", ".join('\\"' + name + '\\"' for name in names)
    raise RegistryError("unknown copy style " + style)


def line(pattern):
    return re.compile(pattern, re.MULTILINE)


COPIES = (
    Copy("packages/fleet/scripts/agent.py", "active", "python-tuple",
         line(r"^(?P<head>ROLES = \()(?P<list>[^)]*)(?P<tail>\).*)$")),
    Copy("packages/fleet/scripts/cattle.py", "active", "python-set",
         line(r"^(?P<head>HOST_ROLES = frozenset\(\{)(?P<list>[^}]*)(?P<tail>\}\).*)$")),
    Copy("packages/fleet-controller/src/types.ts", "known", "single-quoted",
         line(r"^(?P<head>export const ROLES = \[)(?P<list>[^\]]*)(?P<tail>\] as const;.*)$")),
    Copy("packages/fleet-controller/src/types.ts", "active", "single-quoted",
         line(r"^(?P<head>export const ACTIVE_ROLES = \[)(?P<list>[^\]]*)(?P<tail>\] as const.*)$")),
    Copy("packages/fleet-controller/src/types.ts", "closures", "single-quoted",
         line(r"^(?P<head>export const CLOSURES = \[)(?P<list>[^\]]*)(?P<tail>\] as const;.*)$")),
)


def copy_text(copy, registry, text):
    """The file text with this copy's lists rewritten, and whether it changed."""
    matches = list(copy.pattern.finditer(text))
    require(len(matches) == copy.count,
            copy.path + " has " + str(len(matches)) + " role lists for the " + copy.view
            + " view; expected " + str(copy.count) + ". Restore the line(s) sync rewrites")
    expected = render(registry.view(copy.view), copy.style)
    rewritten = copy.pattern.sub(lambda match: match.group("head") + expected + match.group("tail"), text)
    return rewritten, rewritten != text


def stale_copies(registry, root=REPOSITORY):
    stale = []
    for copy in COPIES:
        path = root / copy.path
        _, changed = copy_text(copy, registry, path.read_text(encoding="utf-8"))
        if changed:
            stale.append(copy.path + " (" + copy.view + ")")
    return stale


def sync(registry, root=REPOSITORY):
    changed_paths = []
    # Several copies can live in one file; apply them all before writing once.
    for path_text in dict.fromkeys(copy.path for copy in COPIES):
        path = root / path_text
        original = path.read_text(encoding="utf-8")
        text = original
        for copy in COPIES:
            if copy.path == path_text:
                text, _ = copy_text(copy, registry, text)
        if text != original:
            path.write_text(text, encoding="utf-8")
            changed_paths.append(path_text)
    # Postcondition: a second pass finds nothing to rewrite.
    require(stale_copies(registry, root) == [], "sync left a stale copy")
    return changed_paths


def main(argv):
    command = argv[0] if argv else ""
    try:
        if command == "placement" and len(argv) == 4:
            # On a node: the registry of the revision it is about to follow.
            reason = placement(load(argv[1]), argv[2], argv[3])
            if reason is None:
                return 0
            print(reason)
            return PLACEMENT_EXIT_GONE
        if command == "validate" and len(argv) == 2:
            # Inside a Nix build only this package exists: no copies to compare,
            # and this script's own store path is not inside the package.
            package = Path(argv[1])
            problems = file_problems(load(package / "roles.json"), package)
            for problem in problems:
                print(problem, file=sys.stderr)
            return 1 if problems else 0
        registry = load()
        if command == "check":
            problems = file_problems(registry) + ["stale copy: " + stale for stale in stale_copies(registry)]
            for problem in problems:
                print(problem, file=sys.stderr)
            if problems:
                print("Next: run python3 packages/fleet/scripts/fleet_roles.py sync, then commit.", file=sys.stderr)
                return 1
            return 0
        if command == "sync":
            for path in sync(registry):
                print("rewrote " + path, file=sys.stderr)
            return 0
        if command == "list" and len(argv) == 2:
            print("\n".join(registry.view(argv[1])))
            return 0
        if command == "secrets" and len(argv) == 3:
            # On a node: the SOPS file the target role decrypts, if any.
            path = secrets_file(load(argv[1]), argv[2])
            if path:
                print(path)
            return 0
        if command == "require-active" and len(argv) == 2:
            if argv[1] in registry.view("active"):
                return 0
            print("role must be one of: " + ", ".join(registry.view("active")), file=sys.stderr)
            return 2
    except RegistryError as error:
        print(error, file=sys.stderr)
        return 1
    print("usage: fleet_roles.py check | sync | validate PACKAGE | list VIEW | require-active ROLE"
          " | placement REGISTRY ROLE CLOSURE | secrets REGISTRY ROLE", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
