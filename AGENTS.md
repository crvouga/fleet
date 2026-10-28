# Fleet contributor instructions

Fleet is standalone: no dependency on the original infrastructure repository, its Vault, domains, OIDC relay, GitHub IDs or credentials. All deployment configuration is operator supplied. Keep optional services optional; never fall back to synthetic data in managed mode. Use `bun run dev:fixtures` for synthetic data.

Install with Bun 1.4.4. Run `bun run check`; Linux contributors also run `bun run check:nix`. Report unavailable checks truthfully. Keep ESLint structural limits enabled and never patch dependencies.

OS changes after bootstrap use Git pull updates. Never apply system changes over SSH. Infrastructure provisioning belongs to the operator's IaC, outside this application. Never run setup, provision credentials or change GitHub settings without explicit authorization.

`packages/fleet/roles.json` is the canonical registry. Run `bun run roles:sync` after changes. Regenerate the downloadable script with `bash packages/fleet/scripts/bundle-fleet-node.sh`. Do not edit generated role copies or bundled payloads by hand.

Installers, bootstrap and USB writes are destructive. Before running them obtain explicit human approval identifying the disk. `--yes` is not authorization. Never test against physical disks. Preserve internal/removable disk checks, confirmation expiry, image checksum verification, rollback and secret redaction.

Never commit secrets, age private keys, state or plans. Role secrets use separate SOPS recipients. Keep local fixture servers on loopback, production browser login on validated OIDC code + S256 PKCE, and the initial allowlist owner-managed. Never expose unauthenticated VNC/CDP.

Service logs use the included `@pkgs/logger` observability contract. Never log credentials, SQL parameters or OAuth payloads.

Local agent workspaces use `bun run local:setup`, `bun run local`,
`bun run local:status`, and `bun run local:stop`. Default local runs use explicit
loopback Mockingbird OIDC/S3 emulators, real SQLite/Litestream, and separate ports/state per checkout. Never seed demo fleet data in the normal local run. See LOCAL_DEVELOPMENT.md.
Keep `.fleet-local/` private and ignored. App hooks must call shared package
scripts; never copy another checkout's secrets or kill processes by port/PID.
Managed `bun run dev:managed` must continue requiring real operator configuration.
