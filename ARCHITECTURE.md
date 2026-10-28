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
6. **Nodes are stateless.** A node only caches. Everything that matters lives
   in Git (code, encrypted secrets) or in the controller (assignment,
   settings). The only durable node data is its identity. Any node can be
   wiped, reinstalled or replaced at any time and converges back to the same
   desired state.

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

## Stateless nodes

Root is tmpfs; `/nix` is the only disk a node writes. It holds three things:

| Class        | Where                                                                                                 | Lifetime                       |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| **System**   | `/nix/store`, `/nix/var`                                                                              | Nix's own; garbage collected   |
| **Identity** | the allow-list `IDENTITY` in `scripts/node_state.py`: node credential, enrollment token, age identity, Git read credential, SSH host keys, Wi-Fi, target, desired-state cache, update and recovery records | until the disk is reinstalled  |
| **Cache**    | everything else: `/nix/devbox`, `/nix/ci-cache`, `/nix/ci-state`, `/nix/fleet-code`, applied settings, **and anything undeclared** | until the role changes         |

A role is an epoch. `fleet-node-state.service` runs at the first boot of a
closure, before tmpfiles and any service, and compares the running role with
`/nix/fleet-state/role-epoch`. When they differ it wipes every cache, records
the new role and queues a `state-wiped` event. No role ever sees another
role's data, and a module that forgets to declare its data cannot leak it,
because the list names what is kept, not what is wiped. A wipe that fails
leaves the old record, so the next boot tries again. A devbox workspace is a
cache too: push your work.

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
path; its public key is already a recipient, so they keep converging. Rotate
them to their own identity with the procedure below.

**Rotation is per node and level-triggered.** The setting
`secrets.rotateAgeKeyAfter` (node page: **Rotate age identity**) asks every
node whose identity is older than that time for a successor. The agent creates
`age.next.key` on the node and reports only `ageRecipientNext`;
`GET /v1/recipients` lists it as `next`. The operator re-encrypts the role's
file for both recipients and merges. `fleet-sync` promotes the successor once
the fetched file lists it (at once for a role without secrets), so a node never
holds an identity its secrets cannot be decrypted with. After the node reports
the new `ageRecipient`, remove the old recipient.

**Private update repositories** (`repo.auth = "ssh" | "token"`). A new node
cannot decrypt anything before the operator makes it a recipient, and cannot
fetch that change without a credential. So the Git read credential is node
identity at a fixed path (`/nix/fleet-state/secrets/git-read-key` or
`git-read-token`, 0600), placed by the installer (`--git-credential-file` or a
`FLEET-KEY` volume); the installer refuses to erase a disk without it. A role
whose SOPS file holds the credential refreshes the fixed copy
(`fleet-git-credential.service`), so a rotated credential reaches every
assigned node through Git. Without it `fleet-sync` reports
`FLEET_GIT_CREDENTIAL_MISSING` instead of failing to fetch on every poll.

## Installer

The installer is a disk tool, not a configuration tool:

1. Boot the live image (one entry; no `fleet.role=`).
2. Select and confirm the internal disk (unchanged checks, expiry, checksum).
3. Managed mode: register the hardware identity (no role) and wait for a person
   to approve it before erasing. Local mode: proceed without approval.
4. Install `base` with `node.secret`, an optional enrollment token and, for a
   private update repository, the Git read credential. Nothing else; the age
   identity is created by the node on first boot.
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
| "Changing roles erases the disk"                                        | Drained reboot that wipes the old role's caches |
| `rotateAgeKey` (one key shared through SOPS `age-key-next`)             | Per-node `secrets.rotateAgeKeyAfter`            |

## Rollout order

1. Deploy the controller (schema v2 migrates in place; v1 nodes are copied
   as assigned to the role they run).
2. Set `FLEET_ENROLLMENT_TOKENS` if you used role tokens (map each old hash to
   its role).
3. Merge the node changes to `main`. Nodes pull the new agent and `fleet-sync`;
   their targets equal what they run, so nothing switches.
4. Build and publish the new `base` installer. New machines install `base`
   and wait for assignment.

The first boot with `fleet-node-state` records the running role without
wiping (there is no other role's cache yet). Deployments that set
`rotateAgeKey` fail evaluation with a message naming
`secrets.rotateAgeKeyAfter`; remove it and the `age-key-next` secret.

Reporting is best effort throughout: a v1 agent that the v2 controller refuses
(`400`) keeps updating from Git and picks up the v2 agent on its next sync.

**Phase 2** (after every node reports agent version 2): move
`packages/fleet/roles.json` to `"version": 2` by deleting `installerDefault`
and every closure's `installer` flag. It must wait: each node checks the
fetched `roles.json` with the parser of the system it runs, and a version 1
parser refuses version 2, which would stop that node's updates. Run
`bun run roles:sync` afterwards.

During step 3 a node's first desired document is computed from its copied
role and its reported hardware. A `ci-gpu` node whose NVIDIA device is not
detected would be assigned `ci` and reboot into it; check
`hardware.capabilities` on the node pages before merging if you run GPU nodes.

## Operations built on the same model

These follow the principles above (controller records intent, nodes converge and report, nothing is pushed as a command). Each has a normative document under `packages/fleet-controller/docs/`:

- **Operations and audit** ([operations.md](packages/fleet-controller/docs/operations.md)): drain, restart, replace and decommission are state machines whose intent is desired state (`maintenance.restartAfter`, cordon) and whose completion is proven by observed state. Every administrative action lands in the audit log; destructive ones require a typed confirmation checked on the server.
- **Access and configuration safety** ([access-and-config-safety.md](packages/fleet-controller/docs/access-and-config-safety.md)): viewer/admin roles, node credential rotation and immediate revocation, optimistic concurrency, dry-run impact and acknowledgement for settings, and per-node desired-state history.
- **GitHub runners** ([github-runners.md](packages/fleet-controller/docs/github-runners.md)): the GitHub App key lives only on the controller; nodes ask it for short-lived registration tokens. Jobs, runners, orphans and placement are visible in the controller.
- **Issue reporting** ([issue-reporting.md](packages/fleet-controller/docs/issue-reporting.md)), **observability** ([observability.md](packages/fleet-controller/docs/observability.md)) and **installer binding and enrollment grants** ([installer-enrollment.md](packages/fleet-controller/docs/installer-enrollment.md)).
- **Verification** ([verification.md](packages/fleet-controller/docs/verification.md)): requirement-to-test traceability and what is not verified.

## Boundaries

- **Local mode** (no controller) has no approval, recipients endpoint or fleet
  view; `fleet-target` at each machine's console is its assignment source.
  That is the design, not a gap: the controller is the system of record.
