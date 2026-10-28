# Fleet controller protocol (v1)

The contract between `packages/fleet-controller` (the controller), `packages/fleet/scripts/agent.py` (the node agent) and the dashboard. TypeScript types are in `src/types.ts`; configuration keys are in `src/config/schema.ts`. If this file and the code disagree, fix the code or this file in the same commit.

Base URL: `https://fleet.example.com`. All bodies are JSON (`Content-Type: application/json`). Times are ISO 8601 UTC. Errors are `{ "error": "<code>", "message": "<what happened and what to do>" }`.

## Principles

- **Data, never code.** The controller can tell a node _what its settings are_. It cannot tell a node to run anything. A compromised controller must not be able to execute code on the fleet. Nodes only interpret the typed keys in `FleetConfig`.
- **The fleet works without the controller.** A node that cannot reach the controller keeps its last configuration (cached on disk) and its built-in defaults. Reporting is best effort and never blocks updates (`fleet-sync`).
- **One controller owns one SQLite database.** Bun's built-in SQLite uses a transactional schema initialized automatically at startup. The default launcher restores and replicates local SQLite through Litestream to S3-compatible storage. No external migration service is needed.

## Identity and credentials

| Credential     | Held by                                                                                        | Used for                                                |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| node id        | derived from hardware (never secret)                                                           | names the node                                          |
| node secret    | the node (`/nix/fleet-state/agent/node.secret`, 0600)                                          | `Authorization: Bearer <id>.<secret>` after registering |
| role token     | nodes enrolled through the GitHub approval, kept in `/nix/fleet-state/agent/role-token` (0600) | register without waiting for a person                   |
| admin token    | scripts and CI (`FLEET_ADMIN_TOKEN`)                                                           | `Authorization: Bearer <token>` on admin routes         |
| session cookie | a person signed in to the dashboard                                                            | the dashboard and admin routes                          |

- **Node id** is the lowercase sha256 hex (64 chars) of the machine's stable hardware material, exactly the digest whose first four hex digits are the node's hostname suffix (`ci-a3f9` -> id starts `a3f9`). It is `/run/fleet/node` field `machine_id`.
- The controller stores `sha256(node secret)` only. A node secret is 32 random bytes, hex encoded (64 chars).
- `FLEET_ROLE_TOKEN_HASHES` is a JSON object `{ "ci": "<sha256 hex>", ... }`. The controller compares `sha256(presented role token)` to the hash for the node's claimed role with a constant-time comparison.
- Browser authentication uses the deployment-injected standard OIDC provider directly: OIDC code + S256 PKCE, state, nonce and signature/issuer/audience/expiry verification. The verified email must appear in `fleet.allowed_emails`. Fleet uses an opaque, database-backed session, rechecks access on authorized requests and invalidates it on sign-out. The initial allowlist is operator-managed. Authentication adapters and their HTTP transport are injected at controller composition; no shared relay or provider-specific account is required.
- `/not-allowed` shows a denied signed-in account and permits same-origin sign-out without requiring allowlist access. `/access` manages allowed emails for existing allowed administrators, auditing changes and protecting the final allowed address. Initial access is populated by the explicit owner CLI command. See README for storage and exact callback configuration.

## Node endpoints

### `POST /v1/enrollment/check` (role credential)

Read-only, rate limited like registration. Send `{ "role": "ci", "roleToken": "..." }`
over HTTPS. `200 { "ok": true, "role": "ci" }` proves the credential matches
Fleet's automatic-approval configuration. Invalid credentials return `401`;
malformed input returns `400`. No node, secret or event is created. The live
installer additionally registers the actual hardware and requires `approved`
before erasing; an explicitly rejected identity cannot silently proceed.

The optional heartbeat `readiness` object contains up to 12 public diagnostic
issues, each at most 500 characters. Missing means unknown, not ready. An empty
list means the installed agent verified the update timer and current revision's
cache/sync check, recovery credential, and (for CI) GitHub runner availability.
The console combines it with current membership/connectivity and failed units;
an online heartbeat alone does not establish readiness. Bootstrap reports use
the same protocol and private node credential, copied into the installed system,
with a nonempty installation issue until the installed agent takes over.

### `POST /v1/nodes/register` (no credential)

Rate limited per address. Idempotent: calling it again for the same id replaces the stored secret hash (a reinstall has a new secret).

```json
{
  "nodeId": "<64 hex>",
  "role": "ci",
  "hostname": "ci-a3f9",
  "secret": "<64 hex, new random>",
  "roleToken": "<optional>"
}
```

`201`/`200`:

```json
{ "status": "approved", "heartbeatIntervalSeconds": 60 }
```

- A valid `roleToken` for `role` -> `approved` immediately, `enrolledVia: "role-token"`.
- Otherwise `status: "pending"`, `enrolledVia: "hello"`; a person approves in the dashboard. The node keeps reporting while pending; the controller stores its facts so the person can see what they are approving.
- A node that a person rejected stays `rejected`; a retired node that registers again becomes pending (or approved with a valid role token).
- `400 invalid_request`, `429 rate_limited`.

### `POST /v1/heartbeat` (`Authorization: Bearer <id>.<secret>`)

Body: `HeartbeatBody` (`src/types.ts`). Send every `heartbeat.intervalSeconds` (default 60) and once at boot. Example:

```json
{
  "v": 1,
  "nodeId": "<64 hex>",
  "role": "ci",
  "hostname": "ci-a3f9",
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
  "agent": { "version": "1", "configRevision": "0123456789abcdef" },
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

Response `200`:

```json
{
  "ok": true,
  "status": "approved",
  "serverTime": "2026-10-14T12:00:00.000Z",
  "config": {
    "revision": "<16 hex>",
    "values": { "sync": { "paused": false } }
  }
}
```

- `config` is present only when the node's `agent.configRevision` differs from the controller's current revision. The agent persists it, applies it, and reports the new revision next time. `values` is `nodePayload(resolveConfig(...))`: it never contains `alerts`.
- A `pending` node gets `status: "pending"` and `config` with only `heartbeat.intervalSeconds`.
- `401 unauthorized` for an unknown id or wrong secret (the agent re-registers). `403 rejected`/`retired` for those states (the agent backs off to hourly).
- The body's `nodeId` must equal the credential's id. `events` is at most 20 entries, `message` at most 500 chars. Anything else over limits is `400`.
- The controller derives `hostname`, `role`, `revision` from the body. It never trusts the body for approval or labels.
- An event may carry `key` (`[A-Za-z0-9:._-]{1,120}`), `at` (the node's UTC time, `YYYY-MM-DDTHH:MM:SSZ`) and `data` (up to 16 flat scalar fields, strings cut at 300 characters). An event whose `key` this node already reported is not stored again, so a retried heartbeat cannot record it twice; `key` and `at` are stored as `data.key` and `data.occurredAt`. Recovery events (`unclean-shutdown`, `job-interrupted`, `update-quarantined`, `gate-reopened`) come from the node's durable outbox (`packages/fleet/scripts/recovery.py`) and are resent until a heartbeat carrying them is accepted.
- `recovery` (optional) is what the node remembers across power loss (the example is a first boot: `previousClean` and `previousEndedAt` are null until a boot has ended): whether the previous boot shut down cleanly, a quarantined kernel, why runner admission is closed, and how many recovery events still wait to be delivered. See `packages/fleet/docs/resilience.md`.

### `POST /v1/retire` (`Authorization: Bearer <id>.<secret>`)

Sent by `fleet-node remove`. Marks the node `retired`, records an event, and stops "offline" notices for it. `200 { "ok": true }`.

## Admin endpoints (Bearer admin token or session cookie)

State-changing browser requests also require a same-origin `Origin` header (CSRF).

| Method and path                                 | Purpose                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/nodes`                                 | All nodes as `NodeView` (status, label, age), newest report first                                                                          |
| `GET /v1/nodes/:id`                             | One node, plus `heartbeats` (last 24 h) and its resolved `config`                                                                          |
| `PATCH /v1/nodes/:id`                           | `{ displayName?, note?, labels? }`                                                                                                         |
| `POST /v1/nodes/:id/approve`                    | pending -> approved                                                                                                                        |
| `POST /v1/nodes/:id/reject`                     | -> rejected                                                                                                                                |
| `POST /v1/nodes/:id/retire`                     | -> retired                                                                                                                                 |
| `DELETE /v1/nodes/:id`                          | forget the node and its history (events keep its label)                                                                                    |
| `GET /v1/summary`                               | `FleetSummary`                                                                                                                             |
| `GET /v1/events?node=&severity=&before=&limit=` | events, newest first                                                                                                                       |
| `GET /v1/settings`                              | every stored scope                                                                                                                         |
| `GET /v1/settings/:scope`                       | `fleet`, `role:ci`, `node:<id>`; plus `effective` for node scopes                                                                          |
| `PUT /v1/settings/:scope`                       | replace a scope's document (validated; unknown keys rejected); appends history                                                             |
| `GET /v1/settings/:scope/history`               | who changed what                                                                                                                           |
| `GET /metrics`                                  | Prometheus text: `fleet_nodes{status,role}`, `fleet_node_up{node,role}`, `fleet_node_last_seen_seconds{node}`, `fleet_runner_slots{state}` |

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

Storage and deployment settings are documented in [the configuration guide](../../CONFIGURATION.md). The supported entry point is `bun run start`. Litestream requires S3-compatible credentials; the only supported deployment is a single native node. `FLEET_ADMIN_TOKEN` requires at least 32 characters. `FLEET_ROLE_TOKEN_HASHES` defaults to `{}`. Browser login uses `FLEET_OIDC_ISSUER`, `FLEET_OIDC_CLIENT_ID` and `FLEET_PUBLIC_ORIGIN` as a complete set. A bad environment stops the process at boot, naming variables and never values.

### Registration and approval

- Registering again replaces the secret. A node that was `approved` and registers without a valid role token goes back to `pending` (a reinstall must be approved again, and nobody who learns a node id can take over an approved node silently). With a valid token it stays `approved`. `rejected` always stays `rejected`; `retired` becomes `pending` or, with the token, `approved`.
- A `roleToken` that does not match is not an error: the node is simply `pending`.
- `403 rejected` / `403 retired` on heartbeat and retire are answered only to a caller that holds the node's secret; anyone else gets `401`. A retired node may call `POST /v1/retire` again (`200`).
- `register` is limited to 20 per minute per address, `POST /login` to 10 per five minutes. The address is `cf-connecting-ip`, else the first `x-forwarded-for` entry, else the socket. Refusals are `429 { error: "rate_limited", retryAfterSeconds }` with `Retry-After`.

### Heartbeat

- Unknown keys in the body are ignored and never stored (a newer agent does not break an older controller). Types, ranges and sizes are checked; every problem is returned in `errors`.
- `role`, `hostname` and `revision` are taken from the body. The stored `facts` are the body without `events`.
- The controller writes derived events, once per change and only for `approved` nodes: `boot` (new `bootId`, unless the agent sent its own `boot`), `revision`, `rollback` / `rollback_cleared`, `units_failed` / `units_recovered` (only the units that changed), `disk_high` / `disk_ok` (per mount, at `disk.alertPercent`, default 90), and `recovered` (first report after an `offline` notice).
- Registration and admin actions write `registered`, `reregistered`, `approved`, `rejected`, `retired`, `pending`, `node_updated`, `node_deleted`.

### Controller administration endpoints

- Bodies: `PATCH` takes `displayName` (80 chars), `note` (1000), `labels` (16 distinct, `[A-Za-z0-9_.:-]{1,50}`); `null` or blank clears text. `PUT /v1/settings/:scope` takes the document itself; errors are `400 { error: "invalid_settings", errors: [...] }`.
- Responses: `{ nodes }`, `{ node, heartbeats, config }` (`config` is the full merge, `alerts` included), `{ node }` for patch/approve/reject/retire, `{ ok: true }` for delete, `{ events, nextBefore }`, `{ settings }`, `{ scope, value, updatedAt, updatedBy, effective? }`, `{ history }`.
- `events?severity=warn` means warn and error; `severity=error` only error. `before` is an event id; `limit` is 1-200 (default 50). `nextBefore` is null on the last page.
- `DELETE` removes the node, its heartbeat history and its `node:<id>` settings document; events and settings history stay. Approve, reject and retire on the state a node already has change nothing and write no event.
- A cookie-authenticated state-changing request needs an `Origin` (else `Referer`) that names this host (or `x-forwarded-host`); only a request that itself carries the admin Bearer token skips that check.
- Every `/v1/*` answer is `Cache-Control: no-store`; unknown `/v1` paths are `404 { error: "not_found" }`.

### Metrics

`fleet_node_last_seen_seconds` is the number of seconds since the node last reported. `fleet_node_up` and `fleet_node_last_seen_seconds` exist only for `approved` nodes; `fleet_nodes` has a series for every status and role.

### Background work

No offline notice is sent in the first two minutes after the process starts, so an controller outage does not announce the whole fleet when it ends. A notice is recorded before the webhook is tried; webhook failures (timeout 5 s, no redirects, https only) are logged and never repeated.

## Extended telemetry (optional v1 field)

A new agent may include `telemetry` in each heartbeat. Its absence means an
older agent or unavailable collection; it never means zero usage. The object
is validated and stored in full in the latest node `facts`. Heartbeat history
retains a compact nullable JSONB metric summary for the existing seven-day
retention: sample time, CPU utilization, at most one hottest temperature sensor
and one largest measured power domain (including its name and source).
Historical arrays for filesystems, network, jobs, diagnostics and issues are
empty; swap is null. Full lifecycle/service diagnostics belong to the current
snapshot, not a raw log archive. Unknown keys
are discarded. Existing agents do not need a protocol-version change.

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

The controller initializes SQLite schema version 1 transactionally before accepting
requests. It includes nullable `heartbeats.telemetry`; old agent heartbeats
remain accepted. `SqliteStore.health()` reads the required telemetry column
with `LIMIT 0`, so a missing column refuses readiness instead of silently losing
reports. A database from a newer schema version refuses startup.

Future schema changes must include a versioned migration in `src/db/client.ts`;
changing the initial `schema.sql` alone does not upgrade an existing database.
Back up before upgrades and deploy the controller/dashboard before updated agents.
Authorization data is never automatically seeded from a browser sign-in.
