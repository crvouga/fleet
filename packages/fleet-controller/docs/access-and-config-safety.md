# Access, credentials and configuration safety

This page is the contract for four things a person or a script can break:
who may change the fleet (roles), how a node proves who it is (credential
rotation and revocation), how the admin token is replaced, and how settings are
changed without surprising anyone (concurrency, impact, history).

## 1. Roles

Two roles exist. A person's role is `allowed_emails.role`; the admin Bearer
token is always an admin.

| Capability                                                          | viewer | admin |
| ------------------------------------------------------------------- | :----: | :---: |
| Every dashboard page; every `GET /v1/*`                             |  yes   |  yes  |
| See the alert webhook URL                                           | masked |  yes  |
| Any `POST`, `PUT`, `PATCH`, `DELETE` (dashboard forms and JSON API) |   no   |  yes  |
| Approve, reject, retire, delete, assign roles, edit nodes           |   no   |  yes  |
| Save, preview or roll back settings                                 |   no   |  yes  |
| Rotate or revoke a node credential                                  |   no   |  yes  |
| Manage the allowlist and roles (`/access`)                          |  read  |  yes  |

- A viewer's write is refused `403 {"error":"forbidden","message":"Your account
is a viewer: …"}` and recorded in the audit log with `outcome: "denied"` and
  `actorRole: "viewer"`. The dashboard shows the same message.
- A cross-site write with a session cookie is still `403 cross_origin` first
  (CSRF). The Bearer token needs no Origin.
- The role is read from the database on every request. Demoting or removing
  someone applies to their open session at once.
- **The last admin cannot be removed or demoted**, by anyone, including
  themselves (`409`). Initial access is owner-managed:
  `bun run access:allow person@example.org [admin|viewer]` (default `admin`).
  The same command promotes or demotes someone already listed, which is how the
  owner repairs access. Browser login is unchanged: validated OIDC code with
  S256 PKCE; the role never comes from the identity provider.
- New routes get this for free: `adminRoute(deps, handler)` requires an admin for
  every method except `GET`, `HEAD` and `OPTIONS`. A route that is read-only
  despite its method says `adminRoute(deps, handler, { access: 'read' })`.
  Dashboard forms use `action(deps, handler)` from `src/ui/routes/guard.ts`,
  which enforces the same rule. A handler that decides for itself calls
  `requireAdmin(deps, c, actor)`.

## 2. Node credential rotation (level-triggered)

A node's secret is 32 random bytes (hex) that only its sha256 leaves the node.
Rotation never needs the node to be reachable at a particular moment and every
step may be repeated.

```
admin                 controller                          node (agent every heartbeat)
  | POST /v1/nodes/:id/rotate-credential                          |
  |-------------------->| rotate_requested_at = now (idempotent)  |
  |                     |<------- POST /v1/heartbeat -------------|
  |                     |-- 200 { ..., credential:{rotate:true} }->|
  |                     |      node writes node.secret.next (fsync) FIRST
  |                     |<-- POST /v1/credential/rotate ----------|  Bearer <id>.<CURRENT>
  |                     |      { nextSecretHash: sha256(next) }   |
  |                     | next_secret_hash = it (current AND next work)
  |                     |-- 200 { ok, rotationPending:true } ----->|
  |                     |      node atomically replaces node.secret with next,
  |                     |      deletes node.secret.next
  |                     |<------- POST /v1/heartbeat -------------|  Bearer <id>.<NEXT>
  |                     | first auth with next: promote (current := next,
  |                     |   next := null, rotate_requested_at := null, rotated_at := now),
  |                     |   event credential_rotated + audit credential.rotated
  |                     |-- 200 (no credential hint) ------------->|
```

State, per node (`nodes.secret_hash` plus `node_lifecycle`):

```
 idle --admin request--> requested --node offers next--> pending --first auth with next--> idle (rotated_at set)
   ^                         |                              |
   |                         +---------- re-register -------+--> idle (the new registration secret wins)
 any state --revoke--> revoked --node registers again--> idle, approval forced to pending
```

- `POST /v1/nodes/:id/rotate-credential` (admin, `202 { ok, credential }`).
  Idempotent: asking again while a rotation is in flight changes nothing. `409
credential_revoked` for a revoked node. Audit `credential.rotate_request`;
  event `credential_rotation_requested`.
- Heartbeat answer gains `credential: { "rotate": true }` while a rotation is
  requested and the node is not revoked, and only then. It is additive and
  **not** part of the desired document, so it never changes `desired.revision`.
- `POST /v1/credential/rotate` (node, Bearer `<id>.<current secret>`), body
  `{ "nextSecretHash": "<64 hex sha256>" }`:
  `200 { ok: true, rotationPending: true }`; the same hash again is a no-op; a
  different hash replaces the pending one (safe: a node that held the discarded
  one would already have used it and been promoted). `400` for a malformed hash
  or the current secret's hash, `409 rotation_not_requested` when no request is
  open, `401` for a wrong or revoked credential. Audit `credential.rotate_submit`
  (`failed` for refusals).
- **Grace is bounded.** The next secret is honoured for 72 hours from the
  admin's request, refreshed when the node offers a different hash. After that
  it is refused (the old secret still works) and the open request lets the node
  offer again.
- `GET /v1/nodes/:id/credential` shows `rotateRequestedAt`, `rotationPending`,
  `rotatedAt`, `revokedAt`. It never shows a hash.

Node side (`packages/fleet/scripts/credential_rotation.py`, called by
`agent.py` after each successful heartbeat):

| Where it stops                                         | What is on disk                  | What happens next                                                              |
| ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------ |
| Before the offer reaches the controller                | old secret + `node.secret.next`  | Next heartbeat: same next secret is offered again.                             |
| Offer stored, answer lost                              | old secret + `node.secret.next`  | Same: the identical hash is idempotent, then the node swaps.                   |
| After the swap, before the first use                   | new secret (+ maybe a next file) | The node authenticates with the new secret; the controller already accepts it. |
| Next file equals the current secret (crash after swap) | new secret + stale file          | Stale file is deleted, never offered.                                          |
| Controller restarts or is unreachable mid-way          | either of the above              | Heartbeats keep failing softly; resumes when it answers.                       |
| Admin asks while the node is offline                   | nothing                          | Rotates on its first heartbeat after it returns.                               |
| Node re-registers during a rotation                    | new registration secret          | Pending rotation is cleared; the registration secret is the credential.        |

The agent updates its in-memory secret together with the file, so the existing
"secret changed on disk, register again" rule does not fire.

## 3. Revoking a lost or compromised node

`POST /v1/nodes/:id/revoke-credential` (admin) with
`{ "confirm": "<node name>", "reason": "optional, 200 chars" }`. The node's secret
hash is replaced by an unusable value (`node_lifecycle.revoked_at` set), so its
next request is `401` at once. Idempotent. Audit `credential.revoke` (a wrong
`confirm` is `400 confirmation_required` and audited as denied); event
`credential_revoked` (warn). The node page has the same button.

A revoked node that registers again, **even with a valid enrollment token**, is
forced to `pending` with no token role; its revocation is then cleared and a
person decides (event `credential_reregistered`, warn).

### Runbook

_A machine is lost, stolen or suspected compromised._

1. **Revoke** its credential (node page, or the endpoint above). It is locked out
   immediately.
2. **Reject** the node (`POST /v1/nodes/:id/reject`) if it must never come back:
   a rejected node stays rejected even if it registers again.
3. If it carried secrets: remove its age recipient from every SOPS file it could
   read in Git, re-encrypt, and rotate those secrets. Revoking does not unread
   what the machine already holds.
4. Revoke what its work could reach: runner registrations, deploy keys, any
   enrollment token it held (`FLEET_ENROLLMENT_TOKENS` entries are shared; rotate
   them if one may have leaked).
5. To bring a rebuilt machine back: reinstall, let it register (it arrives
   `pending`), check hostname, address and hardware match the machine you expect,
   then approve.

_Only the controller's copy of a secret is suspect_ (for example a database
backup leaked): hashes alone do not authenticate a node, but rotate every
credential anyway (`rotate-credential` for each node).

## 4. Admin token rotation without downtime

1. Generate a new token: `openssl rand -hex 32`.
2. Set `FLEET_ADMIN_TOKEN_NEXT=<new>` next to the existing `FLEET_ADMIN_TOKEN`
   and restart. Both tokens are accepted (constant-time comparison). The
   controller refuses to start if NEXT is shorter than 32 characters, has
   whitespace or equals the current token.
3. Move every script and CI job to the new token.
4. Set `FLEET_ADMIN_TOKEN=<new>`, remove `FLEET_ADMIN_TOKEN_NEXT`, restart. The
   old token stops working.

The audit actor is `admin-token` for either token.

## 5. Settings: concurrency, impact and history

Each settings scope (`fleet`, `role:<role>`, `node:<id>`) has a `revision`:
`0` until first written, `+1` on every write. `GET /v1/settings/:scope` returns it
(and `ETag: "<revision>"`).

**Writing** `PUT /v1/settings/:scope`:

| Request                                                    | Result                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| New scope (revision 0), no precondition                    | Accepted. Two simultaneous first writers: one `200`, one `409`.             |
| Existing scope, no `If-Match` / `expectedRevision`         | `428 precondition_required` with `currentRevision`. Nothing is written.     |
| `If-Match: 3` (or `"3"`) or body `expectedRevision`, stale | `409 conflict` with `currentRevision`, `expectedRevision`. Nothing written. |
| Matching revision                                          | `200`, new `revision`, `ETag`, plus `changedNodes` and `issues`.            |

The body is the document itself, or an envelope
`{ "value": {…}, "expectedRevision": 3, "acknowledge": ["code"] }`. The compare
and the write are one transaction. The dashboard forms carry the revision as a
hidden field; a stale form is refused with a banner, keeps the person's edit in
the raw JSON editor and keeps the old revision so saving again cannot overwrite.

**Dry run**: add `?dryRun=1`. Nothing is written (no settings row, no history, no
desired history). The answer is `200`:

```json
{
  "dryRun": true,
  "scope": "fleet",
  "revision": 3,
  "wouldWrite": false,
  "conflict": false,
  "preconditionMissing": false,
  "acknowledgementRequired": ["fleet_sync_paused"],
  "totalNodes": 12,
  "changedNodes": [
    {
      "nodeId": "…",
      "label": "ci-a1b2",
      "fromRevision": "…",
      "toRevision": "…",
      "fromClosure": "ci",
      "toClosure": "ci"
    }
  ],
  "issues": [{ "code": "fleet_sync_paused", "message": "…", "blocking": true }]
}
```

A dry run is a `PUT`, so it needs an admin like any write. The dashboard form's
"Preview impact" button does the same.

**Impact rules** (`src/domain/settings-impact.ts`, pure). The proposed document is
merged for every node that is not rejected or retired and compared with today's
desired revision. A _blocking_ issue is refused `422 unsafe_change` unless the
request acknowledges its code (`acknowledge` in the envelope, or
`X-Fleet-Acknowledge: a,b`; a dashboard checkbox per warning). It fires only when
the change **introduces** the condition, so saving an unchanged document never
raises it.

| Code                     | Blocking | Fires when the change makes it true for…                                   |
| ------------------------ | :------: | -------------------------------------------------------------------------- |
| `fleet_sync_paused`      |   yes    | every approved node: `sync.paused`                                         |
| `ci_runners_cordoned`    |   yes    | every approved `ci` node: `runners.cordoned`                               |
| `ci_runners_disabled`    |   yes    | every approved `ci` node: `runners.enabled = false`                        |
| `ci_capacity_zero`       |   yes    | every approved `ci` node: `capacity.slotMax <= 0` (also refused by schema) |
| `ci_capacity_throttled`  |   yes    | every approved `ci` node: `capacity.slotMax = 1`                           |
| `fleet_reboot_disabled`  |   yes    | every approved node: `reboot.enabled = false`                              |
| `reboot_delay_excessive` |   yes    | any node: `reboot.delayMaxSeconds` above 3600 (an hour)                    |
| `fleet_wide_change`      |    no    | every node receives a new desired document (information only)              |

Validation errors (`400 invalid_settings`) still come first. Staged or canary
rollout is **not** built: the safety net is dry run, acknowledgement, history and
rollback.

**Audit.** Every write and restore is recorded: `settings.put` /
`settings.restore`, `targetKind: "settings"`, `targetId` the scope, `detail`
`{ fromRevision, toRevision, changedNodes, acknowledged, restoredFrom? }`. Refusals
(conflict, unacknowledged warnings) are `outcome: "failed"` with the reason.
Settings values are never copied into the audit log.

**Rollback.** `POST /v1/settings/:scope/restore` with
`{ "historyId": 12, "expectedRevision": 4, "acknowledge": [] }` (`?dryRun=1`
supported) writes an earlier version again, under the same concurrency and impact
rules, as a new history entry. Its author is stored as
`<actor> (rollback to #12)`, which the history views show as a **Rollback** badge.
The dashboard button is "Roll back to this version".

**Desired history.** Whenever a node is told a desired document whose revision
differs from the newest one recorded, a row is added to `desired_history`
(revision, the document, time, cause). Writers: the heartbeat handler (cause
derived from the previous document: `initial`, `role`, `closure`, `settings`,
combinations), and a settings write for every node whose revision it changes
(`settings:<scope>`, together with the document it replaced if none was
recorded). Duplicates are impossible (compared inside the write transaction), and
only the newest 100 rows per node are kept. A role change made by a person is
recorded at the node's next heartbeat. `GET /v1/nodes/:id/desired-history?limit=`
(1 to 100, default 50) returns `{ nodeId, current, history }`; each row has
`revertsTo` set to the older row it returned to when a revision recurs (a
rollback). The node page shows the same list.

## 6. Where things live

- Roles: `src/auth/roles.ts`, `src/routes/guards.ts`, `src/db/access-store.ts`.
- Rotation: `src/domain/credential-rotation.ts` (pure state machine),
  `src/db/credential-*.ts`, `src/routes/admin-credentials.ts`,
  `packages/fleet/scripts/credential_rotation.py`.
- Settings: `src/routes/settings-change.ts` (the one write path),
  `src/domain/settings-impact.ts`, `src/routes/admin-settings.ts`.
- Desired history: `src/domain/desired-history.ts`,
  `src/db/desired-history-queries.ts`.
- Tests: `test/controller/{rbac,credential-rotation,settings-safety,desired-history}.test.ts`,
  `test/domain/settings-impact.test.ts`, `test/auth/access-roles.test.ts`,
  `test/ui/access-safety.test.ts`, `packages/fleet/tests/test_credential_rotation.py`.

## Allowlist API (`/v1/access`)

For hosts where nobody can run `bun run access:allow` beside the service (and whenever the service is running: the CLI writes the local file, so it refuses while an instance owns the replica, when the owner record cannot be read, or when the local file is not the authoritative replica), the admin token (or a signed-in administrator) manages the browser allowlist over HTTP:

- `GET /v1/access` lists allowed emails (administrators only; a viewer gets 403 and a denied audit row).
- `PUT /v1/access/:email` allows an address as an administrator. Allowing an existing address changes nothing.
- `DELETE /v1/access/:email` removes one. The last administrator cannot be removed (409 `cannot_revoke`).

The access store writes `access.allow` and `access.revoke` audit rows in the same transaction as the change; a refused revoke leaves an `access.revoke` row with outcome `failed`. Use the `/access` page to grant the `viewer` role.
