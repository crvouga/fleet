# Fleet

Git-managed NixOS machines with a cross-platform installer and an optional management dashboard. Fleet provides CI runner and development-box roles, hardware capability variants, pull updates, rollback, telemetry, and node enrollment. There are no per-machine host definitions.

Fleet runs on hardware you control. It does not require Railway, Cloudflare, a particular Vault, the author's infrastructure, or a cloud account. The optional dashboard runs anywhere Bun and PostgreSQL run. Browser login uses a configurable HTTPS OpenID Connect provider with authorization code + S256 PKCE and verified email claims.

## Try the dashboard

Install Bun 1.4.4 and Python 3. Then:

```sh
bun install --frozen-lockfile
bun run dev:fixtures
```

Open the loopback URL printed by the command. Fixtures are synthetic, kept in memory, and explicitly selected. Normal `bun run dev` uses your environment and fails if database credentials are missing.

## Configure your machines

Fork this repository before building an installer for your machines. In `packages/fleet/settings/shared.nix`, set `repo.url` to your fork and leave `repo.flakeDir = "packages/fleet"`. Nodes follow that repository's `main` branch. Add your emergency SSH public keys there. `fleetApi.url` is empty by default; nodes work without a dashboard. The standard upstream Nix cache is used unless you configure another cache.

`packages/fleet/roles.json` defines roles and capability closures. `settings/github.json` starts with no repositories or App IDs. For CI runners, configure your own GitHub App and its encrypted private key; set `secretsFile` in `fleet.nix` to your SOPS file. No deployment keys, recipients, or encrypted credentials from the original installation are shipped. Keep runners restricted to trusted private code.

```sh
cd packages/fleet
nix flake check path:. --system x86_64-linux -L
nix build .#installer
```

NixOS builds and VM tests require x86_64 Linux with Nix; VM tests also need KVM. Building an ISO does not install it. Installation erases the selected internal disk: obtain explicit approval identifying the disk before executing any installer. Read [the installation guide](packages/fleet/docs/installer.md) and [agent runbook](packages/fleet/docs/agent-install.md).

Installer downloads default to this project's GitHub releases. For private/fork builds set `FLEET_INSTALLER_URL` to your published ISO URL and `FLEET_GITHUB_REPO` to your fork for enrollment/issues. Publish matching checksums/parts using `scripts/release-image.py`; never point an installer at an unverified image. This extraction does not promise an already-published installer release.

## Host the dashboard

Build `packages/fleet-api/Dockerfile` with this repository root as context, or run `bun run build` and `bun run start`. Supply:

- `DATABASE_URL`: PostgreSQL connection string.
- `FLEET_ADMIN_TOKEN`: random secret of at least 32 characters.
- `FLEET_ROLE_TOKEN_HASHES`: JSON map of role to SHA-256 token hash; `{}` allows only pending registrations requiring approval.
- `FLEET_GITHUB_REPO`: repository whose revisions nodes follow.
- `PORT`: defaults to 8080.
- Optional browser login: `FLEET_OIDC_ISSUER`, `FLEET_OIDC_CLIENT_ID`, and `FLEET_PUBLIC_ORIGIN`. Register the exact callback `${FLEET_PUBLIC_ORIGIN}/auth/callback`. All three values must be supplied together.

Apply [schema.hcl](packages/fleet-api/schema.hcl) using your migration system before startup. Provision your own database, TLS, OIDC client, backups and secrets through your infrastructure tooling. Fleet does not create these resources. Insert the initial authorized email into `fleet.allowed_emails` through the database owner; first sign-in never grants access. Without OIDC the bearer-token node/admin API remains available, while browser login is disabled.

Shared role-key enrollment through Vault/OpenBao is optional. Configure `FLEET_VAULT_ADDR` on installer clients and `FLEET_VAULT_ADDR` repository variable for the opt-in enrollment workflow. Configure its JWT trust to your exact repository, workflow and branch. An example wrapped-read policy is under `packages/fleet/examples/vault/`. For a standalone node without shared role secrets, use `fleet-node devbox --no-enroll` after building your configured installer. The installer generates its own age key; shared encrypted role credentials require your own enrollment configuration. `FLEET_KEYS_OUT` controls private key output (default `~/.config/fleet/`, mode 0600). Never commit private keys or tokens.

## Develop

```sh
bun run check          # typecheck, lint, Python/API tests, dashboard build
bun run check:nix      # NixOS evaluations, builds and VM checks on Linux
bun run roles:sync     # regenerate role lists in scripts, API and schema
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
