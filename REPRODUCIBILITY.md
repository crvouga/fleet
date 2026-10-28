# Reusing and rebuilding Fleet

Fleet ships application code and NixOS modules. Deployment identity and secrets
belong to the operator. No author-owned service or credential is needed.
GitHub is the supported runner and release integration; S3-compatible storage
and Litestream are required only when running the optional controller.

## Rebuild inputs

Use the same Git commit, Bun 1.4.4, Python 3.12, `bun.lock`,
`packages/fleet/flake.lock`, and operator settings. Install JavaScript packages
with `bun install --frozen-lockfile`. Use the checked-in Python build requirements
for native wizard packaging; they pin direct and transitive dependencies and
require verified wheel hashes. Run Nix commands with `--no-write-lock-file` when
validating an existing deployment; update locks deliberately in a reviewed change.
GitHub Actions records the source revision and uses the same lockfiles.

For a separate deployment repository, copy `examples/deployment/flake.nix`, set
its Git source and SSH keys, generate and commit its own `flake.lock`, and build
`nix build --no-write-lock-file .#installer`. That lock pins Fleet and its inputs;
Fleet's own lock is not a substitute for the consuming flake's lock. Alternatively,
fork Fleet and configure `packages/fleet/settings/shared.nix`. An unconfigured
update source blocks installation before disk erasure.

## Operator configuration

| Input                                                       | Source                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Node update repository, branch, flake path, SSH public keys | Nix shared settings or `fleet.lib.mkFleet` overrides                                       |
| Roles and hardware capability variants                      | `packages/fleet/roles.json`; regenerate copies with `bun run roles:sync`                   |
| Controller storage, repository and authentication           | `deployment.env.example` and `CONFIGURATION.md`                                            |
| Image hosted outside GitHub                                 | Client `FLEET_INSTALLER_URL`, optionally `FLEET_INSTALLER_SHA256_URL`                      |
| Optional CI runner setup                                    | Explicit `FLEET_GITHUB_REPO`, operator GitHub App, repositories and role-encrypted App key |
| Private role keys                                           | Local `~/.config/fleet/` or explicit `FLEET_KEYS_OUT`; secure backup outside Git           |

Dashboard downloads and guides stay in the Fleet app. Publish built images and
checksums in `FLEET_INSTALLER_DIR`; clients select `FLEET_CONTROLLER_URL` or enter
the app origin in the wizard. `FLEET_BUG_REPORT_REPO` selects only optional bug
report issues. A GitHub repository is never a controller startup requirement.
Nodes register and receive approval through Fleet's node protocol; the former
issue enrollment workflow is removed. Update sources remain operator-owned Git
repositories and can use any suitable provider.

The controller and shared-key enrollment are optional for standalone nodes.
CI runners require GitHub credentials; devboxes without shared encrypted secrets
can use local enrollment. Normal local development uses real SQLite/Litestream and
Mockingbird OIDC/S3 emulators, starting with an empty fleet. See LOCAL_DEVELOPMENT.md.
Synthetic data is available only through
`bun run dev:fixtures`, bound to loopback. No production fallback creates fixtures.

## Validation and limits

Run `bun run check`. On x86_64 Linux with Nix and KVM also run
`bun run check:nix`. Browser acceptance needs the pinned Playwright Chromium;
packaged wizard acceptance needs each target OS. Missing checks are not passes.
Regenerate `fleet-node.sh` with `bash packages/fleet/scripts/bundle-fleet-node.sh`
after modifying its source or embedded guide; lint checks it for staleness.

Locks make dependency selection repeatable. They do not guarantee byte-for-byte
identity for every native executable, timestamps, signatures, or external API
response. Those claims require comparing actual artifacts in the target build
environments. Firmware, disks, Wi-Fi and project-specific runner toolchains need
operator acceptance on spare hardware; see [deployment readiness](packages/fleet/docs/readiness.md).

Live browser acceptance targets the operator-supplied `FLEET_BDD_URL` and
the Fleet-hosted artifact endpoints; supply `FLEET_ADMIN_TOKEN` through your environment. These
tests do not assume a particular credential wrapper or hosted dashboard.
