# GitHub Actions runners, owned by the controller

The controller holds the GitHub App credentials and is the only party that talks
to GitHub about runners. A node never holds the App private key: it asks the
controller for a short-lived registration token with its own credential. A
compromised CI node therefore cannot mint tokens for every repository the App
reaches.

```
operator ── key in env ──▶ controller ── App JWT → installation token ──▶ GitHub
                              ▲   │ registration token (1 h), job + runner sync
   node: POST /v1/runner-registration (node id + secret)
```

## Operator flow

1. **Create the GitHub App** (yours; Fleet never creates one). Repository
   permissions: _Administration: read and write_ (registration tokens, runner
   removal), _Actions: read_ (jobs and runs). For an organization scope also
   _Organization self-hosted runners: read and write_. Install it on exactly the
   repositories that may use the fleet (never on a public repository: strangers'
   pull requests would run on your machines).
2. **Give the controller the key.** Set `FLEET_GITHUB_APP_PRIVATE_KEY_FILE`
   (absolute path, mode 0600) or `FLEET_GITHUB_APP_PRIVATE_KEY` in
   `deployment.env` and restart. See `CONFIGURATION.md`. The key is parsed at
   startup; it is never stored in the database, shown or logged. A key that is
   not an RSA PEM key fails startup, naming the variable.
3. **Connect.** Open **Runners** in the dashboard. Without a key the page says
   so and shows nothing. Enter the App ID, the installation ID, the scope
   (repositories or an organization), the repositories, an optional runner group
   (organization scope) and the policy, then **Save** and **Verify connection**.
   Verify reports exactly which permission or installation is wrong, for example
   _"GitHub refused with HTTP 403: the App lacks the runner permission (repository
   Administration, or organization Self-hosted runners)"_ or, for a wrong
   installation ID, the installation IDs this App actually has.
4. **Assign the CI role** to nodes as before. Nothing GitHub-related is
   configured per machine any more: the integration's repositories and labels
   are the fleet-level default for every CI node's `runners.repositories` and
   `runners.extraLabels` (see Placement). A fleet, role or node setting for the
   same key still wins.
5. Optionally configure a webhook (below). Polling alone is enough.

### Policy

| Key                          | Default | Meaning                                                                                                                |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `extraLabels`                | `[]`    | Routing labels added to every CI node's runners that no setting overrides.                                             |
| `maxNodesPerRepository`      | `0`     | A repository is placed on at most this many nodes; `0` means every eligible node.                                      |
| `repositoryRequirements`     | `{}`    | `{"owner/name": ["gpu"]}`: only nodes whose hardware capabilities or labels include these serve it.                    |
| `orphanAutoRemoval`          | `false` | When `true` the controller deletes orphan runners after the grace period. Off: it only flags them.                     |
| `orphanGraceSeconds`         | `1800`  | How long a runner must stay an orphan before removal (60 to 2592000).                                                  |
| `syncIntervalSeconds`        | `60`    | How often the controller reads GitHub (15 to 3600).                                                                    |
| `queueStallMinutes`          | `10`    | A queued fleet job waiting this long with no idle runner able to take it opens a "queue stalled" incident (1 to 1440). |
| `noRunnersMinutes`           | `10`    | No online Fleet runner for this long while a CI node reports opens "no runners online" (1 to 1440).                    |
| `registrationFailingMinutes` | `5`     | A node's `FLEET_GITHUB_*` registration issue persisting this long opens "runner registration failing" (1 to 1440).     |

## API

| Endpoint                                                | Who            | What                                                                                                                       |
| ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/runners`                                       | signed in      | Status, capacity (slots total/busy from node reports versus queued jobs), runners with orphan and health flags, placement. |
| `GET /v1/jobs?status=&repository=&node=&before=&limit=` | signed in      | `queued`, `in_progress`, `completed`, `failed` or `active`; durations; node and slot; `reportUrl` on failed jobs.          |
| `PUT /v1/github/integration`                            | admin, audited | Replaces scope, organization, repositories, runner group, App/installation IDs and policy.                                 |
| `POST /v1/github/verify`                                | admin, audited | Calls GitHub as the App and reports every check.                                                                           |
| `POST /v1/runner-registration`                          | node           | `{ "slot": "slot-3", "repository"?: "owner/name", "idempotencyKey"?: "..." }`.                                             |
| `POST /v1/github/webhook`                               | GitHub         | Only when `FLEET_GITHUB_WEBHOOK_SECRET` is set; authenticated by `X-Hub-Signature-256` only.                               |

### Node registration

The node authenticates with `Authorization: Bearer <node id>.<secret>` (the same
credential as its heartbeat). The controller checks that the node is approved,
runs the `ci` role, is not cordoned or disabled (`runners.cordoned`,
`runners.enabled`), and that the repository is one of the node's effective
`runners.repositories`; with an organization scope and no repository it issues an
organization token. It answers `{ token, scope, url, target, runnerGroup,
expiresAt }`. The token is never stored, logged or audited; the audit entry names
the node, slot, target and outcome.

| Answer                                                                                                                                         | Node exit              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `200` token                                                                                                                                    | 0                      |
| `503 github_unavailable` + `Retry-After` (network, 5xx, 429, rate limit, circuit open)                                                         | 75 (retry)             |
| `422 github_refused` with `FLEET_GITHUB_KEY`, `FLEET_GITHUB_SCOPE`, `FLEET_GITHUB_UNCONFIGURED`, ...                                           | 78 (a person must act) |
| `403 runner_not_allowed` (`node_not_approved`, `role_runs_no_runners`, `runners_drained`, `repository_not_assigned`, `no_repository_assigned`) | 78                     |
| `401`/`403 rejected                                                                                                                            | retired`               | 78  |
| `429 rate_limited` (30 requests per node per minute)                                                                                           | 75                     |

Concurrent requests for one (node, slot, target) share one GitHub call; a retry
with the same `idempotencyKey` within two minutes replays the answer. The node
side is `packages/fleet/scripts/runner_control.py register`: with a
controller address (`settings.fleetApi.url`) and no local App key it uses this
endpoint; a node that still holds the legacy key file keeps registering directly.

## The sync job

Every 15 seconds the scheduler runs `jobs/github-sync.ts`, which decides for
itself whether it is due (interval, backoff). It is level-triggered and
idempotent, so a restart at any point repeats the same decisions:

- reads runners (per repository, or the organization) and the queued, running and
  recent workflow jobs, and upserts `github_runners` and `ci_jobs`. A job never
  moves to an earlier state, and jobs still active in the database are always
  re-read so they converge. Each pass is bounded (64 repositories, 60 job
  fetches, 100 runners per page, 20 pages).
- correlates runner names `<hostname>-<node id prefix>-slot-N` to nodes;
- flags **orphans**: a Fleet runner whose node is unknown, retired or rejected,
  has left the `ci` role, has been offline longer than the node offline
  threshold, or an offline runner that is not busy. A runner that does not match
  the Fleet naming (your laptop, another runner) is never touched;
- if `orphanAutoRemoval` is on and the runner has been an orphan for the grace
  period, deletes it. **A busy runner is never deleted**; GitHub itself also
  refuses (422), which is recorded and skipped;
- removes the routing labels of runners on cordoned or disabled nodes (the
  controller does what `fleet-drain` could do with the App key; the node's own
  admission gate stays authoritative);
- records `placement` events and `runner.*` audit entries.

When GitHub fails the integration status becomes `degraded` (temporary: network,
5xx, 408, 429, primary and secondary rate limits, honoring `Retry-After` and
`X-RateLimit-Reset`) or `error` (permanent: 401 bad key, 403 missing permission,
404 wrong installation or scope), with a public `last_error` such as
`FLEET_GITHUB_KEY: GitHub refused the App credential (HTTP 401)...`. Response
bodies, tokens and keys are never logged or stored. Calls use bounded
exponential backoff with jitter; after three consecutive temporary failures, or
one rate limit, a circuit opens and calls fail fast until the wait is over.
Status changes record an event and an audit entry.

## Runner health incidents

After every successful sync the controller checks, from the data it just
mirrored, whether the fleet is actually serving jobs, and records one event per
change (so incidents open and close once, and a restart repeats nothing):

- **Job queue stalled** (`runner_queue_stalled` / `runner_queue_ok`): a queued
  job that asks for fleet labels (`self-hosted` with `nixos` or `ci`) has waited
  longer than `queueStallMinutes` and no online, idle runner can take it.
- **No CI runners online** (`runners_offline` / `runners_ok`): GitHub lists no
  online Fleet runner for `noRunnersMinutes` while an approved CI node is online,
  which means registration is failing.
- **Runner registration failing** (`runner_registration_failing` /
  `runner_registration_ok`, per node): the node reports a registration problem
  (`FLEET_GITHUB_KEY`, `FLEET_GITHUB_SCOPE`, `FLEET_GITHUB_UNAVAILABLE`,
  `FLEET_RUNNER_RESTARTING`, ...) for `registrationFailingMinutes`.

They show on **Runners** (a "Runner health" panel), on **Incidents** and as the
metrics `fleet_runner_queue_stalled`, `fleet_runners_online` and
`fleet_ci_jobs_queued_oldest_seconds` (omitted while the integration is
unconfigured or its mirror is stale). If `alerts.webhookUrl` is set, each opening
and closing is also posted there. Closing waits two minutes for the condition to
stay gone, so a value hovering at a threshold does not flap. See
[`automated-checks.md`](automated-checks.md) for what this does and does not prove.

## Placement

For a repository-scoped integration the controller spreads the repositories over
the eligible CI nodes (approved, `ci`, not cordoned or disabled) with
rendezvous hashing: stable (adding or removing a node moves only the repositories
that node wins or loses), respectful of `maxNodesPerRepository`, capability
requirements and each node's reported slot count, and fair under capacity
pressure (every repository gets a first node before any gets a second).
A repository with no eligible node is shown as unplaced. The result is a derived,
lowest-priority settings layer per node (`placement:<node id>`, never stored);
the desired revision of a node changes only when its own placement changes.
Every change is a `placement` event and an audit entry.

## Webhook (optional)

Create a webhook on the App or repositories with URL
`https://<controller>/v1/github/webhook`, content type `application/json`, the
secret from `FLEET_GITHUB_WEBHOOK_SECRET` and the events _Workflow jobs_ and
_Workflow runs_. The controller verifies the HMAC in constant time before
parsing, rejects bodies over 60 KiB, acknowledges a repeated `X-GitHub-Delivery`
without handling it twice, stores `workflow_job` events and asks the poller to run
now on `workflow_run`. A bad signature is a `401` and an audit entry (without the
payload). If a delivery is lost nothing breaks: polling reads the same state.

## Failure modes

| Symptom                                  | Cause and action                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Page says "no GitHub App private key"    | Set `FLEET_GITHUB_APP_PRIVATE_KEY(_FILE)` and restart.                                                                                |
| `FLEET_GITHUB_KEY`                       | Wrong App ID or key, or the key was revoked. Generate a new key in the App settings.                                                  |
| `FLEET_GITHUB_SCOPE` on the installation | Wrong installation ID, or the App was uninstalled. Verify lists this App's installation IDs.                                          |
| `FLEET_GITHUB_SCOPE` on a repository     | The App is not installed there or lacks Administration (or organization Self-hosted runners) / Actions: read.                         |
| Runner unit keeps restarting on a node   | The node's last answer is on its console and in its readiness issues: `runners_drained`, `repository_not_assigned`, `FLEET_GITHUB_*`. |
| Status `degraded`                        | GitHub or the network is failing or rate limiting; the controller retries by itself.                                                  |

## Migrating a deployment that has the key on every node

1. Configure the controller as above and **Verify connection** until it is green.
2. Check that **Runners** shows your runners and jobs and that placement matches
   what you expect.
3. In Git: clear `appId` and `installationId` in `settings/github.json`, remove
   the `github-app-key` entry from the CI role's SOPS file, and `sops updatekeys`
   as usual. `modules/ci-runner.nix` then no longer declares the secret, and a node
   registers through the controller. Until then a node that still has the key keeps
   using it.
4. The controller no longer reads a node's static `settings/github.json`
   repositories: a repository a node may register for must be in the integration
   (or in a fleet, role or node `runners.repositories` setting), otherwise the
   controller answers `repository_not_assigned`.
5. Rotate the App key in GitHub; the old copies on nodes are now worthless.

Node-side `hold`, `withdraw`, `drain` and `status` of `runner_control.py` still
use the legacy key. Without it `fleet-drain` reports `FLEET_GITHUB_DRAIN_DEGRADED`
and relies on its local admission gate and job markers (already authoritative);
the controller removes labels of cordoned nodes and deletes orphan runners of
retired nodes itself.

## What this does and does not do about idle resources

Ephemeral runners exit after one job, and slot count follows each node's CPU and
memory. The controller adds visibility (queued and running jobs against free
slots, runners that sit idle or orphaned, repositories nobody can serve) and
removes stranded runners. It does **not** power nodes down or park runners on
demand; a queue-aware `runners.enabled` or `maxIdleNodes` policy is not part of
this change, so "avoid unnecessary idle consumption" is only partially met.

## Not verified here

The Nix changes (`modules/runners.nix`, `ci-runner.nix`, `onboarding.nix`,
`outputs.nix`) could not be evaluated on the machine this was written on (no
Nix). Run `bun run check:nix` on Linux. The GitHub integration itself is tested
against a loopback fake, never the real API.
