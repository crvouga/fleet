# Local development in agent workspaces

Fleet works in ordinary terminals and worktrees managed by Superset/Paradev,
super.engineering, and Orca. The apps share repository-owned commands; none is
required to run Fleet. Install Bun 1.4.4 and Python 3 before setup.

```sh
bun run local:setup
bun run local
```

Setup installs from `bun.lock` with `--frozen-lockfile` and builds the dashboard.
When Litestream 0.5.17 is absent, setup or the first run downloads a pinned archive,
verifies its committed SHA-256, and caches the executable in `.fleet-local/tools/`.
Supported downloads cover macOS/Linux on ARM64 and x86-64. An explicitly supplied
`FLEET_LITESTREAM_BIN` or installed binary is checked by the normal startup preflight.
Setup does not install system services or create cloud resources.

`bun run local` and `bun run dev` start the normal Fleet controller with real SQLite,
real Litestream replication, and the pinned Mockingbird OIDC and S3 packages. They
bind the dashboard and both emulators to `127.0.0.1` and choose separate ports for
each checkout. The fleet starts empty. No nodes, telemetry, events, settings, or
fake administrator sessions are seeded. Application requests create Fleet data.

Sign in as `owner@example.test` through Mockingbird's account chooser and consent
screen. `FLEET_LOCAL_OWNER_EMAIL` changes the explicitly configured local owner.
This account exists only in the emulator; Fleet still verifies signed OIDC tokens,
S256 PKCE, nonce/state, its local owner allowlist, and its database-backed sessions.
The local composition explicitly permits HTTP OIDC only when both the issuer and
Fleet origin use `127.0.0.1`; managed configuration still requires HTTPS OIDC.

The controller's SQLite file and the S3 emulator's portable snapshot live under
`.fleet-local/`. Graceful Stop saves the replica before shutting down the emulators;
a new run reuses that state. Backend watch reloads retain the emulator processes,
data, and ports. A full restart can select new ports and require signing in again.
The emulator identity accounts/consent restart with the configured local owner.
Refresh the browser after frontend changes. Background jobs run against this local
store. Outbound application HTTP is restricted to the local identity emulator;
unconfigured integrations stay optional, and arbitrary external webhooks are blocked.

Inherited `FLEET_*`, `AWS_*`, and `DATABASE_URL` settings are removed from local
child environments before the local composition supplies its own configuration.
Local credentials are generated in the ignored `.fleet-local/credentials.json` and
are never printed. No managed database, bucket, identity pool, or Vault is accessed.
The separate, explicit `bun run dev:fixtures` command remains for presentation
fixtures; agent workspace Run commands never select it.

From another terminal in the same checkout:

```sh
bun run local:doctor  # validate local tool prerequisites
bun run local:status  # JSON: running, mode, and dashboard URL once ready
bun run local:stop    # stop only this checkout's local run and its watchers
bun run check        # project validation, including lifecycle integration tests
```

Ctrl+C also stops the supervisor and its children. Setup can be repeated.
Stop is idempotent when no runtime exists. An explicit `PORT` overrides automatic
selection; an occupied port fails rather than stopping another service. Use
`bun run local --no-watch` for a single build and server without watchers.

## App integration

| App                | Committed integration            | Behavior                                                                                                                    |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Superset / Paradev | `.superset/config.json`          | Setup installs/builds; Run starts the controller and Mockingbird with watches; teardown stops that checkout                                 |
| super.engineering  | `.super.engineering/config.json` | Named **Fleet local**, **Check**, and **Local doctor** runs; Fleet is the default; Stop and teardown clean up its local run |
| Orca               | Repository hook commands below   | Configure Setup and Archive hooks in Repository settings; run Fleet in a repository terminal                                |
| Any shell or agent | Root package scripts             | Identical setup, run, status, stop, and validation commands                                                                 |

Superset and Paradev use the same `.superset` configuration. The desktop app
reads repository lifecycle hooks; this does not require a global terminal script
or an account-specific project ID. Personal extensions can go in the ignored
`.superset/config.local.json`. See the
[Superset lifecycle documentation](https://docs.superset.sh/setup-teardown-scripts).
The app may load Run configuration from the main checkout; land the integration
there for new workspaces to inherit it.

In super.engineering use the Run menu or its documented lifecycle commands:

```sh
sc project scripts check --json
sc project scripts run "Fleet local" --json
sc project scripts status --json
sc project scripts stop "Fleet local" --json
```

The shared config is managed with `sc project scripts ... --scope repo`.
Opening this repository does not launch agents or create extra worktrees.

Orca exposes repository Setup and Archive hook fields in **Settings → Repository
→ Hooks**. Set them to:

```text
Setup:   bun run local:setup
Archive: bun run local:stop
```

Then run `bun run local` in a terminal belonging to the Fleet checkout. The
printed loopback URL works in Orca's embedded browser. The CLI shipped with this
integration's validation environment has no supported hook-setting command, so
Fleet does not edit Orca's private settings or invent a `.orca` config schema.
See [Orca's hook documentation](https://www.onorca.dev/docs/agents/hooks-memory).
Agent status hooks and permissions remain controlled by Orca and your agent.

## Isolation and cleanup

`.fleet-local/` is ignored by Git. It contains local data, credentials, a lock, dashboard/emulator discovery data,
and a private token for a loopback-only lifecycle control endpoint. Status and
Stop authenticate against that running supervisor; cleanup never kills a process
by a saved PID or by port. Each checkout owns its own SQLite file, emulator replica snapshot, and credentials.
An optional `FLEET_LOCAL_STATE_DIR` selects a different absolute state directory
for tests or multiple local runs from the same checkout; use the same value for
Run, Status and Stop, and never share it across concurrent runs.

A hard kill or power loss can leave a lock. Try `bun run local:status` first. If
its supervisor is no longer running, remove only that checkout's
`.fleet-local/lock`, `runtime.json`, and `dashboard.json`, then restart. A stale
file never authorizes signaling an unrelated process. Logs remain in the app's
run terminal; the runtime file contains a token and should not be shared.

## Managed development

`bun run dev:managed` explicitly selects managed mode and requires real operator configuration.
For a local managed instance, complete `deployment.env.example` and run:

```sh
bun --env-file=deployment.env run check:config
bun --env-file=deployment.env run dev:managed
```

The local emulator lifecycle does not start, stop, or reconfigure managed deployments.
Keep each managed checkout's SQLite path and S3 replica ownership separate; see
[CONFIGURATION.md](CONFIGURATION.md). Physical installation and Linux/Nix testing
remain separate from local dashboard development.

## Mockingbird coverage and issue reports

The pinned packages are `@crvouga/mockingbird-service-oauth` and
`@crvouga/mockingbird-service-s3`. Their installed `DISCOVERY.md`, `README.md`,
`SUPPORT.md`, and public types describe the supported contracts. The local status
JSON includes each emulator endpoint; append `/__admin/ui` to inspect its state
and journal or `/__admin` for fault/reset/snapshot controls. Fleet's SQLite store
is internal application storage, so it uses Bun's real SQLite engine. GitHub bug
reports remain optional and are not a startup dependency. No physical machine or
installer is emulated by the local dashboard launcher.

If a package fails or lacks behavior Fleet uses, follow the
[Mockingbird reporting guide](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md):
search existing issues, reduce the problem to a redacted reproduction, record the
exact package version and expected contract, and report it in `crvouga/mockingbird`.
Do not patch dependencies or add an application-side fake to hide the failure.
