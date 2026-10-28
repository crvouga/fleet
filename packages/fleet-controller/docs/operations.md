# Node operations, audit and destructive actions

Register, drain, restart, replace, decommission and remove nodes from the
dashboard or the JSON API, see their progress, and see who did what.

## Principles

- **Data, never code.** The controller never pushes a command to a node. An
  operation is the controller's **record of intent** plus the progress it can
  **prove from what the node reports**. The intent itself is ordinary desired
  state that the node reads in its next heartbeat response:

  | Operation      | Intent recorded as                                                 | Node does                                                                   |
  | -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
  | `drain`        | node-scope `runners.cordoned = true` (the existing cordon)         | closes runner admission, finishes running jobs                              |
  | `restart`      | node-scope `maintenance.restartAfter = <Unix time of the request>` | drains, waits until idle, reboots once                                      |
  | `replace`      | cordon on the old node; the replacement gets the old node's role   | the old node drains; the replacement converges like any newly assigned node |
  | `decommission` | cordon, then `approval = retired` once drained                     | drains; afterwards its credentials stop working                             |

- **Level-triggered.** Every heartbeat (and a 30 s background sweep) re-reads
  the operation and the node's observed state and takes the same step again.
  Reconciling is idempotent: an unchanged observation writes nothing; a crash,
  a retry or a lost response repeats a step harmlessly. Concurrent reconcilers
  race on a compare-and-swap of the status; the loser changes nothing.
- **Proof, not assumption.** An operation completes only when observed state
  shows it (table below). Every operation is bounded: past its timeout it
  fails with a sentence that says what to do next.

Code: `src/domain/operations.ts` (state machines, invariants),
`src/domain/operations-reconcile.ts` (pure decisions), `src/operations/*`
(effects, storage, audit), `src/routes/admin-operations.ts`,
`src/routes/admin-audit.ts`. Tables: `operations`, `node_lifecycle`,
`audit_log` (schema v3).

## State machines

```
            ┌────────────► cancelled
            │ (cancel)
  pending ──┼────────────► failed        (timeout, node deleted, intent not recordable)
     │      │
     │      └─ in_progress ──► succeeded  (proof observed)
     └────────► in_progress ──► failed
                    └───────► cancelled
```

`succeeded`, `failed` and `cancelled` are final: no transition leaves them
(`canTransition` is false for every target; the store's compare-and-swap
refuses a stale writer). `pending` means the intent is recorded but the node
has not acknowledged it; `in_progress` means it has (its reported
`agent.desiredRevision` equals the controller's current revision, reported
after the request).

| Kind           | `pending` may go to                           | `in_progress` may go to      | Stages (`detail.stage`)           |
| -------------- | --------------------------------------------- | ---------------------------- | --------------------------------- |
| `drain`        | in_progress, failed, cancelled                | succeeded, failed, cancelled | draining                          |
| `restart`      | in_progress, failed, cancelled                | succeeded, failed, cancelled | awaiting-ack, draining, rebooting |
| `replace`      | in_progress, failed, cancelled                | succeeded, failed, cancelled | awaiting-approval, converging     |
| `decommission` | in_progress, **succeeded**, failed, cancelled | succeeded, failed, cancelled | draining, retiring                |

Only a forced decommission of an unreachable node jumps `pending` to
`succeeded` (there is nothing to wait for). A reconcile step that jumps ahead
is persisted hop by hop through the table (`pathTo`).

### What proves completion

| Kind           | Succeeds when                                                                                                                                                                    | Default timeout |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `drain`        | the node reported **after** the request, applied the desired revision that holds the cordon, has **no busy runner slots** and its admission gate is closed (when it reports one) | 6 h             |
| `restart`      | the node reports a **new boot id** whose boot started after the request (clock skew tolerance 120 s); without a boot id at request time, uptime alone is the proof               | 3 h             |
| `decommission` | drained as above, then the node is retired (also: somebody else retired it)                                                                                                      | 6 h             |
| `replace`      | the replacement is **approved**, holds the old node's role and reports `converged`                                                                                               | 14 days         |

`timeoutSeconds` (60 to 2 592 000) may be set per request. A silent node's
operation still times out: the background sweep reconciles every active
operation even when no heartbeat arrives.

## Invariants (`planRequest`, checked before anything is written)

1. Only **approved** nodes can be drained, restarted, replaced or decommissioned (`409 not_approved`).
2. **At most one active operation per node and kind**, atomically with the insert (`409 operation_in_progress`, naming the conflicting operation). A decommission excludes restart and replace, and nothing runs beside a decommission except a drain it adopts.
3. **Restart never reboots a busy node.** The node first closes admission (drain reason `maintenance`) and reboots only when no job marker exists. It reboots at most once per request (durable marker `restart-handled`, plus "this boot began before the request"), so a wrong clock cannot cause a reboot loop. If `reboot.enabled` is off, restart is refused (`409 reboots_disabled`) and the node neither drains nor reboots.
4. **Decommission drains first.** An unreachable (offline) node cannot prove a drain: the request is refused (`409 drain_unprovable`) unless `force: true`, and `force` on a reachable node is refused (`409 force_requires_unreachable`). A forced decommission retires at once and records `force` in the audit entry.
5. **Replace** needs a named replacement that is registered (pending or approved), is not the node itself, is not already used by another active replace, and has no role or the old node's role. A node without a role cannot be replaced (`409 no_role`). Replace never approves a machine: approval stays a separate, audited human decision.
6. **Terminal states are final**; cancelling a finished operation is `409 already_finished`.
7. **Idempotency**: `Idempotency-Key` (1-120 chars of `[A-Za-z0-9._:-]`) replays the stored operation (`200`, `replayed: true`). The same key for a different node or kind is `409 idempotency_conflict`.
8. A restart that **fails or is cancelled withdraws** `maintenance.restartAfter`, so it cannot happen hours later unannounced.
9. A cordon recorded by drain/decommission/replace is **re-applied** at every reconcile while the operation is active (level-triggered); it is removed by `undrain` or `cancel`, never silently.

The invariants are tested table-driven and with 2 000 randomized reconcile
sequences (`test/domain/operations*.test.ts`).

## Destructive confirmation (server side)

`retire`, `delete`, `reject`, `restart`, `replace` and `decommission` need a
**`confirm` value equal to the node's label (display name, else hostname) or
its hostname**, trimmed and case-sensitive. Missing or wrong: `400
confirmation_required` with `expected` and a message naming what to send, no
change, and an audit entry with outcome `denied`. The dashboard shows a typed
confirmation field/dialog; the server enforces the same rule for forms and JSON.
`drain` and `undrain` are reversible and need none.

## API (administrators; `Origin` rules as every admin route)

| Method and path                                                  | Body                                        | Result                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/nodes/:id/drain`                                       | `{ reason?, timeoutSeconds? }`              | `202 { operation }`                                                                                                   |
| `POST /v1/nodes/:id/undrain`                                     | none                                        | `200 { ok, cancelled: [ids], stillCordoned }` (`stillCordoned` is true when a role or fleet setting still cordons it) |
| `POST /v1/nodes/:id/restart`                                     | `{ confirm, timeoutSeconds? }`              | `202 { operation }`                                                                                                   |
| `POST /v1/nodes/:id/replace`                                     | `{ confirm, replacement, timeoutSeconds? }` | `202 { operation }`                                                                                                   |
| `POST /v1/nodes/:id/decommission`                                | `{ confirm, force?, timeoutSeconds? }`      | `202 { operation }` (`succeeded` at once when forced)                                                                 |
| `POST /v1/operations/:id/cancel`                                 | none                                        | `200 { operation }`; returns the node to its previous settings (cordon or restart request removed)                    |
| `GET /v1/operations?node=&kind=&status=&active=1&cursor=&limit=` | -                                           | `{ operations, nextCursor }`, newest first (limit 1-200, default 50)                                                  |
| `GET /v1/operations/:id`                                         | -                                           | `{ operation }`                                                                                                       |
| `GET /v1/audit?kind=&target=&actor=&before=&limit=`              | -                                           | `{ entries, nextBefore }`, newest first, **administrators only**                                                      |

Unknown body keys are `400`. `reject`, `retire` and `DELETE /v1/nodes/:id` now
take `{ confirm }` too. `GET /v1/operations*` is readable by viewers.

An `operation` is `{ id, kind, nodeId, status, requestedBy, requestedAt,
updatedAt, completedAt, attempts, progress, failure, idempotencyKey, detail }`.
`progress` is one public sentence (what the controller can prove right now);
`failure` says what to do. `attempts` counts reconcile passes that changed
desired state. `detail` is kind specific (`stage`, `bootIdAtRequest`,
`restartAfter`, `replacement`, `force`, `timeoutSeconds`) and never holds secrets.

Dashboard: **Operations** (`/operations`: all operations, cancel), **Audit log**
(`/audit`, administrators), and an **Operations** panel on every node page
(Drain, Undrain, Restart, Replace, Decommission with typed confirmation, live
progress). Dashboard forms: `POST /nodes/:id/operations/:kind` and
`POST /operations/:id/cancel`.

## Audit

Every administrative node action writes an `audit_log` row with the actor, the
action (`node.patch`, `node.approve`, `node.reject`, `node.retire`,
`node.delete`, `node.role`, `node.drain`, `node.undrain`, `node.restart`,
`node.replace`, `node.decommission`, `node.recovery.*`, `operation.cancel`,
`operation.<kind>.<status>`), the target and the outcome: `success`, `denied`
(refused: missing confirmation, viewer, invariant) or `failed` (not found,
invalid, could not record). The `via` detail says `dashboard` for form actions.
Reconcile-driven completion is attributed to `controller` with the requester in
`detail`. `detail` never contains credentials, tokens or settings values.

## Node side

`maintenance.restartAfter` (Unix time, same key set as `sync.retryBootAfter`) is
understood by `packages/fleet/scripts/agent.py` (`apply_restart`):

1. Due when the value is set, this boot began before it (from `/proc/uptime`) and
   the durable marker `/nix/fleet-state/agent/restart-handled` does not hold it.
2. `reboot.enabled = false`, or an update holding admission (`update-draining`):
   nothing is drained or rebooted.
3. A CI node launches `fleet-drain` with reason `maintenance` (rate limited to
   every 15 minutes while it has not closed) and waits until the gate is closed
   and no `*/busy` marker exists. Other roles have no jobs to protect.
4. If `reboot.delayMaxSeconds` is set in Fleet settings, the node waits a stable
   per-node offset within that window after the request (the image's 2-hour
   default staggers _updates_ and is not applied to a person pressing Restart).
5. It writes the marker, queues a `maintenance-restart` recovery event and runs
   `systemctl reboot`. If that fails the marker is removed and the next cycle retries.
6. When the request no longer applies (withdrawn or already satisfied by a newer
   boot) the `maintenance` drain reason is released so admission reopens.

## Recovery procedures

- **A node is lost (dead hardware, powered off)**: it is `offline`. Decommission
  is refused without `force` because its drain cannot be proven. Confirm that the
  machine is off or isolated, then `POST .../decommission { confirm, force: true }`:
  it is retired immediately and its credentials stop working. Delete the node
  later (`DELETE`, typed confirmation) to forget it and its history. If it was a CI
  node, remove its stale runners in GitHub; to bring capacity back, install a new
  machine, wait for it to register, then **replace** (or approve it and assign the
  same role).
- **A node is compromised or its secret leaked**: first cut its access, then
  rebuild. Use credential revocation (see credential rotation/revocation in
  [access-and-config-safety.md](access-and-config-safety.md)), or **decommission**
  with `force` when it is unreachable, which retires it. Rotate any role secret it
  could decrypt (its age recipient is removed from the SOPS files by the operator,
  see ARCHITECTURE.md "Secrets"). Reinstall the hardware: a reinstalled machine
  keeps its id, registers as pending (or approved with an enrollment token) and
  resumes its stored role once approved. Review `GET /v1/audit?target=<id>`.
- **A restart did not happen** (`failed`: timeout): the request was withdrawn, so
  nothing fires later. Check power and network, `reboot.enabled`, and whether a
  job is stuck on the node page; then ask again. A node that shows `pending` for a
  long time never acknowledged the request: it is not reporting or not applying
  settings (see its readiness issues).
- **A drain is stuck** (`in_progress`, busy slots never reach zero): look at the busy
  slots on the node page, cancel the job in GitHub or wait. `cancel`/`undrain`
  return the node to service; the failed operation leaves the cordon in place on
  purpose, so a half-drained node does not silently take jobs again.
- **A decommission failed (drain timeout)**: the node is still approved and
  cordoned. Fix or end the stuck job and decommission again, or `undrain`.
- **A replacement never converges**: read the progress sentence: it quotes the
  replacement's own blocking issue (for example a missing SOPS recipient). Fix it
  in Git, or cancel the replace (the old node leaves the cordon).
- **A controller outage during an operation**: nothing is lost. Intent is stored
  as settings; on recovery the next heartbeat or sweep re-evaluates from observed
  state. An operation that spent its whole timeout during the outage fails and can
  be repeated.

## Limits

- Replace does not copy node-scope settings or runner assignments from the old node.
- Cancelling a decommission or replace removes the cordon (the previous settings), also when an earlier manual cordon on the same node scope existed.
- Restart relies on the node's clock being roughly right (120 s tolerance for the proof; the node also keeps a durable marker so a wrong clock cannot loop).
