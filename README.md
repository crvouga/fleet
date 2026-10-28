# Fleet

Git-managed NixOS machines with a cross-platform installer and an optional management dashboard. Fleet provides CI runner and development-box roles, hardware capability variants, pull updates, rollback, telemetry, and node enrollment. There are no per-machine host definitions.

Fleet runs on hardware you control. It does not require Railway, Cloudflare, a particular Vault, the author's infrastructure, or a cloud account. The optional Fleet controller coordinates enrollment, node settings, telemetry and recovery through a dashboard, backed by Bun and SQLite. By default, Litestream restores and replicates its database to your S3-compatible bucket, so the compute is replaceable. Browser login uses a configurable HTTPS OpenID Connect provider with authorization code + S256 PKCE and verified email claims.

## Try the dashboard

Install Bun 1.4.4 and Python 3.12. Then:

```sh
bun install --frozen-lockfile
bun run dev
```

Open the loopback URL printed by the command and sign in as `owner@example.test` in the local identity chooser. Fleet runs its normal application with a persistent SQLite database, real Litestream replication, and Mockingbird OIDC/S3 emulators. The fleet starts empty: nodes, settings, and telemetry come from application requests. No cloud account or live deployment credentials are needed. `bun run dev:managed` explicitly selects operator-configured services. Synthetic presentation fixtures remain available only through `bun run dev:fixtures`.

## Run in an agent workspace

Superset/Paradev and super.engineering have committed lifecycle configurations.
For a local dashboard with automatic ports and backend/frontend/style watches:

```sh
bun run local:setup
bun run local
```

Use `bun run local:status` to discover the URL and `bun run local:stop` to clean
up this checkout. Orca uses the same commands through its repository hooks.
See [local development and orchestrator integration](LOCAL_DEVELOPMENT.md).

## Configure your machines

Fork this repository before building an installer for your machines. In `packages/fleet/settings/shared.nix`, replace the deliberately unconfigured `repo.url` with your fork and leave `repo.flakeDir = "packages/fleet"`. Nodes follow that repository's `main` branch. Add your emergency SSH public keys there. `fleetApi.url` is empty by default; nodes work without a dashboard. The standard upstream Nix cache is used unless you configure another cache.

`packages/fleet/roles.json` defines roles and capability closures. `settings/github.json` starts with no repositories or App IDs. For CI runners, configure your own GitHub App and its encrypted private key; set `secretsFile` in `fleet.nix` to your SOPS file. No deployment keys, recipients, or encrypted credentials from the original installation are shipped. Keep runners restricted to trusted private code.

```sh
cd packages/fleet
nix flake check path:. --system x86_64-linux -L
nix build .#installer
```

NixOS builds and VM tests require x86_64 Linux with Nix; VM tests also need KVM. Building an ISO does not install it. Installation erases the selected internal disk: obtain explicit approval identifying the disk before executing any installer. Read [the installation guide](packages/fleet/docs/installer.md) and [agent runbook](packages/fleet/docs/agent-install.md).

Installer downloads are served by your Fleet app. Set `FLEET_INSTALLER_DIR` to your built public artifacts and matching checksums. Clients set `FLEET_CONTROLLER_URL` to your app, or enter its origin in the wizard. `FLEET_INSTALLER_URL` is an explicit image override. Node registration and approval stay in Fleet; no GitHub issue, account or enrollment workflow is needed. GitHub issue reporting remains an optional diagnostic action. Publish matching checksums/parts using `scripts/release-image.py`; never point an installer at an unverified image.

## Host the Fleet controller

Fleet runs directly on one node with **Bun 1.4.4 + Litestream 0.5.17**. SQLite is built into Bun. Litestream restores and continuously replicates the database to your S3-compatible bucket.

**Required configuration:** `FLEET_ADMIN_TOKEN`, `FLEET_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. For non-AWS storage, also set `FLEET_S3_ENDPOINT`.

```sh
bun install --frozen-lockfile
bun run build
cp deployment.env.example deployment.env
# Fill in deployment.env with your repository, admin secret and S3 credentials.
bun --env-file=deployment.env run check:config
bun --env-file=deployment.env run start
```

See **[CONFIGURATION.md](CONFIGURATION.md)** for every setting, defaults, startup checks, error remedies, browser login, and the service-manager example. The [environment template](deployment.env.example) contains all supported settings. Startup refuses traffic until configuration, local prerequisites, restore, schema initialization and an initial S3 sync succeed. Failures exit nonzero with a corrective action. One node owns the SQLite working file and replica prefix; stop it before starting a replacement. Ordinary restarts retain data, and a replacement can restore from the bucket. Abrupt host loss may lose recent unreplicated writes.

Nodes register directly with Fleet and wait under Pending for owner approval before disk erasure. A per-node private credential survives installation. Shared encrypted role secrets are a separate operator configuration: provide a role-specific age key when required. Vault/OpenBao wrapping is an optional explicit key-transfer mechanism; it does not grant app approval by itself. Neither Vault nor GitHub is needed to approve an ordinary node. `FLEET_KEYS_OUT` controls private role-key output (default `~/.config/fleet/`, mode 0600). Never commit private keys or tokens.

## Develop

```sh
bun run check          # typecheck, lint, Python/controller tests, dashboard build
bun run check:nix      # NixOS evaluations, builds and VM checks on Linux
bun run roles:sync     # regenerate role lists in scripts, controller and schema
```

Browser tests additionally require Playwright Chromium (`bunx playwright install chromium`). Native packaged installer validation requires the target OS and `packages/fleet/wizard/requirements-build.txt`. Portable checks do not establish physical installation or Windows signing readiness. CI uses GitHub-hosted runners; the reusable runner workflow is optional.

The `packages/` layout preserves imports and installation paths. Small supporting packages (`assert`, `logger`, `admin-ui`) and ESLint rules are included so a clean checkout builds independently; no sibling checkout is needed. Operator infrastructure, live health checks and secrets stay in the consuming infrastructure repository.

## License

MIT. See [LICENSE](LICENSE). Third-party tools and Nix inputs retain their respective licenses.

To keep deployment settings in a separate repository, start from
[the deployment example](examples/deployment/flake.nix). It calls the public
`fleet.lib.mkFleet` interface with operator-owned `shared` settings and optional
`roles.<name>` overrides. Settings merge recursively. Generate and review your
input lock before rollout; the role registry, modules and tools stay in Fleet.

Rebuilding a deployment requires the same source revision, committed Bun and Nix locks, and operator configuration. See [REPRODUCIBILITY.md](REPRODUCIBILITY.md) for the supported platforms, optional integrations, and verification limits.
