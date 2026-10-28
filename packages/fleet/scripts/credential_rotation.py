#!/usr/bin/env python3
"""Node credential rotation (the node side of PROTOCOL.md "Credential rotation").

Level-triggered, like everything on the node. An administrator asks the
controller to rotate this node's secret; every heartbeat answer then carries
`credential: {"rotate": true}` until the rotation completes. This module acts
on that flag after each successful heartbeat:

  1. Make sure a NEXT secret exists on disk (`node.secret.next`, 0600), created
     BEFORE the controller hears of it, so a crash never loses it.
  2. Offer the controller its sha256 over `POST /v1/credential/rotate`,
     authenticated with the CURRENT secret. The controller then accepts both.
  3. Only after a 200 answer: atomically replace `node.secret` with the next
     secret and forget the next file. The first heartbeat with the new secret
     makes the controller drop the old one.

Every step is idempotent and safe to repeat, so a crash or a lost answer at any
point is repaired by the next heartbeat: the node either still holds the old
secret (which the controller keeps accepting until the new one is used) or
already holds the new one (which the controller accepts once offered).

Python standard library only. Secrets are never logged.
"""

import hashlib
import os
import re
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import fleetconf  # noqa: E402  (sibling module; the Nix derivation puts the scripts together)

HEX64 = re.compile(r"[0-9a-f]{64}")
NEXT_NAME = "node.secret.next"
OFFER_PATH = "/v1/credential/rotate"


def next_path(paths):
    return paths.state / NEXT_NAME


def _read_hex(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read(256).strip()
    except OSError:
        return None
    return text if HEX64.fullmatch(text) else ""


def _remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def rotation_requested(document):
    """True when the heartbeat answer asks this node to rotate."""
    credential = document.get("credential") if isinstance(document, dict) else None
    return isinstance(credential, dict) and credential.get("rotate") is True


def pending_next(paths, current):
    """The next secret a previous attempt left on disk, or None.

    A file equal to the current secret is what a crash between "swap" and
    "forget" leaves; a malformed file is garbage. Both are removed.
    """
    path = next_path(paths)
    found = _read_hex(path)
    if found is None:
        return None
    if found == "" or found == current:
        _remove(path)
        return None
    return found


def ensure_next(paths, current):
    """The next secret, created and persisted (fsync + rename) when there is none."""
    existing = pending_next(paths, current)
    if existing is not None:
        return existing
    fresh = secrets.token_hex(32)
    while fresh == current:  # astronomically unlikely, but never offer the same secret
        fresh = secrets.token_hex(32)
    fleetconf.write_atomic(str(next_path(paths)), fresh + "\n", 0o600)
    return fresh


def swap(agent, new_secret):
    """Make `new_secret` this node's secret. The file is replaced atomically BEFORE
    the in-memory value changes, so a crash leaves either secret fully in place."""
    fleetconf.write_atomic(str(agent.paths.secret), new_secret + "\n", 0o600)
    agent.secret = new_secret
    _remove(next_path(agent.paths))


def step(agent, document, identity):
    """Run after a successful heartbeat. Returns one of
    "idle", "rotated", "refused", "retry". Never raises: rotation must not stop reporting."""
    if not rotation_requested(document):
        return "idle"
    try:
        return _rotate(agent, identity)
    except Exception as error:  # the loop must outlive any surprise; the next heartbeat retries
        agent.log(f"credential rotation will be retried: {type(error).__name__}")
        return "retry"


def _rotate(agent, identity):
    current = agent.secret
    if not isinstance(current, str) or not HEX64.fullmatch(current):
        return "retry"
    new_secret = ensure_next(agent.paths, current)
    digest = hashlib.sha256(new_secret.encode()).hexdigest()
    status, document = agent.api(
        "POST", OFFER_PATH, {"nextSecretHash": digest}, bearer=f"{identity['id']}.{current}"
    )
    if status == 200 and isinstance(document, dict) and document.get("ok") is True:
        swap(agent, new_secret)
        agent.log("rotated the node credential; the controller drops the old secret on first use of the new one")
        return "rotated"
    if status == 409:
        agent.log("the controller does not want a rotation now; keeping the current credential")
        return "refused"
    agent.log(f"credential rotation offer answered HTTP {status}; trying again on the next heartbeat")
    return "retry"
