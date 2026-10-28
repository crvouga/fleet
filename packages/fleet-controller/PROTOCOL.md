# Fleet controller protocol (v2)

The contract between `packages/fleet-controller` (the controller), `packages/fleet/scripts/agent.py` (the node agent) and the dashboard. TypeScript types are in `src/types.ts`; configuration keys are in `src/config/schema.ts`. If this file and the code disagree, fix the code or this file in the same commit.

Base URL: `https://fleet.example.com`. All bodies are JSON (`Content-Type: application/json`). Times are ISO 8601 UTC. Errors are `{ "error": "<code>", "message": "<what happened and what to do>" }`.

## Principles

- **The controller owns assignment.** Each node's desired state (role, closure, settings) lives in the controller. A node never chooses its own role; what it reports is observed state and never changes the assignment. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
- **Data, never code.** The controller names a role and a closure from the registry that Git built, plus typed settings. A node only builds closures defined by the `roles.json` of the revision it fetched from its configured repository, and only interprets the typed keys in `FleetConfig`. The controller cannot run a command, choose code outside the reviewed repository, obtain a private age key, add a SOPS recipient, grant root SSH access, or skip drain, health checks and rollback. It **can** change a node's role among the roles Git defines (and so which reviewed closure it runs, and which role secrets it could decrypt if the operator already made it a recipient), and grant unprivileged `dev` logins on devboxes through `devbox.authorizedKeys`. Credentials stay gated by the operator's reviewed Git change.
- **The fleet works without the controller.** A node that cannot reach the controller keeps its last configuration (cached on disk) and its built-in defaults. Reporting is best effort and never blocks updates (`fleet-sync`).
- **One controller owns one SQLite database.** Bun's built-in SQLite uses a transactional schema initialized automatically at startup. The default launcher restores and replicates local SQLite through Litestream to S3-compatible storage. No external migration service is needed.

## Identity and credentials

| Credential     | Held by                                                                                | Used for                                                |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| node id        | derived from hardware (never secret)                                                   | names the node                                          |
| node secret    | the node (`/nix/fleet-state/agent/node.secret`, 0600)                                  | `Authorization: Bearer <id>.<secret>` after registering |
| enroll token   | optional, written by the installer to `/nix/fleet-state/agent/enrollment-token` (0600) | register without waiting for a person                   |
| admin token    | scripts and CI (`FLEET_ADMIN_TOKEN`)                                                   | `Authorization: Bearer <token>` on admin routes         |
| session cookie | a person signed in to the dashboard                                                    | the dashboard and admin routes                          |

- **Node id** is the lowercase sha256 hex (64 chars) of the machine's stable hardware material, exactly the digest whose first four hex digits are the node's hostname suffix (`ci-a3f9` -> id starts `a3f9`). It is `/run/fleet/node` field `machine_id`.
- The controller stores `sha256(node secret)` only. A node secret is 32 random bytes, hex encoded (64 chars).
- `FLEET_ENROLLMENT_TOKENS` is a JSON array (at most 16) of `{ "sha256": "<64 hex>", "role": "<active role>" | null }`. The controller compares `sha256(presented token)` with every entry in constant time, without stopping at a match. Tokens are 8-512 characters of `[A-Za-z0-9._-]`. `FLEET_ROLE_TOKEN_HASHES` is refused at startup.
- A node's age identity (`/nix/fleet-state/secrets/age.key`) never leaves it. The controller stores only the public `ageRecipient` the node reports.
- Browser authentication uses the deployment-injected standard OIDC provider directly: OIDC code + S256 PKCE, state, nonce and signature/issuer/audience/expiry verification. The verified email must appear in `fleet.allowed_emails`. Fleet uses an opaque, database-backed session, rechecks access on authorized requests and invalidates it on sign-out. The initial allowlist is operator-managed. Authentication adapters and their HTTP transport are injected at controller composition; no shared relay or provider-specific account is required.
- `/not-allowed` shows a denied signed-in account and permits same-origin sign-out without requiring allowlist access. `/access` manages allowed emails for existing allowed administrators, auditing changes and protecting the final allowed address. Initial access is populated by the explicit owner CLI command. See README for storage and exact callback configuration.

## Node endpoints

### `POST /v1/enrollment/check` (enrollment token)

Read-only, rate limited like registration. Send `{ "enrollmentToken": "..." }`
over HTTPS. `200 { "ok": true, "role": "ci" | null }` proves the token matches
`FLEET_ENROLLMENT_TOKENS`; `role` is the role it would assign to a node that has
none. It is informational: the installer never compares it with anything. A
token that does not match is `401 { "error": "enrollment_not_ready" }`; a
missing or malformed token is `400`. No node, secret or event is created. The
live installer additionally registers the actual hardware and requires
`approved` before erasing; an explicitly rejected identity cannot silently
proceed.

The optional heartbeat `readiness` object contains up to 12 public diagnostic
issues, each at most 500 characters. Missing means unknown, not ready. An empty
list means the installed agent verified the update timer and current revision's
cache/sync check, recovery credential, and (for CI) GitHub runner availability.
The console combines it with current membership/connectivity and failed units;
an online heartbeat alone does not establish readiness. Bootstrap reports use
the same protocol and private node credential, copied into the installed system,
with a nonempty installation issue until the installed agent takes over.

### `GET /v1/enrollment/status` (`Authorization: Bearer <id>.<secret>`)

`200 { "nodeId", "status", "role": string | null }`: the node's approval and
assigned role, without registering again. `401`/`403` as for the heartbeat.

### `POST /v1/nodes/register` (no credential)

Rate limited per address. Idempotent: calling it again for the same id replaces the stored secret hash (a reinstall has a new secret). A node does not name a role.

```json
{
  "nodeId": "<64 hex>",
  "hostname": "node-a3f9",
  "secret": "<64 hex, new random>",
  "enrollmentToken": "<optional>"
}
```

`201`/`200`:

```json
{ "status": "approved", "heartbeatIntervalSeconds": 60, "role": "ci" }
```

- `role` and `roleToken` sent by older agents are ignored, never stored and never an error.
- A valid `enrollmentToken` -> `approved` immediately, `enrolledVia: "enrollment-token"`. If the token's entry names a role and the node has no assigned role, that role is assigned (`role_assigned`, actor `enrollment-token`).
- Otherwise `status: "pending"`, `enrolledVia: "hello"`; a person approves in the dashboard, optionally choosing the role. The node keeps reporting while pending; the controller stores its facts so the person can see what they are approving.
- Registration never clears or replaces an assigned role. A reinstalled machine keeps its hardware id, so its stored role applies again once it is approved.
- A node that a person rejected stays `rejected`; a retired node that registers again becomes pending (or approved with a valid enrollment token).
- `role` in the response is the assigned role, or `null`.
- `400 invalid_request`, `429 rate_limited`.

### `POST /v1/heartbeat` (`Authorization: Bearer <id>.<secret>`)

Body: `HeartbeatBody` (`src/types.ts`), protocol `v: 2`. Send every `heartbeat.intervalSeconds` (default 60) and once at boot. Every field below `role` that describes the machine is **observed** state: what the node runs and has, never what it should. Example:

```json
{
  "v": 2,
  "nodeId": "<64 hex>",
  "role": "ci",
  "closure": "ci-gpu",
  "hostname": "ci-a3f9",
  "hardware": { "capabilities": ["gpu"] },
  "ageRecipient": "age1...",
  "capabilities": ["gpu"],
  "revision": "9f3c2a1e...",
  "bootId": "5b0f...",
  "uptimeSeconds": 86400,
  "kernel": "6.12.30",
  "arch": "x86_64",
  "cpu": { "cores": 16, "model": "AMD Ryzen 9 9955HX" },
  "memory": { "totalMiB": 63000, "availableMiB": 41000 },
  "load1": 0.42,
  "disk": { "nixUsedPercent": 37, "bootUsedPercent": 12 },
  "addresses": ["192.168.1.20"],
  "sync": { "rolledBack": false, "healthFailure": null, "paused": false },
  "failedUnits": [],
  "readiness": { "issues": [] },
  "runners": { "slots": 4, "busy": 1 },
  "agent": { "version": "2", "desiredRevision": "0123456789abcdef" },
  "reconcile": { "phase": "converged", "issues": [] },
  "events": [
    {
      "kind": "boot",
      "severity": "info",
      "message": "node started",
      "key": "boot:5b0f..."
    }
  ],
  "recovery": {
    "boot": {
      "previousClean": null,
      "previousEndedAt": null,
      "uncleanOfLast": [0, 0]
    },
    "quarantine": null,
    "gate": { "closed": false, "reasons": [] },
    "outbox": 0
  }
}
```

- `role`: the role of the running closure (`/etc/fleet/node.conf`): `"base"` or a role in the registry.
- `closure`: the flake attribute of the running closure: `"base"` or `[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,16}){0,4}`.
- `hardware.capabilities` (optional): what the hardware has, independent of the closure. Known values: `gpu`. Unknown values are dropped, not errors.
- `ageRecipient` (optional): the node's own age public key, `^age1[02-9ac-hj-np-z]{58}$`. Never a private key.
- `ageRecipientNext` (optional): while an identity rotation is pending, the public key of the node's next age identity, with the same rule as `ageRecipient`. Absent otherwise.
- `agent.desiredRevision`: the revision of the desired document the agent last accepted and applied (16 hex), or `null`.
- `reconcile` (optional): `{ phase, issues }` from the node's own loop. `phase` is `converged`, `progressing` or `blocked`; `issues` holds at most 8 public strings of at most 500 characters.
- A body with any other `v` (a v1 agent) is `400 { "error": "unsupported_version" }` and nothing is stored. The node keeps updating from Git and picks up the v2 agent on its next sync.

Response `200`:

```json
{
  "ok": true,
  "status": "approved",
  "serverTime": "2026-10-14T12:00:00.000Z",
  "desired": {
    "revision": "<16 hex>",
    "role": "ci",
    "closure": "ci-gpu",
    "values": { "sync": { "paused": false } }
  }
}
```

- `desired` is present only when `agent.desiredRevision` differs from the controller's current revision. The agent persists it, applies the settings, writes its target, and reports the new revision next time.
- Not approved (`pending`): `{ "role": null, "closure": null, "values": { "heartbeat": { "intervalSeconds": n } } }`. `closure: null` means keep the running system.
- Approved without a role: `{ "role": null, "closure": "base", values }`.
- Approved with role R: `{ "role": R, "closure": closureFor(R, hardware.capabilities), values }`. `closureFor` takes, in registry order (`CLOSURES` in `src/types.ts`), the first closure `R-<cap>[-<cap>...]` whose every suffix part is in the reported capabilities; else `R`.
- `values` is the merge of `fleet`, `role:<assigned role>` and `node:<id>` (no role scope when unassigned), without `alerts`. `devbox.authorizedKeys` (at most 16 distinct OpenSSH public keys: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, `sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com` or `ssh-rsa`, an optional plain comment, no options prefix, no newline) grants the unprivileged `dev` login only while the node runs the devbox role.
- `secrets.rotateAgeKeyAfter` (Unix time, integer 0-4102444800, any scope) asks for an identity rotation: a node whose age identity was created before then generates a next identity and reports it as `ageRecipientNext`. It promotes it to `ageRecipient` once its role's SOPS file lists the next recipient. The node page's **Rotate age identity** sets it to now on the node scope (`POST /nodes/:id/recovery/rotate-age-key`, recorded in settings history).
- `revision` is the first 16 hex characters of the sha256 of the canonical (sorted-key) JSON of `{ closure, role, values }`. A change of role, closure or any value changes it.
- `401 unauthorized` for an unknown id or wrong secret (the agent re-registers). `403 rejected`/`retired` for those states (the agent backs off to hourly).
- The body's `nodeId` must equal the credential's id. `events` is at most 20 entries, `message` at most 500 chars. Anything else over limits is `400`.
- The controller stores `hostname`, `revision` and the observed fields from the body. It never trusts the body for approval, labels or the assigned role.
- An event may carry `key` (`[A-Za-z0-9:._-]{1,120}`), `at` (the node's UTC time, `YYYY-MM-DDTHH:MM:SSZ`) and `data` (up to 16 flat scalar fields, strings cut at 300 characters). An event whose `key` this node already reported is not stored again, so a retried heartbeat cannot record it twice; `key` and `at` are stored as `data.key` and `data.occurredAt`. Recovery events (`unclean-shutdown`, `job-interrupted`, `update-quarantined`, `gate-reopened`) come from the node's durable outbox (`packages/fleet/scripts/recovery.py`) and are resent until a heartbeat carrying them is accepted.
- `recovery` (optional) is what the node remembers across power loss (the example is a first boot: `previousClean` and `previousEndedAt` are null until a boot has ended): whether the previous boot shut down cleanly, a quarantined kernel, why runner admission is closed, and how many recovery events still wait to be delivered. See `packages/fleet/docs/resilience.md`.

Convergence is computed, never stored: a node is **converged** when its
observed closure equals the desired closure (any closure when that is `null`),
`agent.desiredRevision` equals the current revision and it reports
`reconcile.phase: "converged"`. It is `blocked` when the node reports so,
`unknown` before its first v2 report, else `progressing`.

### `POST /v1/retire` (`Authorization: Bearer <id>.<secret>`)

Sent by `fleet-node remove`. Marks the node `retired`, records an event, and stops "offline" notices for it. `200 { "ok": true }`.

## Admin endpoints (Bearer admin token or session cookie)

State-changing browser requests also require a same-origin `Origin` header (CSRF).

| Method and path                                 | Purpose                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/nodes`                                 | All nodes as `NodeView` (status, label, age), newest report first                                                                                                             |
| `GET /v1/nodes/:id`                             | One node, plus `heartbeats` (last 24 h) and its resolved `config`                                                                                                             |
| `PATCH /v1/nodes/:id`                           | `{ displayName?, note?, labels?, role? }`; `role` is an active role or `null` (unassign)                                                                                      |
| `POST /v1/nodes/:id/approve`                    | pending -> approved; optional JSON body `{ "role" }` assigns the role in the same request                                                                                     |
| `POST /v1/nodes/:id/reject`                     | -> rejected                                                                                                                                                                   |
| `POST /v1/nodes/:id/retire`                     | -> retired                                                                                                                                                                    |
| `DELETE /v1/nodes/:id`                          | forget the node and its history (events keep its label)                                                                                                                       |
| `GET /v1/recipients`                            | age recipients by assigned role, for re-encrypting role secrets                                                                                                               |
| `GET /v1/summary`                               | `FleetSummary`                                                                                                                                                                |
| `GET /v1/events?node=&severity=&before=&limit=` | events, newest first                                                                                                                                                          |
| `GET /v1/settings`                              | every stored scope                                                                                                                                                            |
| `GET /v1/settings/:scope`                       | `fleet`, `role:ci`, `node:<id>`; plus `effective` for node scopes                                                                                                             |
| `PUT /v1/settings/:scope`                       | replace a scope's document (validated; unknown keys rejected); appends history                                                                                                |
| `GET /v1/settings/:scope/history`               | who changed what                                                                                                                                                              |
| `GET /metrics`                                  | Prometheus text: `fleet_nodes{status,role}`, `fleet_node_up{node,role}`, `fleet_node_converged{node,role}`, `fleet_node_last_seen_seconds{node}`, `fleet_runner_slots{state}` |

## Public endpoints

- `GET /health` - `200 { "ok": true }` when the process is up and the database can read the required heartbeat schema; `503` otherwise. Used by operator monitoring.
- `GET /assets/app.css` - the compiled stylesheet.

## Dashboard (cookie session)

`GET /login` (configured OIDC sign-in), `GET /auth/login`, `GET /auth/callback`, `GET /not-allowed`, `POST /logout`, `GET /access` and `POST /access` (allowed administrators only); `POST /login` returns 410 and never creates a session; `GET /` fleet overview; `GET /nodes`, `GET /nodes/:id`; `GET /pending`; `GET /events`; `GET /settings`, `GET /settings/:scope`, `POST /settings/:scope`; `GET /ui/fleet` (an HTML fragment of the overview for auto refresh).

## Background work (inside the controller process)

- Every 30 s: nodes `approved`, silent longer than `alerts.offlineAfterSeconds` (default 300) and not yet announced get an `offline` event (severity `error`), `offline_notified_at`, and a webhook POST if `alerts.webhookUrl` is set. A node that reports again gets a `recovered` event and the notice is cleared. One outage is one notice.
- Every hour: heartbeat history older than 7 days is deleted. Events and settings history are kept.

## Limits

Request bodies are capped at 64 KiB. `register` and `login` are limited per remote address. Dashboard pages never show the node secret hash or any token.

## Controller behavior (as implemented)

Details the sections above leave open. `test/controller/**` and `test/db/**` pin every line.

### Environment

Storage and deployment settings are documented in [the configuration guide](../../CONFIGURATION.md). The supported entry point is `bun run start`. Litestream requires S3-compatible credentials; the only supported deployment is a single native node. `FLEET_ADMIN_TOKEN` requires at least 32 characters. `FLEET_ENROLLMENT_TOKENS` defaults to `[]`; `FLEET_ROLE_TOKEN_HASHES` stops startup and names its replacement. Browser login uses `FLEET_OIDC_ISSUER`, `FLEET_OIDC_CLIENT_ID` and `FLEET_PUBLIC_ORIGIN` as a complete set. A bad environment stops the process at boot, naming variables and never values.

### Registration and approval

- Registering again replaces the secret. A node that was `approved` and registers without a valid enrollment token goes back to `pending` (a reinstall must be approved again, and nobody who learns a node id can take over an approved node silently). With a valid token it stays `approved`. `rejected` always stays `rejected`; `retired` becomes `pending` or, with the token, `approved`. The assigned role is kept in every case.
- An `enrollmentToken` that does not match is not an error: the node is simply `pending`. A malformed one is `400`.
- `403 rejected` / `403 retired` on heartbeat and retire are answered only to a caller that holds the node's secret; anyone else gets `401`. A retired node may call `POST /v1/retire` again (`200`).
- `register` is limited to 20 per minute per address, `POST /login` to 10 per five minutes. The address is `cf-connecting-ip`, else the first `x-forwarded-for` entry, else the socket. Refusals are `429 { error: "rate_limited", retryAfterSeconds }` with `Retry-After`.

### Heartbeat

- Unknown keys in the body are ignored and never stored (a newer agent does not break an older controller). Types, ranges and sizes are checked; every problem is returned in `errors`.
- `hostname` and `revision` are taken from the body; `role`, `closure`, `hardware`, `ageRecipient`, `reconcile` and `agent.desiredRevision` are stored as observed state (`observedRole`, `observedClosure`, `hardware`, `ageRecipient`, `reconcile`, `appliedRevision`). A heartbeat **never** writes the assigned role. The stored `facts` are the body without `events`; `ageRecipientNext` is kept only there (no column).
- The controller writes derived events, once per change and only for `approved` nodes: `boot` (new `bootId`, unless the agent sent its own `boot`), `revision`, `rollback` / `rollback_cleared`, `units_failed` / `units_recovered` (only the units that changed), `disk_high` / `disk_ok` (per mount, at `disk.alertPercent`, default 90), `role_converged` (the observed role became the assigned role, or `base` when unassigned), `reconcile_blocked` (the node's phase became `blocked`; the message carries the first issue) and `recovered` (first report after an `offline` notice). The first report is a baseline and announces none of these.
- Registration and admin actions write `registered`, `reregistered`, `approved`, `rejected`, `retired`, `pending`, `node_updated`, `node_deleted` and `role_assigned` (`data: { role, previous, actor }`, written only when the assignment changes).

### Controller administration endpoints

- Bodies: `PATCH` takes `displayName` (80 chars), `note` (1000), `labels` (16 distinct, `[A-Za-z0-9_.:-]{1,50}`) and `role` (an active role, or `null` to unassign; a retired role cannot be assigned); `null` or blank clears text. Approve takes an empty body or `{ "role" }` with the same rule; the role is checked before anything changes. `PUT /v1/settings/:scope` takes the document itself; errors are `400 { error: "invalid_settings", errors: [...] }`.
- Responses: `{ nodes }`, `{ node, heartbeats, config }` (`config` is the full merge against the assigned role, `alerts` included), `{ node }` for patch/approve/reject/retire, `{ ok: true }` for delete, `{ events, nextBefore }`, `{ settings }`, `{ scope, value, updatedAt, updatedBy, effective? }`, `{ history }`.
- `NodeView` adds to the stored row: `status`, `shortId`, `label`, `ageSeconds`, `hardwareCapabilities`, `desiredClosure`, `desiredRevision`, `convergence` (`converged`, `progressing`, `blocked`, `unknown`), `reconcileIssues` and `ageRecipientNext` (from the stored facts, `null` when no rotation is pending). `role` is the assigned role (nullable); `observedRole`, `observedClosure`, `ageRecipient` and `appliedRevision` are what the node reported.
- `GET /v1/recipients` answers `{ roles: { "<role>": [{ nodeId, hostname, recipient, next }] } }`: approved nodes with an assigned role and a reported recipient, sorted by hostname. `next` is the node's `ageRecipientNext`, or `null`. Every active role is present (possibly empty); unassigned nodes are excluded. Recipients are public keys; the controller never holds a private age key.
- `events?severity=warn` means warn and error; `severity=error` only error. `before` is an event id; `limit` is 1-200 (default 50). `nextBefore` is null on the last page.
- `DELETE` removes the node, its heartbeat history and its `node:<id>` settings document; events and settings history stay. Approve, reject and retire on the state a node already has change nothing and write no event.
- A cookie-authenticated state-changing request needs an `Origin` (else `Referer`) that names this host (or `x-forwarded-host`); only a request that itself carries the admin Bearer token skips that check.
- Every `/v1/*` answer is `Cache-Control: no-store`; unknown `/v1` paths are `404 { error: "not_found" }`.

### Age identity rotation

Level-triggered, like every other setting; the controller never touches Git or a private key.

1. A person presses **Rotate age identity** (or sets `secrets.rotateAgeKeyAfter` on any scope). The node, whose identity predates that time, generates a next identity and reports `ageRecipientNext`; it keeps decrypting with the current one.
2. `GET /v1/recipients` shows the node with both `recipient` and `next`. The operator re-encrypts the role's SOPS file for **both** recipients (`sops updatekeys`) and merges.
3. Once the merged file lists the next recipient, the node promotes the next identity: it reports the new key as `ageRecipient` and stops reporting `ageRecipientNext` (`next` becomes `null`).
4. The operator removes the old recipient from the role's SOPS file and merges again. Until then the old key can still decrypt the file.

### Metrics

`fleet_node_last_seen_seconds` is the number of seconds since the node last reported. `fleet_node_up`, `fleet_node_converged` (1 when converged as defined above) and `fleet_node_last_seen_seconds` exist only for `approved` nodes; `fleet_nodes` has a series for every status and role. `role` labels carry the assigned role, or `unassigned`.

### Background work

No offline notice is sent in the first two minutes after the process starts, so an controller outage does not announce the whole fleet when it ends. A notice is recorded before the webhook is tried; webhook failures (timeout 5 s, no redirects, https only) are logged and never repeated.

## Extended telemetry (optional field)

A new agent may include `telemetry` in each heartbeat. Its absence means an
older agent or unavailable collection; it never means zero usage. The object
is validated and stored in full in the latest node `facts`. Heartbeat history
retains a compact nullable JSONB metric summary for the existing seven-day
retention: sample time, CPU utilization, at most one hottest temperature sensor
and one largest measured power domain (including its name and source).
Historical arrays for filesystems, network, jobs, diagnostics and issues are
empty; swap is null. Full lifecycle/service diagnostics belong to the current
snapshot, not a raw log archive. Unknown keys
are discarded. It is optional in protocol v2 as it was in v1.

- `sampledAt`: ISO 8601 UTC timestamp ending in `Z`.
- `cpuUsagePercent`: measured CPU utilization (0–100), or `null` while the
  first counter delta is warming up or the measurement is unavailable. Load
  average remains a separate metric.
- `filesystems`: up to 16 `{ mount, totalBytes, usedBytes, availableBytes }`
  records. Counts are nonnegative safe integers; used plus available cannot
  exceed total (reserved space may account for the remainder).
- `temperatures`: up to 64 `{ name, celsius }` sensor readings, −100–250 °C.
- `power`: up to 32 `{ name, watts, source }` records; `source` is `hwmon` or
  `powercap`. These are individual hardware domains and may overlap; they do
  not establish whole-machine or wall power. Unsupported hardware reports an
  empty array and a diagnostic issue instead of invented zero watts.
- `swap`: `{ totalBytes, usedBytes }`, or `null` when unavailable.
- `network`: up to 32 `{ name, receivedBytes, transmittedBytes,
receiveBytesPerSecond, transmitBytesPerSecond }` records. Counter deltas are
  `null` on first collection, interface reset or unavailable samples.
- `runnerSlots`: up to 64 `{ slot, state, repository, runId, jobName,
startedAt, finishedAt, result }` records. State is `idle`, `busy` or `offline`.
  Unknown metadata is `null`; times are ISO UTC. GitHub repository names are
  restricted to two safe path segments and run IDs to positive decimal
  strings. Links always target `https://github.com/<owner>/<repo>/actions/runs/<id>`.
  Hook completion proves the completion hook ran, not a trustworthy job result;
  GitHub remains authoritative for outcomes and complete authenticated job logs.
- `logs`: up to 40 `{ at, source, level, message }` diagnostic summaries, with
  `info`, `warn` or `error` levels. Sources are `systemd` and `runner:slot-1`
  through `runner:slot-64`; messages use the allowlisted failed-service and
  runner-start/completed/interrupted summaries. Arbitrary journald, runner
  stdout, environment variables, tokens and job output are not ingested.
- `issues`: up to 16 diagnostic strings. Labels/job names are at most 120
  characters, diagnostic messages at most 500. Named collections reject
  duplicate identifiers. Existing request bodies remain capped at 64 KiB.

The existing `runners.busy` count cannot exceed `runners.slots`. The dashboard
shows sample time and explicitly labels stale samples; missing sensors and
unmeasured rates remain unavailable. CPU, highest reported temperature and
largest reported power-domain charts use the stored samples with gaps for
unknown values. Power domains are never summed as if they were independent.
History endpoints return at most 1,440 points across the requested window.
When more reports exist, adaptive time buckets retain the latest actual sample
in each bucket, including the newest report, without filling gaps. Charts
average the returned samples; a gap means no returned sample in that period,
not a precise outage measurement. Low-frequency histories are unchanged.

Protected `/metrics` also exposes `fleet_node_telemetry_fresh`,
`fleet_node_ready`, `fleet_node_memory_bytes`, `fleet_node_runner_slots`,
`fleet_node_cpu_usage_percent`, `fleet_node_filesystem_bytes`,
`fleet_node_temperature_celsius`, `fleet_node_power_watts`,
`fleet_node_network_bytes_per_second`, interface byte counters and
`fleet_node_swap_bytes`. Resource series are omitted when the node or sample
is stale; unavailable measurements are omitted rather than exported as zero.
Telemetry freshness and readiness remain explicit 0/1 gauges. All metrics
responses are `Cache-Control: no-store` and retain administrator authorization.

### SQLite schema lifecycle

A new database is created at schema version 2 from `schema.sql`, transactionally,
before the controller accepts requests. An existing version 1 database is
upgraded in one transaction by `src/db/migrations.ts`: the `nodes` table is
rebuilt (with foreign keys off, then checked) so that `role` is the nullable
**assigned** role without a database role check (roles are validated in code),
with new `observed_role`, `observed_closure`, `age_recipient`, `hardware` and
`reconcile` columns and `config_revision` renamed `applied_revision`. Every v1
`role` is copied into both `role` and `observed_role`, so existing nodes keep
exactly what they run; `enrolled_via = 'role-token'` becomes
`'enrollment-token'`. A failed upgrade rolls back and leaves version 1 intact.
`SqliteStore.health()` reads the required telemetry column with `LIMIT 0`, so a
missing column refuses readiness instead of silently losing reports. A database
from a newer schema version refuses startup.

Future schema changes must add a versioned step to `src/db/migrations.ts` and
update `schema.sql` for new databases; changing `schema.sql` alone does not
upgrade an existing database.
Back up before upgrades and deploy the controller/dashboard before updated agents.
Authorization data is never automatically seeded from a browser sign-in.
