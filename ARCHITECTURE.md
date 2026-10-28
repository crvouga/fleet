# Fleet architecture: centralized, level-triggered reconciliation

Fleet has three parts with one job each:

| Part           | Job                                                                 | Decides                                     |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| **Installer**  | Erase one approved disk and install the role-less `base` system.    | Nothing about what the machine is for.      |
| **Controller** | Store each node's **desired state** and serve it.                   | Role, closure, every runtime setting.       |
| **Node**       | Compare **observed** with **desired** on every cycle, and converge. | Only _how_ to converge, never _what_ to be. |

Git stays the only source of _code_. The controller is the only source of
_assignment_. A node never chooses its own role.

```
                 operator / dashboard
                          │  assign role, edit settings
                          ▼
  ┌────────────────────────────────────────────────┐
  │ controller: desired state per node             │
  │   role, closure = f(role, hardware), values    │
  │   revision = sha256(canonical desired)[:16]    │
  └───────────────▲───────────────────┬────────────┘
     heartbeat:   │ observed state    │ desired document
     observed     │ + desiredRevision │ (when revision differs)
                  │                   ▼
  ┌───────────────┴────────────────────────────────┐
  │ node: fleet-agent (every heartbeat)            │
  │   persist desired → apply settings             │
  │   write /nix/fleet-state/target (role,closure) │
  │ node: fleet-sync (every poll)                  │
  │   git fetch main → build target closure        │
  │   gate (registry, secrets) → switch/reboot     │
  │   health check → rollback → report phase       │
  └────────────────────────────────────────────────┘
```

## Principles

1. **Level-triggered, not edge-triggered.** Every loop re-reads the complete
   desired state and the complete observed state and acts on the difference.
   It never acts because "something changed". A missed message, a crash, a
   reboot or a controller outage is harmless: the next cycle sees the same
   difference and takes the same step. Every step is idempotent.
2. **One owner for every value.** A value is either code (Git), assignment
   (controller) or hardware fact (node). Nothing is set in two places. There is
   no role on the installer, no role in the kernel command line and no role
   token on a USB stick.
3. **Data, never code.** The controller names a role and a closure from the
   registry that Git built, plus typed settings. A node only builds closures
   that exist in the `roles.json` of the revision it fetched from the
   configured repository, and only interprets keys from the settings table.
   The controller cannot make a node fetch from elsewhere, run a command or
   install a package that Git did not define.
4. **Observed state is reported, never trusted.** The controller stores what
   a node says it runs (`observedRole`, `observedClosure`) separately from what
   it should run (`role`, `desiredClosure`). Reports never change assignment.
5. **Converging is safe by construction.** A role change is applied like a
   kernel change: drain, `switch-to-configuration boot`, staggered reboot,
   boot-count fallback and health-checked rollback. The existing update
   safety (quarantine, drain gate, recovery outbox) applies unchanged.

## Desired state

The controller owns one document per node, computed on every heartbeat:

```json
{
  "revision": "0123456789abcdef",
  "role": "ci",
  "closure": "ci-gpu",
  "values": { "sync": { "paused": false }, "runners": { "repositories": ["acme/app"] } }
}
```

- `role` is assigned by a person (dashboard, `PATCH /v1/nodes/:id`), at
  approval (`POST /v1/nodes/:id/approve` with `{ "role" }`) or by an
  enrollment token that names a role. It is `null` for an unassigned node.
- `closure` is derived, never stored: `null` for a node that is not
  `approved` (keep whatever runs), `"base"` for an approved node without a
  role, otherwise `closureFor(role, hardware.capabilities)`: the first of the
  role's registry closures `<role>-<cap>[-<cap>…]` whose capabilities the node's
  _hardware_ has, else the role's own closure.
- `values` are the existing layered settings (`fleet` → `role:<role>` →
  `node:<id>`), resolved against the **assigned** role.
- `revision` is the first 16 hex characters of the sha256 of the canonical
  JSON of `{ role, closure, values }`. The node acknowledges it as
  `agent.desiredRevision`; the controller resends the document whenever the
  acknowledgement differs.

Convergence is computed, not stored: a node is **converged** when
`observedClosure == closure` and `agent.desiredRevision == revision` and the
node reports `reconcile.phase == "converged"`.

## Observed state

Every heartbeat (protocol `v: 2`) reports:

| Field                   | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `role`                  | The role of the **running** closure (`/etc/fleet/node.conf`), or `"base"`.      |
| `closure`               | The flake attribute of the running closure (`ci-gpu`, `devbox`, `base`).         |
| `hardware.capabilities` | What the hardware has, independent of the closure. Today: `gpu` (NVIDIA PCI).    |
| `ageRecipient`          | The node's own age public key (`age1…`), for SOPS recipients. Never the private. |
| `agent.desiredRevision` | The desired document the agent last accepted and applied.                        |
| `reconcile`             | `{ phase, issues }` from the node: `converged`, `progressing` or `blocked`.      |

`reconcile.issues` holds up to 8 public strings (≤500 characters) that tell a
person what blocks convergence, e.g.
`FLEET_SECRETS_RECIPIENT_MISSING: age1… is not a recipient of secrets/fleet.yaml at 9f3c2a1`.

## The node's two loops

**`fleet-agent`** (every heartbeat, default 60 s):

1. Report observed state; receive `desired` when the revision differs.
2. Persist it to `/nix/fleet-state/agent/config.json` (`{ revision, role, closure, values }`).
3. Apply settings (unchanged runtime steps: drain gate, capacity, labels,
   runner assignments, and now `devbox.authorizedKeys`).
4. Write `/nix/fleet-state/target` (`role=<role|base>`, `closure=<attr>`)
   when `closure` is not `null`, atomically and only when it differs.
5. Every cycle, with or without the controller, re-apply the cached desired
   document (level-triggered; a reboot or a lost file is repaired).

**`fleet-sync`** (every `repo.pollSeconds`, default 300 s):

1. Read the target (`/nix/fleet-state/target`, else the running image's own
   `ROLE`/`FLAKE_ATTR` from `/etc/fleet/sync.env`).
2. Fetch `main`. Refuse a target that the fetched `roles.json` does not define
   (`placement`). `base` always exists.
3. **Secrets gate:** when the target role has a `secrets` file in the fetched
   tree, the node's `age.pub` must be one of its recipients. Otherwise do not
   switch; report `blocked`. The next poll after the operator re-encrypts and
   merges converges on its own.
4. Build and switch exactly as before. If the target role differs from the
   running role, it is a reboot-class change (drain, `boot`, staggered reboot).
5. Write `/run/fleet/reconcile.json` (`{ phase, issues, target, revision }`)
   for the agent to report.

## Secrets: per-node identities, role-scoped recipients

Every node generates its own private age identity on first boot
(`fleet-age-identity.service` in `modules/base.nix`:
`/nix/fleet-state/secrets/age.key`, 0600, plus `age.pub`). It never leaves the
machine and the installer never handles it. The controller learns only the
public recipient.

Role secrets stay in Git, encrypted with SOPS. Each role's file is encrypted
to the recipients of the nodes the controller assigned that role
(`GET /v1/recipients`) plus the operator's own keys. The operator re-encrypts
(`sops updatekeys`) in their own repository; Fleet never holds a private age
key, never writes to Git and never changes GitHub settings. Role separation is
preserved: a devbox's identity is not a recipient of the CI file.

Nodes installed before this design keep their shared role key at the same
path; its public key is already a recipient, so they keep converging.

## Installer

The installer is a disk tool, not a configuration tool:

1. Boot the live image (one entry; no `fleet.role=`).
2. Select and confirm the internal disk (unchanged checks, expiry, checksum).
3. Managed mode: register the hardware identity (no role) and wait for a person
   to approve it before erasing. Local mode: proceed without approval.
4. Install `base` with `node.secret` and an optional enrollment token.
   Nothing else; the age identity is created by the node on first boot.
5. Reboot. From here the controller decides.

Removed from the installer: role choice (menus, prompts, flags, kernel
argument, PXE entries), role age keys and the `FLEET-KEY` role volume, Vault
wrapping, role tokens, the devbox SSH-key prompt, per-role readiness and
`installBlocked`, "reinstall as previous role". A reinstalled machine has the
same hardware node id, so the controller re-applies its stored role after
approval with no extra step.

## Controller

- **Schema v2** (migrated from v1): `nodes.role` is the assigned role, nullable;
  new `observed_role`, `observed_closure`, `age_recipient`, `hardware`,
  `reconcile` columns. The migration copies every v1 `role` into both `role`
  and `observed_role`, so existing nodes keep exactly what they run.
- **Registration** takes no role. `enrollmentToken` (optional) matches one of
  `FLEET_ENROLLMENT_TOKENS` (`[{ "sha256": "<hex>", "role": "ci" | null }]`):
  approved, and the role is assigned if the node has none. `FLEET_ROLE_TOKEN_HASHES`
  is refused at startup with the replacement named.
- **Admin**: assign a role (`PATCH /v1/nodes/:id { role }`, approve with role),
  list recipients (`GET /v1/recipients`), see desired vs observed and the
  reconcile phase on every node page.
- The heartbeat **never** writes `nodes.role`.

## Local mode (no controller)

The controller is still optional. Without `fleetApi.url` there is no agent, so
the desired-state source is a person at the console:
`fleet-target set ci|devbox|base` writes the same `/nix/fleet-state/target`
and starts `fleet-sync`. In managed mode the command refuses: the controller
is authoritative.

## Trust model changes

Moving assignment to the controller widens what a compromised controller can
do. It **can** now change a node's role among the roles Git defines (and thus
which reviewed closure it runs and which runner credentials it could decrypt
_if_ the operator already made it a recipient), and grant unprivileged `dev`
logins on devboxes through `devbox.authorizedKeys`. It still **cannot** run a
command, choose code outside the reviewed repository, obtain a private age key,
add a SOPS recipient, give root SSH access (root keys stay in Git), or skip
drain, health checks and rollback. Secrets require a Git change by the
operator; that review remains the gate for credentials.

## What the redesign removed

| Removed                                                                 | Replaced by                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------- |
| Per-role installer entries, `fleet.role=`, role prompts in every UI     | One `base` image; role assigned in dashboard    |
| `roles.json` `installerDefault`, closure `installer`, `installer` view  | `base` is fixed by the flake                    |
| Role age keys on `FLEET-KEY`, `fleet-keys.py` per-role key generation   | Per-node age identity generated on the target   |
| Vault/OpenBao wrapping, `fleet.enroll=`, `api_token`                    | Optional enrollment token file                  |
| Role tokens (`FLEET_ROLE_TOKEN_HASHES`, `roleToken`, `role-token`)      | `FLEET_ENROLLMENT_TOKENS`, `enrollmentToken`    |
| Node-claimed role in register and heartbeat                             | Controller-assigned `role`; reported `observed` |
| Devbox key at install                                                   | `devbox.authorizedKeys` setting                 |
| Per-role readiness/`installBlocked` on the image                        | Node-reported `reconcile.issues`                |
| "Changing roles erases the disk"                                        | Role change = drained reboot into a new closure |

## Rollout order

1. Deploy the controller (schema v2 migrates in place; v1 nodes are copied
   as assigned to the role they run).
2. Set `FLEET_ENROLLMENT_TOKENS` if you used role tokens (map each old hash to
   its role).
3. Merge the node changes to `main`. Nodes pull the new agent and `fleet-sync`;
   their targets equal what they run, so nothing switches.
4. Build and publish the new `base` installer. New machines install `base`
   and wait for assignment.

Reporting is best effort throughout: a v1 agent that the v2 controller refuses
(`400`) keeps updating from Git and picks up the v2 agent on its next sync.
