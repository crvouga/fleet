# Automated checks

## H: GitHub contract tests

Purpose: the controller's GitHub client, its loopback fake GitHub
(`test/github/testing/fake-github.ts`) and the issue-reporting client with its
fake (`test/issues/fake-issues-api.ts`) must agree with GitHub's published REST
API, so a fake that drifts from reality fails a test instead of hiding a bug.

Run: `bun test test/github/contract` from `packages/fleet-controller` (about
0.3 s, no network; it is part of `bun run test:unit`).

What is vendored: `test/github/contract/openapi.subset.json`, a trimmed subset
of `github/rest-api-description` (the 2022-11-28 API version the client sends)
at a pinned commit: only the operations Fleet calls, the `workflow_job` /
`workflow_run` / `ping` webhook payload schemas and the components they
reference, without descriptions or examples (about 120 KB). `SOURCE.md` records
the repository, commit, file, sha256, retrieval date and the MIT license. The
list of operations lives in `test/github/contract/selection.ts`.

Bump the pin (a maintainer, deliberately; tests never fetch):

```sh
bun run scripts/refresh-github-openapi.ts <40-hex commit sha>
bun test test/github/contract
```

The script is deterministic (same commit, same bytes); `--file <local copy>`
works offline. A failure after a bump shows what GitHub changed.

What the tests do:

- `openapi.ts` and `json-schema.ts` are a small OpenAPI 3.0 validator (types,
  nullable, required, enum, bounds, pattern, date-time, additionalProperties,
  allOf/anyOf/oneOf; other formats lenient) with `assertRequestConforms(method,
path, query, body)` and `assertResponseConforms(method, path, status, body)`.
  Path templates are matched, undeclared or ill-typed query parameters, path
  parameters and bodies are rejected, and a status GitHub does not document for an
  operation is rejected unless it is a generic error (401, 403, 404, 408, 429,
  5xx), which is then checked against `basic-error`. `openapi.test.ts` has the
  negative cases.
- `recorder.ts` wraps `fetch` so every request and every answer is captured.
  `github-client.test.ts` runs the real `GithubClient` against the fake;
  `controller-flows.test.ts` runs the whole controller (sync, orphan removal,
  label removal, verify, node registration, organization scope, rate limiting,
  webhook delivery) through the recorder; `issues-client.test.ts` does the same
  for issue reporting (create, list with pagination, comment, read state, lost
  answer, closed issue). Each exchange also checks the headers GitHub requires
  (`Authorization`, `Accept`, `X-GitHub-Api-Version` equal to the vendored
  version, `User-Agent`) and the rate-limit headers (`x-ratelimit-*` integers,
  `Retry-After` whole seconds).
- Fake answers are built from the vendored schemas (`skeleton.ts`: every
  required property, then the fields the fake models laid over it), so a fake
  cannot silently omit what GitHub always sends. Webhook fixtures
  (`test/github/testing/webhook-payloads.ts`) are validated against GitHub's own
  `webhook-workflow-job-*`, `webhook-workflow-run-*` and `webhook-ping` schemas
  and delivered to the real endpoint.
- `coverage.test.ts` fails when `src/github` or `src/issues` mention an API
  path or HTTP method that is not in the subset (and not in
  `ALLOWED_OUTSIDE_DESCRIPTION` with a reason), when a new file starts talking to
  GitHub, when the node-side `runner_control.py` uses an endpoint outside the
  subset, or when an operation in the subset is not run by any contract test.
  To add a GitHub call: add it to `selection.ts`, refresh, add it to
  `EXERCISED` and exercise it in a contract test.

Discrepancies found when this was introduced:

- Real code: a queued job's `started_at` is never null on GitHub (it is the
  creation time), so `jobFromGithub` stored it and the dashboard showed 0 s of
  queue time for a waiting job. Fixed in `src/github/normalize.ts`: a queued job
  has no start.
- Fake GitHub: runners had no `os`; jobs had `started_at: null`; runs and
  repositories carried only the fields the code reads; the label-removal answer
  was `{labels: string[]}` instead of `{total_count, labels: runner-label[]}`;
  `/installation/repositories` ignored `per_page` and `page`; error bodies had
  no `documentation_url` (required for 422); no `x-ratelimit-*` headers.
- Fake issues API: created issues lacked ~15 required fields (`id`, `user`,
  `comments`, ...), labels were strings, the comment answer was `{id}`, and
  error bodies had no `documentation_url`.
- Webhook fixtures in `webhook.test.ts` were partial payloads (no `sender`,
  full repository, ...); they now come from `webhook-payloads.ts`.

Does not prove: that real GitHub behaves as its description says (the
description is itself imperfect, for example it lists `started_at` as required
on jobs and documents no 429), authentication (the fake checks a JWT or token,
GitHub also checks permissions and installation scope), ordering, caching or
rate-limit arithmetic, the GitHub Enterprise Server variants, or the node-side
Python client's behavior (only the endpoints it names are scanned). Responses
GitHub documents but the client never sees (for example 301) are not driven.
Live behavior is covered by the live-GitHub checks, not here.

## G: end-to-end chain, migration, post-deploy

### Runner registration through the real controller (`packages/fleet/tests/test_e2e_chain.py`, class `RunnerRegistrationChainTest`)

Run (from `packages/fleet`, needs `bun`, `curl`, `python3` and `openssl`; about
20 s): `python3 -m pytest tests/test_e2e_chain.py -k RunnerRegistration -p no:cacheprovider`.

What runs for real: the controller process (`test/e2e/stack.ts`, SQLite, real
routes and GitHub client), the real `agent.py` enrolling and heartbeating against
fake node file trees, and the real `runner_control.py register`. What is fake:
GitHub, replaced by the loopback `tests/fake_github.py` (installation token,
registration token, runner/run/job lists; it verifies the RS256 App JWT with
`openssl`, requires an issued installation token on every other call, records
every request, and fails on demand with 503, 429 + `Retry-After`, 401, 403, 404).
The controller gets the throwaway App key and `FLEET_GITHUB_API_URL` in its own
environment only; the test process and every node never have the key.

Scenarios and what each proves:

| Scenario                                                                                                                              | Proves                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| enroll with a token, role `ci`, heartbeat delivers runner repositories, `register`                                                    | exit 0; token file is 0600 in a 0700 directory and equals what GitHub issued; one App-JWT mint and one registration call; the call used the installation token; no key material in any node file; token and key absent from node output, controller log and audit; audit entry names the node |
| three concurrent registrations for one slot                                                                                           | one GitHub registration-token call; all three nodes' files hold the same token; another slot is a separate call                                                                                                                                                                               |
| repository not assigned, cordoned (and reopened), role without runners, pending node, revoked credential, forged secret               | exit 78 with the public code (`repository_not_assigned`, `runners_drained`, `role_runs_no_runners`, `FLEET_CONTROLLER_AUTH`), no token file, not retried, and GitHub is never asked for a token; refusals are audited as `denied`                                                             |
| 429 twice with `Retry-After: 1`, then success                                                                                         | the controller waits as told and the node sees exit 0                                                                                                                                                                                                                                         |
| 429 with `Retry-After: 120`                                                                                                           | exit 75, the node waits at most its 10 s cap between its three attempts, GitHub is asked once (the controller's circuit shields it)                                                                                                                                                           |
| 503 until cleared                                                                                                                     | exit 75 with `FLEET_GITHUB_UNAVAILABLE`, no token file, status file records 75, bounded calls to GitHub; after recovery the same node registers (exit 0) with no operator action                                                                                                              |
| 404, 403, 401 on the registration call; 401, 404 on the installation token                                                            | exit 78 with `FLEET_GITHUB_SCOPE` or `FLEET_GITHUB_KEY`, never retried, GitHub's own message and every token or key absent from output and status file; a 401 re-mints the installation token exactly once; the node registers again after the fix                                            |
| v2-style agent (register with `role`/`roleToken`, bare heartbeat without telemetry, hardware or reconcile, unknown extra key, `v: 3`) | accepted, role not taken from the node, no credential hint, a future protocol version is a clear 400                                                                                                                                                                                          |
| node that still has a local App key file                                                                                              | registers directly with GitHub with its own signed JWT, the controller is not asked (no audit entry); without the key file the same node goes through the controller                                                                                                                          |

The `runner_control.py` child runs under a small wrapper written by the test
(`e2e_support.run_runner_control`) that records `time.sleep` instead of sleeping
(so exit-75 scenarios are fast and the waits can be asserted) and, for the legacy
path only, redirects `https://api.github.com` to the fake. Where the machine's
Python lacks PyJWT, an `openssl`-based stand-in is put on `PYTHONPATH` for the
child; the controller path never calls it.

Does not prove: anything about real `api.github.com`, GitHub's real permission
model, that a real `Runner.Listener` registers with the token, the NixOS units
(`runners.nix`, `fleet-drain`), time-based behavior (token expiry, the two-minute
idempotency replay window), or the replacement controller after a restart. The
scenarios share one controller process and a new GitHub client is forced between
them (a never-used installation id) so open circuits and remembered refusals do
not leak across scenarios.

### Populated schema v2 migration (`test/db/migration-v2.test.ts`)

Run: `bun test test/db/migration-v2.test.ts` (0.5 s). `test/db/fixtures/schema-v2.sql`
is the version 2 schema exactly as it was before the v3 change
(`git show 2b3fe38^:packages/fleet-controller/src/db/schema.sql`);
`migration-v2-fixture.ts` fills it with eight nodes in every approval state (with
observed state, labels, hardware and reconcile JSON), heartbeats with telemetry
JSON, events, three settings scopes with history, three allowlisted people,
access audit, a live and an expired browser session and a login transaction.
The test runs the real `createDb` upgrade and checks:

- version 3, and every row of every old table identical (full row dumps before
  and after, restricted to the old columns), no foreign key violation,
  `integrity_check` ok;
- `settings.revision = 0` for every existing scope, `allowed_emails.role = 'admin'`
  for every existing person, and through the real access store the signed-in
  owner's session is still an allowed admin (lockout regression);
- all ten new tables exist and are empty; the migrated schema equals a fresh v3
  schema object by object: normalized `sqlite_master` SQL of tables, indexes
  (unique and partial included), column info and defaults, foreign keys, index
  columns and order;
- the real store still registers, records heartbeats (history keeps the old
  rows), accepts a revisioned settings write (and rejects a stale one), audits,
  and the allowlist enforces roles and the last-admin rule;
- re-running the upgrade changes nothing; a database from a newer release is
  refused untouched; a failure half-way (a pre-existing `operations` table) rolls
  back the altered columns and new tables and leaves version 2 and every row
  intact, and the retry after removing the obstacle succeeds; a dangling
  reference is rolled back, not upgraded.

Does not prove: upgrade time or memory on a large production database,
Litestream replication of the upgrade, or a v1 database upgraded straight to v3
beyond what `migration.test.ts` already covers.

### Post-deploy gate

`packages/fleet-controller/scripts/post-deploy-check.ts` (Bun, no dependencies,
read-only):

```sh
FLEET_URL=https://fleet.example.com FLEET_ADMIN_TOKEN=... \
  bun packages/fleet-controller/scripts/post-deploy-check.ts \
  [--expect-schema 3] [--timeout 10] [--retries 5] [--backoff 2] [--require-github]
```

It waits for `/health` (retries with doubling backoff on connection errors and
502/503/504 only), then checks: `no-store` on health and `/v1` replies;
`GET /v1/nodes` is 401 with no credentials and with a wrong token; the real
admin token reads `/v1/nodes` (no secret hash in the body), `/v1/summary`,
`/v1/audit`; the schema markers; and `/v1/runners`, reported as `ready`,
`unconfigured`, `unavailable` (not available in this mode), `degraded` (warning)
or `error`. Unconfigured and unavailable do not fail unless `--require-github`;
`error` always fails. The URL must be https (plain http only for loopback) and
without credentials; the token comes only from the environment, is replaced by
`[redacted]` in any output, and redirects are refused so it cannot be sent
elsewhere. Exit 0 passed, 1 a check failed (each failure line says what to look
at), 2 bad usage or configuration.

The controller exposes no schema version number, so `--expect-schema 3` is
inferred from endpoints that exist only at that schema (audit log, settings
`revision`, operations); an older release or a missed upgrade fails with that
named. The check cannot read the database; `scripts/check-container.py` does,
inside the container.

Tests: `bun test test/scripts/post-deploy-check.test.ts` runs the script
in-process and as a process against the real controller (SQLite, loopback fake
GitHub) served over HTTP, and against wrapped copies of it for: pass, GitHub
unconfigured, `--require-github`, ready, error, wrong token, controller down
(retries then fails after exactly the configured attempts), still starting (503
then healthy), permanent 503, 500 not retried, an unauthenticated API, cacheable
responses, a pre-schema-3 release, redirects, and the command line exit codes.

Workflow: `.github/workflows/post-deploy.yml` (hosted runner, `contents: read`,
`workflow_dispatch` and `workflow_call`, no pull request trigger) uses the
repository variable `FLEET_CONTROLLER_URL` and the secret `FLEET_ADMIN_TOKEN`,
and ends with a notice, not a failure, when either is missing. `publish.yml`
is not changed: the deploy is a `repository_dispatch` to the infrastructure
repository, so the image publishing run ends before the new version is serving.
Call the workflow after that deploy (see the comment in the file), or run it by
hand.

Container schema check: `scripts/check-container.py` now reads
`PRAGMA user_version` read-only inside the container (`docker exec ... bun -e`)
after the first start, after a restart and after a restore from the replica, and
requires 3 plus a readable `/v1/audit` with `no-store`. It needs Docker and Moto
and runs in `publish.yml`; it was not run where this was written (no Docker).

Does not prove: that the check passes against the real deployed controller (the
variable and secret must be set and the first run reviewed), TLS certificate
quality beyond what `fetch` verifies, or that GitHub works (only the status the
controller reports; the live GitHub checks cover that).

## I: NixOS VM test for the runner path

Purpose: prove, in a booted NixOS machine, that the controller-brokered runner
path works with the real `ci` role: a node with no GitHub App gets its
registration token from the controller, the runner slots follow the admission
gate, and the new systemd resource control is really applied.

**This test has never run.** It was written on a machine without Nix, so
nothing in `packages/fleet/tests/runner-registration.nix` has been evaluated and
no VM has booted. The first CI run of `checks.runner-registration-vm` is the real
verification. Expect to fix small things then (an option name, a message, a
timing). Everything that could be checked without Nix was (see "What was run
without Nix").

Where it lives:

- `packages/fleet/tests/runner-registration.nix`: the `runNixOSTest` (one VM,
  `hosts/ci.nix`, `settings.fleetApi.url = http://127.0.0.1:8099`, no App ID, no
  repositories, no secrets file). Only the `Runner.Listener` is replaced by a
  mock; the token provider, `runner-control`, the agent, `fleet-drain` and
  `fleet-resume` are the real ones.
- `packages/fleet/tests/runner_registration_vm.py`: the test script, plain Python
  (read with `builtins.readFile`). The NixOS test driver type checks it with `ty`
  and lints it with `ruff --select F`.
- `packages/fleet/tests/runner_registration_broker.py`: the fake controller, a
  loopback HTTP server (Python standard library) started by a `Type=notify` unit
  ordered before `fleet-agent`. It answers only what the node calls:
  `/v1/nodes/register`, `/v1/heartbeat` and `/v1/runner-registration`. A word in
  `/run/fake-controller/registration` (`ok`, `unavailable`, `forbidden`,
  `notfound`) and in `.../heartbeat` (`minimal`, `future`) switches its answers.
  It records every request, without secrets, in `requests.jsonl`, and every token
  it issued (fake ones) in `issued.jsonl`.
- Registered in `packages/fleet/outputs.nix` as `runner-registration-vm` and in
  the `lifecycle` group of `packages/fleet/scripts/ci-checks.py` (the lighter of
  the two VM groups: `lifecycle` and `follow-up`; `runtime` already has five VM
  tests under one 12 minute budget). Successful derivations are cached per
  derivation, so a rerun after an unrelated failure does not boot it again.

What it proves (when it passes):

1. Both slot units start with no App key and no App ID on the node. The token
   was requested with the node's own credential (the broker authenticated
   `<node id>.<secret>` against what the agent registered), without naming a
   repository (the controller chooses), and with one idempotency key.
2. The token file is `600 root root` in a `700` directory and holds a token the
   controller issued; the listener's `configure` received exactly that token
   (`--token`) and the module's placeholder URL; the controller's repository is
   in `/run/fleet/assign-used/slot-1`. The Runner.Listener wrapper that turns
   that record into the real URL is not in the VM (the mock replaces it); it is
   run by `tests/test_node_scripts.py`. The token is in no journal.
3. `systemctl show` reports the declared `Slice=fleet-ci.slice`, `CPUWeight=100`,
   `IOWeight=100`, `TasksMax=16384`, `OOMScoreAdjust=500` for each slot; the slice
   has `MemoryHigh`/`MemoryMax` of 88% and 92% of `MemTotal` (within 2%) both as
   unit properties and as the kernel's `memory.high`/`memory.max`; the slot's
   cgroup is inside the slice; the listener's `/proc/<pid>/oom_score_adj` is 500
   and the agent's is -500; the sandbox settings are intact (`NoNewPrivileges`,
   `ProtectSystem=strict`, `PrivateTmp`, `PrivateUsers`, `DynamicUser=no`,
   `UMask=0077`, `Restart=always`).
4. A 503 with `Retry-After` makes `runner_control.py register` ask three times
   with one key and exit 75 (journal: `status=75`), the unit restarts itself
   (`NRestarts`) with a new key, the node reports `FLEET_GITHUB_UNAVAILABLE`, and
   the slot comes back by itself once the broker answers again.
5. A 403 `runner_not_allowed` (`runners_drained`) exits 78 (journal:
   `status=78`), keeps the slot down while it keeps asking, and the public reason
   is in `/run/fleet/register/slot-1.json` and in the readiness issues of the next
   heartbeat. A 404 (a controller that predates the endpoint) is a clear
   `FLEET_RUNNER_NOT_ALLOWED` refusal.
6. With the gate closed (`fleet-drain`) or the node withdrawn
   (`/nix/fleet-state/withdrawn`) no slot starts and the controller receives no
   registration request, even after longer than `RestartSec`; `fleet-resume`
   brings the slots back.
7. Version skew, the agent's side: heartbeat answers without `desired`,
   `credential` or `maintenance`, and with fields the node has never heard of,
   are accepted (`fleet-agent once` succeeds, no credential rotation is
   attempted).
8. The legacy branch is still chosen when an App ID, installation ID and key file
   exist: `runner-control register` with an unusable key stops with
   `FLEET_GITHUB_KEY` (exit 78) and the broker receives no request.

What it does not prove:

- That the real Runner.Listener registers with GitHub (the mock never talks to
  GitHub; the VM has no internet) or that a real job runs. The live check is
  agent J's workflow.
- That the real controller answers like the broker. The broker mirrors
  `src/routes/runner-registration.ts` and `PROTOCOL.md` by hand; the Python
  full-chain test (`tests/test_e2e_chain.py`) runs the real controller.
- A full legacy node (a slot unit with `appId` in settings and a decrypted key
  under sops): that needs a second node and GitHub. Covered by
  `tests/test_runner_registration.py` and by branch 8 above.
- Newer-agent/older-controller beyond the 404 case, and an older agent against
  this controller, which needs two agent versions.
- The real memory behaviour under pressure (OOM ordering is only checked as
  configured values and `oom_score_adj`).

What was run without Nix (all on the development machine):

- `tests/test_runner_registration_vm_static.py` (29 tests): a Nix lexer checks
  every `.nix` file under `packages/fleet`, and the ones changed since
  `2b3fe38`, for balanced delimiters; the check is registered in `outputs.nix`, in
  the `justfile` and in a `ci-checks.py` group; the test script compiles, uses only
  names the test driver provides, and has no unused import or placeholder-less
  f-string; the options set by the changed modules are in a reviewed allow-list;
  and the broker is driven by the real `runner_control.py`, the real
  `node_readiness.py` and the real `agent.py once` (all outcomes above except the
  systemd ones).
- The same file found a real bug in the earlier change set: the
  `fleet-node-scripts` derivation did not contain `runner_job.py`, which
  `telemetry.py` imports, so the installed `fleet-agent` could not start. Fixed in
  `modules/fleet-tools.nix`; `ScriptBundles` now checks every bundle separately
  (the older packaging test pooled all bundles and could not see it).

Reading a failure of `checks.runner-registration-vm`:

- In the CI log of the `lifecycle` group, search for `fleet-runner-registration`.
  The driver prints each step as `must succeed: <command>` or
  `waiting for success: <command>`; the last one printed is the one that failed.
  The step name and the Python traceback point at a line of
  `runner_registration_vm.py`; the assertion messages carry the observed values
  (for example the `systemctl show` dictionary or the broker request).
- Evaluation errors (before any VM boots) mean a Nix mistake in
  `runner-registration.nix` or in the modules; `nix eval` of the check shows
  them. A `ty` or `ruff` message at the start is the test script's lint.
- To look at what the node did, the driver log includes the serial console: the
  journal lines of `github-runner-slot-1`, `fleet-agent` and `fake-controller`.
  Locally on Linux: `nix build -L path:packages/fleet#checks.x86_64-linux.runner-registration-vm`
  (or `nix run` of its `driver` for an interactive `machine`), then read
  `/run/fake-controller/requests.jsonl` and `/run/fleet/register/slot-1.json` on
  the machine.
- Timing-sensitive steps are the `wait_for` calls (each 90 to 120 s) that depend
  on `RestartSec=15s`; a timeout there means the unit did not retry. The two
  least certain assumptions: that `systemctl restart` of a unit whose
  `ExecStartPre` fails returns promptly (its status is ignored, only the outcome
  is asserted), and that the `fleet-ci.slice` cgroup exposes `memory.high` (if the
  memory controller is not enabled for the parent, the read fails and says so).

## J: live GitHub contract, canary and queue-stall detection

Three layers that raise confidence that a GitHub Actions runner comes up on this
fleet, split by where they can safely run. This repository is public, so nothing
here uses a self-hosted runner, a pull-request trigger with secrets, or a
credential from this machine; the live and canary checks skip cleanly when they
are not configured.

| Layer                         | Runs where                                           | Needs                       | Catches                                                                                         |
| ----------------------------- | ---------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| Queue-stall and runner health | the controller, after every GitHub sync              | the GitHub integration      | queued jobs nobody serves, no runner online, nodes that cannot register (continuously, no jobs) |
| Live GitHub contract          | this repository, weekly and on demand, hosted runner | a dedicated test GitHub App | GitHub or an App permission changed under us; the client no longer works against the real API   |
| Canary workflow (template)    | a private consumer repository, daily, on a runner    | a trusted private project   | the end-to-end path: routing, pickup time, checkout, symlinks, devShell, toolchain, browser     |
| Workflow safety test          | `bun test ./scripts`, every PR                       | nothing                     | a workflow in this public repository that exposes a runner, a secret or a write token to a fork |

### Live GitHub contract (check 5)

`packages/fleet-controller/scripts/live-github-contract.ts` drives the
controller's real `src/github` client against a dedicated **test** GitHub App on
a throwaway private repository or organization. It registers no runner and runs
no job. Steps, each reported as one check:

1. `config`: the `FLEET_LIVE_GITHUB_*` variables are complete and well formed.
2. `app_jwt`: the App JWT is accepted (`GET /app`).
3. `installation_token`: an installation token is minted and its `expires_at` is in the future.
4. `installation_reach`: the installation lists the target (repository scope).
5. `runners_list`: runners are listed, page by page (the page count is reported).
6. `registration_token`: a registration token is minted, its shape is asserted
   (8 to 512 characters of `[A-Za-z0-9_-]`) and its expiry is in the future and
   within two hours, then it is dropped.
7. `rate_limit`: `X-RateLimit-*` headers were present; remaining budget, reset
   time and resource are reported (a budget under 100 is flagged, not failed).

Failures are classified from the client's own public code and HTTP status, never
from a response body: `bad_credential` (wrong App ID or key), `wrong_installation`,
`target_unreachable` (App not installed on the target, or 404),
`missing_runner_permission` (403 on listing: names _Administration_ for a
repository or _Self-hosted runners_ for an organization),
`missing_runner_write_permission` (listing works, minting a registration token
403: "Read and write" is needed), `bad_token`, `missing_rate_limit_headers`,
`temporary` (rate limit, 5xx, network: exit 2, says nothing about the contract)
and `unexpected` (error class name only). The script prints a redacted human
summary, then (`--json`) only the machine-readable result on stdout,
`--result-file <path>` writes the same JSON, and `GITHUB_STEP_SUMMARY` gets a
table. Exit 0 pass or skipped, 1 contract broken, 2 temporary.

Secrets: the registration token is never printed, logged, written to a file or a
summary (it is not even held past the check), the private key is only parsed, the
target is shown as `o***/r***`, and unknown errors are reported by class name.
`::add-mask::` is deliberately not used: it would put the value on stdout, which is
the one place it must never be.

Run it without any variables to see it skip: `bun packages/fleet-controller/scripts/live-github-contract.ts`
(exit 0, a notice). With only some variables set it fails and names them.

Workflow: `.github/workflows/live-github-contract.yml` (`Live GitHub contract`),
weekly (`schedule`) and `workflow_dispatch` only, `ubuntu-latest`, `contents:
read`, bun 1.4.4 from npm, a concurrency group and a 10 minute timeout. The
secret is mapped into the one step that runs the script; a guard step skips the
job with a notice and success when it is unconfigured. The header of the file
explains how to create the App: a dedicated test App with _Repository
Administration: read and write_ (or _Organization Self-hosted runners: read and
write_), installed on a throwaway private repository or organization only; set
the variables `FLEET_LIVE_GITHUB_APP_ID`, `FLEET_LIVE_GITHUB_INSTALLATION_ID`,
`FLEET_LIVE_GITHUB_TARGET`, `FLEET_LIVE_GITHUB_SCOPE` and the secret
`FLEET_LIVE_GITHUB_APP_PRIVATE_KEY`, then run it once by hand.

Tests: `bun test test/scripts/live-github-contract.test.ts` (in
`packages/fleet-controller`) run the logic against the loopback fake GitHub:
happy path with 230 runners over three pages, an organization target, skip with
no variables or empty strings, partial and malformed configuration, every
classified failure (wrong App ID, wrong installation, not installed, 404,
missing Administration, missing Self-hosted runners, read-only registration,
rate limit and outage as exit 2, expired or oddly shaped token, missing headers,
low budget), and the script as a real process (JSON only on stdout, exit codes,
annotations, files) with a canary string proving no token, key or full target
name leaks.

Proves: the real client and the permission model work against real GitHub today,
including registration-token minting, which is exactly what a node asks the
controller for. Does not prove: that a runner binary registers or a job runs (no
runner exists), that the _production_ App has the same permissions (a separate
App is used on purpose), or anything about organizations other than the target.
The numbers (`runners_list` count, rate limit) are for the throwaway target only.
Never run against production credentials from CI.

### Runner health incidents (check 7, controller side)

The controller already mirrors `ci_jobs` and `github_runners`. After every
successful sync pass `jobs/runner-health.ts` evaluates `src/domain/runner-health.ts`
(pure, no GitHub calls) and records one event per change:

| Rule (incident)       | Opens (event)                 | Closes (event)           | Condition                                                                                                                                                                        |
| --------------------- | ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_queue`        | `runner_queue_stalled`        | `runner_queue_ok`        | a queued job asking for fleet labels (`self-hosted` and `nixos` or `ci`) waited longer than `queueStallMinutes` (10) and no online, idle runner can take it (repository, labels) |
| `runners_offline`     | `runners_offline`             | `runners_ok`             | zero online Fleet runners for `noRunnersMinutes` (10) while at least one approved CI node is online: registration is failing                                                     |
| `runner_registration` | `runner_registration_failing` | `runner_registration_ok` | a reporting CI node has a `FLEET_GITHUB_*` / `FLEET_RUNNER_*` registration issue in its readiness for `registrationFailingMinutes` (5)                                           |

Thresholds are the GitHub integration policy (`queueStallMinutes`,
`noRunnersMinutes`, `registrationFailingMinutes`, 1 to 1440, validated like the
other policy keys, editable on the Runners page). Semantics:

- Once per change: an open incident is not announced again unless it worsens
  (queue wait past three times the threshold, or a registration problem that
  turns from transient to permanent: `warn` to `error`, the same escalation as
  other incidents). Closing needs the condition to be absent for 120 s, so a
  value hovering at a threshold cannot flap.
- Restart-safe: what is open is read back from the event stream. Timers (hold
  and clear) are in memory; a restart only delays an announcement by its hold and
  never repeats one (tested: a fresh controller re-derives the same state and
  emits nothing). A first pass with nothing open and no condition emits nothing.
- Honest about stale data: nothing is evaluated while the sync is degraded or
  erroring (open incidents stay as they are) and metrics and the page health
  panel are omitted when the integration is unconfigured, never synced, or its
  mirror is older than five sync intervals (at least five minutes).
- Fleet-wide incidents have no node: `/v1/incidents` returns `nodeId: null`,
  the report link is `/report-issue?kind=workload&event=<id>`; per-node
  registration incidents keep `kind=node`. `/v1/incidents?node=` still filters by node.
- Where it shows: the Runners page (server page and React console) has a
  "Runner health" panel (online runners, queued fleet jobs, oldest queued job,
  stalled or moving, current conditions, open incidents with report links;
  `GET /v1/runners` carries `health`), `/incidents` lists them, `/metrics` has
  `fleet_runner_queue_stalled` (0 or 1), `fleet_runners_online` and
  `fleet_ci_jobs_queued_oldest_seconds` (0 with an empty queue). Messages carry
  counts, a repository, a job id and a fixed public hint per code; never a job
  name, a node's own issue text or a token.
- Alerts reuse `alerts.webhookUrl` (https only, best effort): a fleet-wide event
  uses the fleet setting, a node event the node's effective setting. The payload
  is the event message, kind, severity and node id.

Tests: `bun test test/domain/runner-health.test.ts` (table-driven observation
for every condition and code, 60 seeded random sequences checking edges
alternate, holds are respected, a restart is silent and everything clears) and
`bun test test/github/runner-health.test.ts` (the sync job over SQLite and the
fake GitHub: open once, close after the hold, restart, degraded GitHub,
unconfigured, per-node registration with webhook and a canary proving no node
text leaks, metrics omission, `/v1/runners`, the server page and `/incidents`).

Proves: that the controller notices, within a sync interval plus the hold, that
jobs are waiting with nobody to serve them or that no runner is online while CI
nodes report, and says which. Does not prove: that a queued job is _really_
unserved (GitHub's queue is read by polling, up to a minute old), that an online
runner can actually run a job (that is the canary's job), or anything while the
controller itself is down. A repository served by no runner at all is
indistinguishable from a stall and is reported as one.

### Canary workflow template (check 7, consumer side)

`packages/fleet/workflows/fleet-canary.yml` is a template for **private**
consumer repositories (it is not in this repository's `.github/workflows`, where
a self-hosted job would be a hole). Daily and on demand it runs, on
`[self-hosted, nixos, ci]` behind the same `github.event.repository.private`
guard as `runner-check.yml`, the qualification described in
`packages/fleet/docs/onboard-project.md`: real `actions/checkout`, a committed
symlink and a new deep-path one, tool versions, the pinned devShell, the
project's toolchain and headless-browser smoke test (placeholders that fail
until replaced), then a step that fails the run when the job waited in the queue
longer than `FLEET_CANARY_MAX_QUEUE_SECONDS` (job `created_at` to `started_at`
through `gh api` with the default `GITHUB_TOKEN` and `actions: read`). A hosted
`watchdog` job fails the run when the canary is still queued after the limit.
`actionlint` (`packages/fleet/scripts/lint.sh`, `actionlint.yaml`) checks it.
Proves the end-to-end path for one repository; it does not prove capacity.

### Workflow safety test (public repository guard)

`bun test ./scripts` runs `scripts/ci/workflow-safety.test.ts` over every file
in `.github/workflows`: no `self-hosted` (any spelling, including through a
matrix or an expression) and only GitHub-hosted labels, except
`runner-check.yml`, a `workflow_call`-only reusable workflow whose every job
carries `github.event.repository.private`; no `pull_request_target`;
`workflow_run` only in `fleet-windows-sign.yml`, whose job requires the run to be
from this repository; every `uses:` pinned to a 40-hex SHA (or `./` local, or a
docker digest) unless allow-listed; `permissions` declared at top level or on
every job, no `write-all`, no top-level write; secrets only in workflows
triggered by `push` (with a branch filter), `workflow_dispatch`, `schedule`,
`workflow_call`, or behind a `github.event_name != 'pull_request'` job guard;
no attacker-influenced context (`github.head_ref`, PR title, comment body,
`inputs.*`) interpolated into a `run:`. A self-test section feeds each rule
violating YAML to prove it fires. New workflows (`live-github-contract.yml`,
`post-deploy.yml`) additionally must have exactly their expected triggers,
`contents: read`, a concurrency group and a timeout on every job; the live
contract's secret must be mapped into exactly one step.

Findings on the existing workflows (reported, not silently relaxed): the
allow-list has four entries, each with a reason in the test, and an entry that
stops being needed fails the test:

- `actions/*` at a major-version tag (`checkout@v5`, `cache@v4`,
  `upload-artifact@v4`, `setup-python@v5/v6`, `download-artifact@v4`): GitHub-owned.
  Pinning them to SHAs is recommended hardening that could not be verified offline.
- `oven-sh/setup-bun@v2` (ci.yml, publish.yml) and `dorny/paths-filter@v4`
  (ci.yml): third-party and tag-pinned; both run with read-only permissions and
  no secrets. Pin them to reviewed SHAs.
- `crvouga/workspace/.github/workflows/publish.yml@main` (publish.yml): the
  owner's own reusable release workflow at a moving branch, receiving
  `DEPLOY_DISPATCH_TOKEN`; called only on main after checks. Pin it to a SHA.

No workflow was found using a self-hosted runner outside the guarded reusable
workflow, `pull_request_target`, or a secret reachable from a pull request
(`publish.yml` has a `pull_request` trigger but its secret-bearing job is guarded
by `github.event_name != 'pull_request'`).

### Recommended required status checks (document only; settings not changed)

For branch protection (or a ruleset) on `main`, require:

- `Fleet` (the `fleet` job of `CI`): the aggregate gate. It always runs and fails
  unless `Check`, and, where the change plan says they are needed, `Test Nix` and
  `Build installer`, succeeded, so one required check covers them without
  breaking on a skipped matrix.
- `Container` (the `container` job of `Publish image`): the controller image is
  built and its readiness, restart, restore and denied-write checks run on every
  pull request.

Do **not** require `Live GitHub contract`, `Post-deploy check` or the canary:
they are scheduled or manual, need secrets or a deployment, and would block every
fork pull request. Look at their results instead (a failed weekly run is the
alert). If a merge queue is used, the required workflows must also trigger on
`merge_group` (`ci.yml` reads `github.event_name == 'merge_group'` but does not
declare the trigger; check this before enabling a queue).

### What was and was not run

Run here: `bun test` for the files named above, `bunx tsc --noEmit -p
packages/fleet-controller`, `eslint` and `prettier --check` on the files added or
changed, `actionlint` on `.github/workflows/*.yml` and `packages/fleet/workflows/*.yml`,
and `bun test ./scripts`. Not run: the live contract against real GitHub (no App
credentials on the development machine, by design), the canary on a real fleet
runner (no fleet, no Nix here), the controller detection against a real GitHub
queue (it is tested against the loopback fake), and the React console panel in a
browser (compiled and type-checked, not rendered).
