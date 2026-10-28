#!/usr/bin/env python3
"""fleet-target: the desired state of a node that has no fleet controller.

    fleet-target show                    what this node runs, should run, and why not yet
    fleet-target set ROLE|base [CLOSURE] converge to ROLE (its own closure unless CLOSURE)
    fleet-target clear                   follow this image's own role again

`set` and `clear` write /nix/fleet-state/target, the same file fleet-agent
writes from the controller's desired state (ARCHITECTURE.md, "Local mode"),
and start fleet-sync without waiting for it. fleet-sync checks the target
against the roles.json of the revision it fetches before building anything,
and a role change reboots the node through the usual drain.

With a controller configured (FLEET_API_URL, fixed by the Nix wrapper from
fleetApi.url) the controller is authoritative: `set` and `clear` refuse and
name the dashboard instead. `show` always works. Nothing here reads a secret.
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import agent  # noqa: E402  (sibling module; generated ROLES lives there)
import fleetconf  # noqa: E402

USAGE = "usage: fleet-target show | set ROLE|base [CLOSURE] | clear"


def paths(env):
    state = Path(env.get("FLEET_STATE") or "/nix/fleet-state")
    return {
        "target": Path(env.get("FLEET_TARGET") or state / "target"),
        "node_conf": Path(env.get("FLEET_NODE_CONF") or "/etc/fleet/node.conf"),
        "reconcile": Path(env.get("FLEET_RECONCILE") or "/run/fleet/reconcile.json"),
        "age_pub": Path(env.get("FLEET_AGE_PUB") or state / "secrets/age.pub"),
        "systemctl": env.get("FLEET_SYSTEMCTL") or "systemctl",
    }


def managed(env):
    """True when this image names a controller: the agent runs and the controller assigns the target.
    An address the agent would refuse still counts; it is a configuration to fix, not a licence."""
    value = (env.get("FLEET_API_URL") or "").strip()
    return bool(value) and "TODO" not in value


def parse_target(text):
    """(role, closure) or None. Same shape rules as fleet-sync."""
    values = {}
    for line in (text or "").splitlines():
        if not line:
            continue
        key, sep, value = line.partition("=")
        if not sep or key not in ("role", "closure") or key in values:
            return None
        values[key] = value
    role, closure = values.get("role"), values.get("closure")
    if not role or not closure or not agent.CLOSURE_ATTR.fullmatch(closure):
        return None
    return role, closure


def resolve(role, closure):
    """The target for `set`, or raise ValueError with what is wrong."""
    if role == agent.BASE:
        if closure not in (None, agent.BASE):
            raise ValueError("base has exactly one closure: base")
        return agent.BASE, agent.BASE
    if role not in agent.ROLES:
        raise ValueError(f"{role!r} is not an active role; use one of: {', '.join(agent.ROLES)}, base")
    closure = closure or role
    if not agent.closure_of_role(role, closure):
        raise ValueError(f"{closure!r} is not a closure of role {role} ({role} or {role}-<capability>)")
    return role, closure


def start_sync(where):
    try:
        done = subprocess.run([where["systemctl"], "start", "--no-block", "fleet-sync.service"],
                              capture_output=True, text=True, timeout=15, check=False)
        return done.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def show(where, env, out):
    conf = agent.read_kv(where["node_conf"])
    current = parse_target(agent.read_text(where["target"], 1024)) if where["target"].exists() else None
    verdict = agent.read_json(where["reconcile"])
    verdict = verdict if isinstance(verdict, dict) else {}
    recipient = (agent.read_text(where["age_pub"], 256) or "").strip()
    print(f"mode: {'managed (the fleet controller assigns the role)' if managed(env) else 'local (fleet-target assigns the role)'}", file=out)
    print(f"running: {conf.get('role') or 'unknown'} ({conf.get('flake_attr') or 'unknown'})", file=out)
    if where["target"].exists() and current is None:
        print("target: unreadable; fleet-sync ignores it and keeps this image's role", file=out)
    elif current:
        print(f"target: {current[0]} ({current[1]})", file=out)
    else:
        print("target: none; fleet-sync keeps this image's role", file=out)
    print(f"convergence: {verdict.get('phase') or 'unknown'}" + (f" at {verdict['at']}" if verdict.get("at") else ""), file=out)
    for issue in verdict.get("issues") or []:
        if isinstance(issue, str):
            print(f"  {issue[:500]}", file=out)
    if agent.AGE_RECIPIENT.fullmatch(recipient):
        print(f"age recipient: {recipient}", file=out)
    return 0


def refuse_if_managed(env, err):
    if managed(env):
        print("fleet-target: this node is managed by the fleet controller, which assigns its role. "
              "Change the role on the node's page in Fleet (or PATCH /v1/nodes/<id>). Nothing was changed.", file=err)
        return True
    return False


def main(argv=None, env=None, out=sys.stdout, err=sys.stderr):
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    where = paths(env)
    command = argv[0] if argv else "show"
    if command == "show" and len(argv) <= 1:
        return show(where, env, out)
    if command == "set" and len(argv) in (2, 3):
        if refuse_if_managed(env, err):
            return 1
        try:
            role, closure = resolve(argv[1], argv[2] if len(argv) == 3 else None)
        except ValueError as error:
            print(f"fleet-target: {error}", file=err)
            return 2
        text = f"role={role}\nclosure={closure}\n"
        try:
            fleetconf.write_atomic(str(where["target"]), text, 0o644)
        except OSError as error:
            print(f"fleet-target: could not write {where['target']} ({type(error).__name__}); run it as root", file=err)
            return 1
        started = start_sync(where)
        print(f"target: {role} ({closure}). "
              + ("fleet-sync started; " if started else "fleet-sync could not be started; its timer runs at the next poll; ")
              + "fleet-target show reports progress. A role change drains and reboots this node.", file=out)
        return 0
    if command == "clear" and len(argv) == 1:
        if refuse_if_managed(env, err):
            return 1
        try:
            where["target"].unlink(missing_ok=True)
        except OSError as error:
            print(f"fleet-target: could not remove {where['target']} ({type(error).__name__}); run it as root", file=err)
            return 1
        start_sync(where)
        print("target cleared: this node follows its image's own role.", file=out)
        return 0
    print(USAGE, file=err)
    return 2


if __name__ == "__main__":
    sys.exit(main())
