# Fleet controller configuration

Fleet runs as **one native Bun process supervised by Litestream**. SQLite is built
into Bun. S3-compatible object storage holds the durable replica; the local
SQLite working directory can be restored on a replacement host. Fleet enforces
a single writer per replica prefix itself (see [Writer ownership](#writer-ownership)),
so overlapping and rolling deployments are safe. There are no selectable storage backends.

The controller package is `packages/fleet-controller` and its example unit is
`fleet-controller.service`. Existing environment variable names, node `fleetApi`
settings, HTTP routes, port defaults and explicit `FLEET_DATABASE_PATH` values
remain unchanged. The default working file remains package-local at `data/fleet.db`;
when renaming an existing checkout, move that working directory with the package.

## Required settings

Copy [deployment.env.example](deployment.env.example) to `deployment.env` at the
repository root. Fill in all four settings. Fleet never provisions the bucket,
credentials, repository or identity provider.

| Setting                  | Required value / correction                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_ADMIN_TOKEN`      | A random bearer secret of at least 32 characters, without whitespace. Generate your own with `openssl rand -hex 32`.                                                                                    |
| `FLEET_ADMIN_TOKEN_NEXT` | Optional. Set only while rotating the admin token: the controller accepts it alongside `FLEET_ADMIN_TOKEN` (same rules, must differ). See `packages/fleet-controller/docs/access-and-config-safety.md`. |
| `FLEET_S3_BUCKET`        | An existing bucket name: 3–63 lowercase letters, digits, hyphens or dots. Supply the name, not a URL.                                                                                                   |
| `AWS_ACCESS_KEY_ID`      | Access key for that bucket/prefix.                                                                                                                                                                      |
| `AWS_SECRET_ACCESS_KEY`  | Corresponding secret key.                                                                                                                                                                               |

Hosting platforms that already supply the generic names `S3_BUCKET`,
`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` need
no renaming: each is used when the corresponding `FLEET_S3_BUCKET`,
`FLEET_S3_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`
is unset, is validated the same way, and is handed to Litestream under the AWS
name. Setting both names of a pair to different values refuses startup.

Give the S3 credentials List/Get/Put/Delete permissions for the selected bucket
and prefix, including multipart-upload permissions required by the provider.
For non-AWS storage, set `FLEET_S3_ENDPOINT` to the provider's HTTPS origin.
Do not put credentials in URLs. Never commit `deployment.env`.

## Install, check and start

Install **Bun 1.4.4** and **Litestream 0.5.17** using their official installation
instructions. Put both executables on PATH, or set `FLEET_LITESTREAM_BIN`.
From the repository root:

```sh
bun install --frozen-lockfile
bun run build
cp deployment.env.example deployment.env
# Fill in deployment.env, including the endpoint for non-AWS storage.
bun --env-file=deployment.env run check:config
bun --env-file=deployment.env run start
```

The explicit `--env-file` matters: `deployment.env` is not loaded by a plain
`bun run start`. Service managers may supply the same variables directly.
`check:config` validates settings, runtime/binary versions, built dashboard assets
and local directory access. It does not contact S3 or create a SQLite database.

Startup restores a missing working file, initializes/validates the SQLite schema,
and performs an initial replica sync **before listening for HTTP traffic**. This
checks real bucket access even when a local database already exists. A fresh
bucket/prefix is allowed; access failures never trigger an empty-data fallback.
After the initial sync, Litestream continuously replicates while supervising the
controller. Startup failures exit nonzero, identify the failing stage and explain the
fix. A failed worker/replication process also exits nonzero for the service
manager to restart. Credentials and SQL parameters are never included in Fleet's
error messages; retain the preceding Litestream diagnostic when investigating
S3 failures.

## Optional settings and defaults

| Setting                         | Default / meaning                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FLEET_DATABASE_PATH`           | Absolute path to `packages/fleet-controller/data/fleet.db` in this checkout. Set an absolute path for a service installation. The file and its directory must be writable by the service user. Relative overrides resolve from the controller package working directory when using `bun run start`.                                  |
| `FLEET_S3_PREFIX`               | `fleet`. Use a unique prefix per independent deployment; no leading/trailing slash, empty segments or `.`/`..` segments. Reuse it when replacing the same node.                                                                                                                                                                      |
| `FLEET_S3_ENDPOINT`             | AWS S3 by default. For other providers, an HTTPS origin without path/query/credentials. Loopback HTTP is allowed for local testing only.                                                                                                                                                                                             |
| `AWS_REGION`                    | `us-east-1`. Set your bucket region, or `auto` for providers that require it.                                                                                                                                                                                                                                                        |
| `AWS_SESSION_TOKEN`             | Unset. Supply when using temporary AWS credentials; renew credentials before expiration.                                                                                                                                                                                                                                             |
| `PORT`                          | `8080`; an integer from 1 to 65535. Use an unused port above 1023 without root privileges.                                                                                                                                                                                                                                           |
| `FLEET_LITESTREAM_BIN`          | `litestream` on PATH; must report version 0.5.17.                                                                                                                                                                                                                                                                                    |
| `FLEET_STARTUP_TIMEOUT_SECONDS` | `60` per restore/initial-sync operation; integer 1–3600. Increase for large databases or slow object storage. A stalled startup is terminated with a nonzero exit, preserving local data for investigation. No deadline is applied to the running controller.                                                                        |
| `FLEET_ENROLLMENT_TOKENS`       | `[]`. Nodes require manual approval unless they present an enrollment token whose SHA-256 is listed here: a JSON array (at most 16) of `{ "sha256": "<64 hex>", "role": "<active role>" \| null }`. A matching token approves the node and assigns the role when the node has none. `FLEET_ROLE_TOKEN_HASHES` is refused at startup. |

### GitHub Actions runners (optional)

The controller, not the nodes, holds the GitHub App credentials. Without these
variables nothing talks to GitHub and the dashboard's **Runners** page says so; no data
is ever simulated. Setup, scopes and failure modes:
[`packages/fleet-controller/docs/github-runners.md`](packages/fleet-controller/docs/github-runners.md).

| Variable                                                              | Meaning                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_GITHUB_APP_PRIVATE_KEY` or `FLEET_GITHUB_APP_PRIVATE_KEY_FILE` | The GitHub App's RSA private key (PEM, PKCS#1 or PKCS#8), inline (`\n` escapes allowed) or as an absolute file path. Set at most one. It is parsed at startup, never stored in the database, rendered or logged; an unusable key fails startup naming the variable. |
| `FLEET_GITHUB_WEBHOOK_SECRET`                                         | At least 16 characters. Enables `POST /v1/github/webhook` (`workflow_job`, `workflow_run`), authenticated only by the `X-Hub-Signature-256` HMAC. Polling stays the baseline, so the webhook is optional.                                                           |
| `FLEET_GITHUB_API_URL`                                                | `https://api.github.com`. Set only for GitHub Enterprise Server (`https://ghe.example.com/api/v3`) or a loopback test server. HTTPS, no credentials (HTTP only on loopback).                                                                                        |

The App ID, installation ID, scope, repositories, runner group and policy are not
environment settings: an administrator saves them on the **Runners** page
(`PUT /v1/github/integration`).

### One-click issue reporting (optional)

Every failure in the dashboard has a **Report issue** link to a preview page that
builds a redacted Markdown issue for an AI coding agent (what was gathered, what is
removed, duplicates and outage behaviour:
[`packages/fleet-controller/docs/issue-reporting.md`](packages/fleet-controller/docs/issue-reporting.md)).
Without these variables the page still works: it shows the report with a copy button,
and a prefilled "new issue" link when the repository is known.

| Variable                      | Meaning                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_ISSUES_REPOSITORY`     | `owner/name` where reports are filed. Alone, it enables the prefilled "new issue" link.                                                                                                                                                     |
| `FLEET_ISSUES_GITHUB_TOKEN`   | A fine-grained token with **Issues: write** on that repository only. Needs `FLEET_ISSUES_REPOSITORY`. Enables **Create GitHub issue**. Held in memory; never stored, rendered or logged. Rotate it by changing the variable and restarting. |
| `FLEET_ISSUES_LABELS`         | Comma-separated labels (at most 10). Default `fleet-report`.                                                                                                                                                                                |
| `FLEET_ISSUES_GITHUB_API_URL` | `https://api.github.com`. Only for GitHub Enterprise Server or a loopback test server; HTTPS, no credentials (HTTP only on loopback).                                                                                                       |

The controller also reports its own version and Git commit. The image build does not
stamp a commit; set `FLEET_CONTROLLER_COMMIT` (or let the platform provide
`RAILWAY_GIT_COMMIT_SHA`, `SOURCE_COMMIT`, `GIT_COMMIT` or `GITHUB_SHA`) or reports say
`unknown`.

Each deployment uses one operator-owned user pool. Fleet connects directly to its
standard OIDC provider; no shared auth relay, Google account, Vault, or original
infrastructure is required. Register a public client with authorization code +
S256 PKCE and enable the standard `openid email profile` scopes. The provider must
issue signed ID tokens containing `iss`, `sub`, `email`, and `email_verified: true`.

Browser login is optional. Supply **all three** of `FLEET_OIDC_ISSUER` (HTTPS OIDC
issuer), `FLEET_OIDC_CLIENT_ID`, and `FLEET_PUBLIC_ORIGIN` (HTTPS origin, or loopback
HTTP for development), or leave all three unset. Register the exact callback
`${FLEET_PUBLIC_ORIGIN}/auth/callback`. Invalid/incomplete settings fail startup.
Without OIDC, use the bearer-token controller administration endpoints. Explicitly authorize the first
browser owner after Fleet has restored and started:

```sh
bun --env-file=deployment.env run access:allow owner@example.org
```

Use the same checkout/environment and working-file path, and run it only while
no instance owns the replica (the service is stopped and has released it): the
command reads `<prefix>/fleet-owner.json` first and refuses while a holder is
recorded, when the record cannot be read, or when the local file is not the
authoritative replica (see [Writer ownership](#writer-ownership)). There is no
option to skip that check. Where nothing can run beside the service (container
hosting) or the service is running, the admin token holder authorizes the owner
over HTTP instead, which goes through the owner:

```sh
curl -fsS -X PUT -H "Authorization: Bearer $FLEET_ADMIN_TOKEN" \
  https://fleet.example.org/v1/access/owner@example.org
```

`GET /v1/access` lists allowed emails and `DELETE /v1/access/:email` removes one
(the final account cannot be removed). These routes require the admin token or an
allowed browser session and are recorded in the access audit.
First browser sign-in never grants access automatically. Fleet owns its opaque,
SQLite-backed sessions and email allowlist; the provider owns user authentication.
Provider errors refuse sign-in and never select another provider or fixture user.

For application embedding, `startController(env, log, { authFactory, fetch })` in
`packages/fleet-controller/src/controller.ts` is the trusted composition boundary.
`AuthFactory` receives the deployment OIDC configuration, access store, clock, and
HTTP transport and returns `AdminAuth` and optional `BrowserAuth` interfaces. A
replacement factory fully replaces default authentication; an invalid factory
fails startup. No request or tenant field selects the adapter. Keep production
browser adapters on validated OIDC code + S256 PKCE.

The default factory in `src/auth/composition.ts` explicitly constructs
`FleetBrowserAuth(access, oidc, provider, now)`. To replace only the provider,
inject an `IdentityProvider` implementing `authorize` and `exchange` while keeping
Fleet sessions and access management. Its `exchange` implementation must return
claims only after signature, issuer, audience, expiry, state, and nonce validation.
`createOidcClient(oidc, fetch)` supplies this validation using `openid-client`;
all discovery, token, and signing-key requests use the supplied transport. There
is no implicit provider construction inside the browser auth service.

## Keep it running

### Container hosting

The root `Dockerfile` packages the same controller and Litestream supervisor for
`linux/amd64` hosting. Build without secrets with
`docker build --platform linux/amd64 -t fleet .`.
It pins Bun 1.4.4 and Litestream 0.5.17, builds dashboard assets, installs frozen
production dependencies, and runs as the unprivileged `bun` user. The entrypoint
receives SIGTERM directly. Supply the settings above as runtime environment
variables; no Vault client or credentials are included in the image.

The working file defaults to `/var/lib/fleet/fleet.db`. Its directory is writable
without a persistent volume: ordinary container restarts retain it, and a newly
created container restores from S3. A mounted directory must also be writable by
the container user. Allow at least 60 seconds for shutdown and a startup grace
covering both restore and initial sync (60 seconds each by default). Rolling and
overlapping deployments are supported: the new container asks the old one to hand
over (see [Writer ownership](#writer-ownership)). Run exactly one replica of the
service; autoscaling adds standbys, not capacity. On Railway, set
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60` so a stop without a successor can finish
its final sync instead of being killed immediately, and point the platform
healthcheck at `/health` (see [Health semantics](#health-semantics), the
[shutdown budget](#shutdown-budget) and the [hosting request](#hosting-request)).

`.github/workflows/publish.yml` builds and tests the Linux image on pull requests.
The container check uses disposable Moto S3 storage to exercise readiness,
graceful shutdown, restart persistence, fresh-container restore (configured with
the generic `S3_*` names), an overlapping rolling hand-over, denied writes and
refusal to start without configuration. It also runs the single-writer drills
(rolling deploy with SIGTERM, zero-drain SIGKILL, crash takeover, a paused zombie
owner, simultaneous cold start, providers without conditional writes), each ending
with a fresh-container restore and `PRAGMA integrity_check`; their offline
orchestration self-test is `scripts/check-container-selftest.py`. Trusted main pushes call workspace's
reusable publisher for `ghcr.io/crvouga/chrisvouga-fleet-api:<commit-sha>` and
`:latest`. Successful publication dispatches that commit to workspace's managed
`fleet-api` service. Hosting, secrets and DNS remain OpenTofu-owned in the
operator's platform repository. Image publication does not establish live
deployment, real R2 permissions, replica freshness or OIDC acceptance.

### Native service manager

Use your OS service manager to restart `bun run start` after a failure. An
[example systemd unit](examples/deployment/fleet-controller.service) supplies the same
environment from `/etc/fleet/fleet.env`, restarts after unexpected exits and allows 60
seconds for shutdown. Edit paths and the service user before installing it;
Fleet does not install units, create users or provision credentials for you.
Put your HTTPS reverse proxy in front of port 8080 for remote browser access.
Monitor `/health` and Litestream's logs/replica freshness. `/health` checks the
controller/database, not ongoing S3 replication; Litestream retries transient outages.
It answers only on the instance that owns the replica; a standby has no listener.

Preserve the complete local directory across ordinary restarts, including the
WAL/SHM, Litestream metadata and the `.generation` marker. To replace a lost host,
use the same environment/bucket/prefix with an empty writable directory. Do not
copy just a live `.db` file. Run restore drills with `bun run restore:drill`, which
refuses the prefix of a live owner; use a copy under another prefix (`--prefix`).

### Writer ownership

Every instance must own the replica prefix before it restores or writes. Ownership
is the object `<prefix>/fleet-owner.json`, changed only with conditional writes
(`If-None-Match` / `If-Match`), so two instances can never both claim it. Startup
verifies that the provider honours conditional writes (AWS S3 and Cloudflare R2
do) and refuses to start otherwise.

Each owner writes its own **generation** of the replica under
`<prefix>/generations/<n>/` and restores from the previous one, so even a
misbehaving former owner can never overwrite the current replica. A replica
written directly under `<prefix>` by earlier Fleet versions is generation 0 and is
restored automatically on first start.

- **Rolling deploy.** A new instance asks the owner to hand over. The owner answers
  `503` with `Retry-After` to everything but `/health` and static assets, stops the worker, performs an
  explicit final sync, and releases ownership reserved for the requester, which
  restores and starts listening. The old instance stays up as a standby that
  only takes released or expired ownership, and exits on SIGTERM.
- **Crash.** The owner renews every `FLEET_OWNERSHIP_RENEW_SECONDS` (default 5).
  A waiting instance takes over once the record has stayed unchanged for
  `FLEET_OWNERSHIP_EXPIRE_SECONDS` (default 30, minimum 15, at least six renewals)
  by its own clock. Recent
  unreplicated writes (about one second) can be lost.
- **Fencing.** An owner that cannot renew for two thirds of the expiry (timed
  from before its last successful request) stops serving at least five seconds
  before anyone may take over. A paused or partitioned owner
  that resumes after a takeover refuses writes, stops its worker and **exits
  nonzero** (see [Fenced writers and restart policy](#fenced-writers-and-restart-policy)).
- **Local file.** The working file is kept only when its `.generation` marker
  shows it continues the generation being restored; otherwise it is moved to
  `fleet.db.superseded` (never deleted) and restored fresh.
- **Replication metadata.** Each process and remote generation uses its own
  temporary Litestream `meta-path`. Initial, continuous and final sync share it
  within that generation. A new generation builds a full snapshot from SQLite;
  it never depends on historical LTX files beside a retained working database.
  The old metadata is left untouched. Keep the SQLite database, WAL/SHM and
  `.generation` marker together when moving a volume; do not delete them to
  repair a missing-LTX startup failure.

Defaults (renew 5 s, expire 30 s, fence 20 s, standby poll 2 s) work on Railway
without tuning.

Ownership requests use `Accept-Encoding: identity` so S3-compatible endpoints
preserve strong ETags. R2 can return weak ETags for compressed responses, which
cannot satisfy conditional updates. Fleet rejects weak validators rather than
removing their `W/` prefix; proxies must preserve strong object ETags.

#### Health semantics

`/health` answers `200` only from an instance that owns the replica and serves.
A starting or standby instance has **no listener at all** (the worker only starts
after the instance has claimed ownership, restored and completed its first sync),
so its `/health` is a refused connection, never a `200`. The previous owner keeps
answering `/health` only for the few seconds its worker takes to drain during a
hand-over, then it too has no listener.

The platform healthcheck must therefore probe **`/health`**, so that a new
deployment becomes Active only after hand-over has completed:

- **No deadlock.** Hand-over does not go through the platform. The new instance
  asks the owner through object storage while the platform still keeps the old
  instance running (the platform removes it only after the new one is Active), and
  the owner notices within one renewal interval (5 s). Waiting passively for the
  old instance to exit would deadlock; asking does not.
- **No long write outage.** The write gap is the hand-over itself: up to one
  renewal interval to notice the request, the worker's drain, the final sync, the
  release, and the successor's restore and initial sync, typically 10 to 20
  seconds of `503` + `Retry-After` for writes (reads keep working until the old
  worker stops), instead of the lease expiry (30 s) plus restore after a crash.
- **Why a liveness-only endpoint defeats it.** If the platform probed an endpoint
  that is `200` while the process merely lives (a standby included), the new
  deployment would be marked Active at once. The platform would then send the old
  instance SIGTERM and, with its default of 0 seconds of drain, SIGKILL right
  after, before ownership moved. Every deploy would become a crash takeover: a
  write outage of at least the lease expiry and a loss of up to the replication
  window, instead of a hand-over with neither the long outage nor any loss.

Set the healthcheck timeout comfortably above the worst healthy hand-over (at
least 180 seconds; it is bounded by the restore and initial-sync deadlines of
`FLEET_STARTUP_TIMEOUT_SECONDS`, 60 s each by default), so a slow restore is not
mistaken for a failed deploy.

#### Shutdown budget

Everything below is derived from the code (`SHUTDOWN_GRACE_MS` in
`src/controller.ts`; `DRAIN_GRACE_MS`, `FENCED_GRACE_MS` and the final sync in
`src/ownership/supervisor.ts`; request and retry limits in
`src/ownership/lease.ts` and `object-store.ts`). A graceful stop (SIGTERM, or the
drain of a hand-over) runs these steps in order:

| Step                                                 | Budget                                                                                                                                         | Typical  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1. Write gate closes; mutating routes answer `503`   | immediate                                                                                                                                      | 0 s      |
| 2. Worker stops (jobs, listener, database close)     | `SHUTDOWN_GRACE_MS` = 10 s, then it exits 1                                                                                                    | under 1  |
| 3. Litestream exits (its own shutdown sync included) | `DRAIN_GRACE_MS` = 50 s from the SIGTERM, then SIGKILL; covers step 2 plus Litestream's own `shutdown-sync-timeout` (30 s by default upstream) | 1 s      |
| 4. Explicit final sync (`replicate -once`)           | up to 3 attempts, each bounded by `FLEET_STARTUP_TIMEOUT_SECONDS` (60 s)                                                                       | 1 to 2 s |
| 5. Release ownership                                 | up to 5 attempts, each request limited to 10 s                                                                                                 | under 1  |
| Fenced owner instead (step 3 only)                   | `FENCED_GRACE_MS` = 15 s, then exit nonzero                                                                                                    | 1 s      |

With healthy storage the steps sum to at most 10 s (worker) + 30 s (Litestream's
own sync, if it needed all of it) + a final sync and release of a few seconds,
under 45 s, so **`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`** leaves at least 15
seconds of margin and the shutdown never relies on Litestream's own sync (Fleet
always syncs explicitly, because Litestream 0.5.17 exits without syncing when
stopped before its first sync tick). The 10 s worker grace is a sub-budget of the
60 s, not a conflict with it. The old "at least 60 s" advice is the same number.

The sum is not bounded by 60 s when object storage itself is degraded: the
explicit final sync may take up to three deadlines of 60 s. Then the platform's
SIGKILL arrives first. That is safe, not corrupting: ownership is simply not
released, so the next instance waits for the expiry (30 s by default) and loses at
most the replication window (see below).
`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` needs no tuning: a hand-over is complete
before the new deployment is Active, so the old instance is only an idle standby
when the platform stops it. Leave it at the platform default; a longer overlap is
harmless.

#### Fenced writers and restart policy

An owner that cannot renew within the fence window, or that sees a newer
generation (it was paused or partitioned and another instance took over), closes
its write gate at once, stops its worker within `FENCED_GRACE_MS` (15 s), and
**exits nonzero**. It never acknowledges a write after that and never writes to
the new generation.

What the platform's restart policy then does: a restarted container is a new
process with a new instance id, so it is a new deployment, not a standby. It asks
the live owner to hand over, exactly like a rolling deploy: one ownership change,
a brief `503` window for writes, no data loss. The previous owner then stays
behind as an idle standby until its next deploy or SIGTERM. Use a restart policy
of "on failure" with a retry limit (the hosting request below asks for 10), so a
host that keeps pausing cannot flip ownership forever. With no restart policy the
fenced container stays down and the other instance simply keeps serving.

#### Data-loss bounds

- **Hand-over** (rolling deploy; the old instance may be stopped with SIGTERM or
  killed with SIGKILL as soon as the new one is healthy): no acknowledged write is
  lost. The old owner closes its write gate before the final sync and releases
  only after it, and the new instance serves only after restoring from that final
  state.
- **Crash, SIGKILL of the serving owner, host loss:** writes acknowledged within
  the replication window before the loss can be lost: the one-second Litestream
  sync interval plus the upload time of the last segment. An object storage
  outage widens the window to the length of the outage. The next instance serves
  after the expiry (30 s by default, measured by its own clock from when it last
  saw the record change, so up to about 32 s once it is running) plus its restore
  and initial sync.
- **Paused or partitioned owner:** writes it acknowledged before it froze are
  covered by the same window; after the takeover it acknowledges nothing.

Replication is asynchronous. Do not use bucket lifecycle rules that
independently delete active replica objects.

**Generation retention.** Each owner writes its own replica under
`<prefix>/generations/<n>/`. Only the current owner deletes old generations, and
only after it has published its own generation as the authoritative `replica` in
`fleet-owner.json`. A generation is deleted only when it is more than
`FLEET_OWNERSHIP_RETAIN_GENERATIONS` (1–20, default 2) generations behind the
current one **and** its newest object is older than `FLEET_OWNERSHIP_RETAIN_DAYS`
(1–365, default 7). The current generation and the generation named by `replica`
are never deleted. Before every batch of at most 20 deletes (one batch per renewal
interval) the owner re-reads the owner record and stops if ownership is lost or a
hand-over is requested. The first sweep runs shortly after the replica is
published, then hourly. A failure is logged as a warning and never affects
serving; the next sweep resumes. The pre-ownership replica ("generation 0", written
directly under the prefix) is deleted only by exact Litestream file names under the
prefix root, and only if nothing unrecognised is stored there; if in doubt it is
kept, and you can remove it manually.

#### Monitoring

Under the supervisor, administrators can read `GET /v1/ownership` (`state`, `held`,
`generation`, `holder`, `replicaGeneration`, `renewalAgeSeconds`,
`replicaLastSyncAgeSeconds`) and these Prometheus series on `/metrics`:
`fleet_ownership_held`, `fleet_ownership_generation`,
`fleet_ownership_renewal_age_seconds` and `fleet_replica_last_sync_age_seconds`.
`fleet_ownership_held` is 1 only while this instance accepts writes; it is 0 while
handing over, draining or fenced. `fleet_replica_last_sync_age_seconds` is a
replication-lag measure, checked every 10 s: it stays near zero (under about 10 s)
while the replica holds everything the database has committed, including when
idle, and grows only while committed transactions are not reaching object storage.
Alert above about 60 s. `/health` is unchanged. Structured log events are
`ownership.acquired`, `ownership.takeover`, `ownership.handover_requested`,
`ownership.handover_noticed`, `ownership.handover_granted`,
`ownership.handover_completed`, `ownership.released`, `ownership.renew_failed` and
`ownership.self_fenced`, each with the generation and instance id and never a
credential. A fenced writer exits with status 75.

#### Every writer path goes through ownership

The Litestream supervisor (`bun run start`, the container entrypoint and
`bun run local`, which supervises the worker against loopback emulators) is the
only process that restores, replicates and starts the worker. The other commands
that touch the replica or the working file are guarded:

- `bun run access:allow` opens the local file and writes to it, so it first reads
  `<prefix>/fleet-owner.json` and **refuses** unless it can prove it is not a
  second writer: an owner record with a holder (even one that crashed and has not
  expired), a release reserved for a starting instance, an unreadable or foreign
  record, or an unreachable bucket all refuse, and so does a local file whose
  `.generation` marker does not match the authoritative replica generation (the
  change would be written to a stale copy and discarded by the next restore). The
  message points to `PUT /v1/access/:email` with the admin token, which goes
  through the running owner. There is no flag to skip the check.
- `bun run restore:drill` restores a replica into a temporary directory and refuses
  a prefix with a live owner (see the manual drill below).
- Restore drills by hand must use a copy under another prefix; the owner never
  restores into the production working file.

### Hosting request

Put these settings into the `crvouga/personal` hosting request (#162) for the
`fleet-api` service:

| Setting                 | Value                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Healthcheck path        | `/health` (200 only on the instance that owns the replica and serves)                                                  |
| Healthcheck timeout     | at least 180 seconds                                                                                                   |
| Replicas                | exactly 1 (no autoscaling; a second replica is only an idle standby)                                                   |
| Drain (SIGTERM to kill) | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`                                                                               |
| Overlap                 | `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` unset (platform default); hand-over completes before the new deployment is Active |
| Restart policy          | on failure, maximum 10 retries                                                                                         |
| Volume                  | none; state lives in object storage, the working file is disposable                                                    |
| Stop signal             | SIGTERM (the image's `STOPSIGNAL`)                                                                                     |

### Manual R2 drill

Automated checks run against Moto, and Docker drills against the real image
(`scripts/check-container.py`). They do not prove that Cloudflare R2's conditional
writes and listings behave the same. A human runs this drill once with **dev** R2
credentials and records the result in the pull request. Never use production
credentials or the production prefix.

Prerequisites: Bun 1.4.4, Litestream 0.5.17 on `PATH`, `bun install --frozen-lockfile`
and `bun run build` from the repository root, `jq`, `curl`, and the AWS CLI (or any
S3 client) for cleanup. Keep credentials out of shell history and files in the
repository.

```sh
# One disposable prefix per drill day; the rolling and crash drills get their own.
export DRILL_BASE="fleet-api/drill-$(date +%Y-%m-%d)"
export FLEET_S3_BUCKET=...          # the dev bucket
export FLEET_S3_ENDPOINT=...        # https://<account>.r2.cloudflarestorage.com
export AWS_REGION=auto
export AWS_ACCESS_KEY_ID=...        # dev credentials only
export AWS_SECRET_ACCESS_KEY=...
export FLEET_ADMIN_TOKEN="$(openssl rand -hex 32)"
export FLEET_OWNERSHIP_RENEW_SECONDS=1 FLEET_OWNERSHIP_EXPIRE_SECONDS=15  # shorter drill

start() { # start <name> <port> <prefix>: one instance with its own disk and port; read its PID from $!
  mkdir -p "/tmp/fleet-drill/$1"
  FLEET_DATABASE_PATH="/tmp/fleet-drill/$1/fleet.db" PORT="$2" FLEET_S3_PREFIX="$3" \
    bun packages/fleet-controller/src/start.ts > "/tmp/fleet-drill/$1/log" 2>&1 &
}
put() { # put <port> <email>: prints the HTTP status
  curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $FLEET_ADMIN_TOKEN" \
    "http://127.0.0.1:$1/v1/access/$2"
}
present() { # present <port>: every allowed email, sorted
  curl -s -H "Authorization: Bearer $FLEET_ADMIN_TOKEN" "http://127.0.0.1:$1/v1/access" | jq -r '.emails[]' | sort
}
healthy() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/health"; }
```

**1. Rolling deploy.** Run each step from the repository root.

```sh
P="$DRILL_BASE/rolling"
start a 8081 "$P"; A=$!; until [ "$(healthy 8081)" = 200 ]; do sleep 1; done
# Write continuously to A, logging every status (the acknowledged writes are the 200s).
( i=0; while true; do i=$((i+1)); e="drill-$i@example.test"; echo "$e $(put 8081 "$e")"; sleep 0.1; done ) > /tmp/fleet-drill/acked.log &
WRITER=$!
sleep 5
start b 8082 "$P"; B=$!                       # B asks A to hand over
until [ "$(healthy 8082)" = 200 ]; do sleep 1; done   # B is Active only after the hand-over
kill "$WRITER"
kill -TERM "$A"; wait "$A"; echo "A exit code: $?"   # expect 0
awk '$2 == 200 { print $1 }' /tmp/fleet-drill/acked.log | sort > /tmp/fleet-drill/acked.txt
present 8082 > /tmp/fleet-drill/on-b.txt
comm -23 /tmp/fleet-drill/acked.txt /tmp/fleet-drill/on-b.txt   # expect no output: no acknowledged write lost
grep -vc ' 200$' /tmp/fleet-drill/acked.log                     # writes refused (503) or unreachable (000) during the hand-over
put 8082 after-rolling@example.test                             # expect 200
present 8082 > /tmp/fleet-drill/final.txt
kill -TERM "$B"; wait "$B"; echo "B exit code: $?"             # expect 0
```

Then restore the replica as a replacement host would, and compare it with B's
final state. The drill command refuses while any instance still owns the prefix,
so run it after B has stopped:

```sh
FLEET_S3_PREFIX="$P" bun run restore:drill       # prints {"generation":...,"userVersion":...,"integrity":"ok","nodes":...,"settings":...}
start c 8083 "$P"; C=$!; until [ "$(healthy 8083)" = 200 ]; do sleep 1; done
present 8083 | diff - /tmp/fleet-drill/final.txt && echo "C restored exactly B's state"
kill -TERM "$C"; wait "$C"
```

While an instance still owns a prefix, `bun run restore:drill` must refuse (try
it once while B is serving); `--prefix <other>` restores a different prefix, for
example a copy of the replica.

**2. Crash takeover.** A fresh prefix, and kill the whole process tree of A.

```sh
kill_tree() { for c in $(pgrep -P "$1"); do kill_tree "$c"; done; kill -KILL "$1" 2>/dev/null; }
P="$DRILL_BASE/crash"
start a 8091 "$P"; A=$!; until [ "$(healthy 8091)" = 200 ]; do sleep 1; done
( i=0; while true; do i=$((i+1)); e="crash-$i@example.test"; echo "$e $(put 8091 "$e") $(date +%s)"; sleep 0.2; done ) > /tmp/fleet-drill/crash.log &
WRITER=$!
sleep 10
KILLED=$(date +%s); kill "$WRITER"; kill_tree "$A"       # no hand-over, no release
start b 8092 "$P"; B=$!
until [ "$(healthy 8092)" = 200 ]; do sleep 1; done
echo "B served $(( $(date +%s) - KILLED )) s after the kill"   # about the 15 s expiry plus restore
grep 'taking over' /tmp/fleet-drill/b/log                      # expect one match
# Every write acknowledged at least 5 s before the kill must be present.
awk -v cutoff=$((KILLED-5)) '$2 == 200 && $3 <= cutoff { print $1 }' /tmp/fleet-drill/crash.log | sort > /tmp/fleet-drill/crash-acked.txt
present 8092 > /tmp/fleet-drill/crash-on-b.txt
comm -23 /tmp/fleet-drill/crash-acked.txt /tmp/fleet-drill/crash-on-b.txt   # expect no output
awk '$2 == 200 { print $1 }' /tmp/fleet-drill/crash.log | sort | comm -23 - /tmp/fleet-drill/crash-on-b.txt | wc -l  # writes lost inside the window
kill -TERM "$B"; wait "$B"
FLEET_S3_PREFIX="$P" bun run restore:drill
```

Also confirm from the bucket listing that R2 shows the expected layout
(`<prefix>/fleet-owner.json` and `<prefix>/generations/<n>/`), and note any
difference from Moto, such as listing consistency or conditional-write status codes:

```sh
aws s3 ls --recursive --endpoint-url "$FLEET_S3_ENDPOINT" "s3://$FLEET_S3_BUCKET/$DRILL_BASE/" | head -40
```

**Clean up** after both drills, with no instance still running. Check the prefix
first; this deletes everything under it:

```sh
echo "$DRILL_BASE"                      # must be fleet-api/drill-<date>, never fleet-api or production
aws s3 rm --recursive --endpoint-url "$FLEET_S3_ENDPOINT" "s3://$FLEET_S3_BUCKET/$DRILL_BASE/"
rm -rf /tmp/fleet-drill
unset FLEET_ADMIN_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

Paste this into the pull request (fill every field; leave the template's wording
alone if a step was not run, and say so):

```text
Manual R2 drill, <date>, dev bucket <name>, prefix fleet-api/drill-<date>/
Fleet commit <sha>, Bun 1.4.4, Litestream 0.5.17
Rolling deploy
  A acknowledged <n> writes; <n> refused (503) during hand-over
  B healthy after <s> s; A exit code <0>
  acknowledged writes missing on B: <0>
  restore:drill: generation <n>, integrity <ok>, nodes <n>, settings <n>
  fresh instance C restored B's state exactly: <yes/no>
Crash takeover
  B healthy <s> s after the kill (expiry 15 s)
  writes acknowledged >= 5 s before the kill missing on B: <0>
  writes lost inside the window: <n> of <n>
  restore:drill: integrity <ok>
R2 versus Moto differences observed (status codes, listing, timing): <none/describe>
Prefix removed afterwards: <yes>
```

## Troubleshooting

| Failure stage                   | What to fix                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration                   | Set the named settings in `deployment.env`, correct their format, and include `--env-file=deployment.env`. Removed backend settings must be unset, including blank ones.                                                                                                                                                                                                                                   |
| Runtime / Litestream            | Install Bun 1.4.4 and Litestream 0.5.17; correct PATH or `FLEET_LITESTREAM_BIN`.                                                                                                                                                                                                                                                                                                                           |
| Assets                          | Run `bun install --frozen-lockfile` and `bun run build`; make the built assets readable by the service user.                                                                                                                                                                                                                                                                                               |
| Filesystem                      | Fix directory/file ownership and write access, free disk space, or choose another `FLEET_DATABASE_PATH`.                                                                                                                                                                                                                                                                                                   |
| Ownership                       | The provider refused a conditional write: check Put/Get/Delete permissions, endpoint and credentials, or use a provider with conditional writes. An unreadable `fleet-owner.json` means another Fleet version or tool wrote it; never delete it while an instance is running. `access:allow` or `restore:drill` refusing means an instance owns the prefix: use `PUT /v1/access/:email` or another prefix. |
| Restore / initial replica write | Check endpoint, region, bucket/prefix, credential validity, network connectivity and List/Get/Put/Delete permissions. Read the preceding Litestream error. Startup never falls back to unreplicated operation.                                                                                                                                                                                             |
| SQLite / schema                 | Stop other writers. Preserve corrupt files before restoring. If the schema is newer, deploy the matching newer Fleet version; never lower the schema version manually.                                                                                                                                                                                                                                     |
| Listen                          | Free `PORT` or choose an unused unprivileged port; stop the previous instance.                                                                                                                                                                                                                                                                                                                             |

`DATABASE_URL`, `FLEET_DB_PREPARE`, `FLEET_DATABASE_URL`,
`FLEET_DATABASE_AUTH_TOKEN`, and `FLEET_STORAGE_MODE` are removed and rejected.
PostgreSQL data is not imported. Start with a fresh SQLite installation or arrange
a reviewed export/import before cutover.

## Enrollment and installer publication

The core controller, dashboard and installer enrollment do not require a GitHub
repository or account. Nodes register directly with `/v1/nodes/register` using
a private per-node secret and appear under **Pending**. An authorized Fleet
owner approves or rejects them in the app. The live installer waits up to five
minutes for approval before disk changes; rejection and timeout leave disks
untouched. Its credential is copied into the installed system.

The installer installs the role-less `base` system. The controller decides what
each machine is for: approve it (optionally choosing a role), or assign, change
or remove its role later on the node page or with `PATCH /v1/nodes/:id { role }`.
A reinstalled machine keeps its hardware node id, so its stored role is applied
again after approval. A role change is a drained reboot into the new closure,
not a reinstall.

`FLEET_ENROLLMENT_TOKENS` is optional, for explicitly authorized automatic
approval. Generate a random token (for example `openssl rand -hex 32`), give it
to the installer as the optional enrollment token, and list only its hash:

```sh
token=$(openssl rand -hex 32)
printf %s "$token" | sha256sum   # the "sha256" value
FLEET_ENROLLMENT_TOKENS='[{"sha256":"<hash>","role":"ci"},{"sha256":"<hash2>","role":null}]'
```

A node presenting a listed token is approved; the entry's `role` is assigned
only when the node has none, and re-registration never clears an assigned role.
`FLEET_ROLE_TOKEN_HASHES` is no longer read: startup fails until each old
`{ "<role>": "<hash>" }` pair is moved to `FLEET_ENROLLMENT_TOKENS` as
`{ "sha256": "<hash>", "role": "<role>" }` and the old variable is unset.

Role secrets stay in the operator's repository, encrypted with SOPS. Each node
creates its own age identity on first boot and reports only the public
recipient. `GET /v1/recipients` (admin) lists the recipients of approved nodes
by assigned role; re-encrypt each role's file to them (`sops updatekeys`) and
merge. Fleet never holds a private age key or writes to Git. A node whose
recipient is missing reports itself blocked until that change is merged.

Set optional `FLEET_INSTALLER_DIR` to an absolute directory containing built
installer executables, archives, the ISO or image parts, readiness metadata, and
matching `.sha256` files. Publish native installer checksums alongside each file
(for example `fleet-installer-windows-x64.exe.sha256`). Build from this checkout;
use `packages/fleet/scripts/release-image.py` for verified ISO parts and metadata.
The app's `/installers/release` page lists downloads and `/installers/assets/`
serves only allowed artifact names. Artifacts are public read-only downloads;
keep all secrets outside that publication directory. Symlinks escaping it are
refused. Missing images are reported explicitly, with no upstream fallback.

Installer clients select this app with `FLEET_CONTROLLER_URL=https://fleet.example.org`
or enter that origin in the wizard. `FLEET_INSTALLER_URL` remains an explicit
image URL override. The image must be built with your intended `fleetApi.url`;
entering a download origin never rewrites the image's trusted approval authority.

Set optional `FLEET_HEARTBEAT_RETENTION_DAYS` (whole days, 1 to 365, default 30) to
choose how long per-node heartbeat history is kept; an invalid value refuses
startup and names the variable. Events, settings history and the audit log are
not pruned. See `packages/fleet-controller/docs/observability.md`.

Set optional `FLEET_TARGET_REVISION` to a full 40-character Git commit to display
which nodes are behind. With it unset, the desired revision is unknown; Fleet
does not query GitHub. Nodes still pull their operator-configured Git source,
which can be hosted on any suitable Git server. SSH sources use public host-key
pins supplied in `repo.sshKnownHosts`.

GitHub remains optional for CI runner roles and user-initiated bug reports.
`FLEET_BUG_REPORT_REPO=owner/name` on installer clients chooses the bug-report
repository; it never selects an image, enrollment service, or update source. The
legacy client `FLEET_GITHUB_REPO` is accepted only as a bug-report alias when
`FLEET_BUG_REPORT_REPO` is unset; the controller does not read it.
The former issue-triggered enrollment workflow has been removed.
