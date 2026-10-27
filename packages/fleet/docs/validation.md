# Validation record

## 2026-10-27 native CI toolchain timeouts

PR #158's four native Nix lanes reached the 12-minute check limit while compiling
the shared upstream OMP Rust component, before launcher and VM acceptance could
complete. The pipeline now builds that runtime once in a separate bounded job,
tests its real launcher, and transfers its complete closure to the four lanes
through a same-workflow artifact. Those lanes retain their existing timeouts,
resource limits, exact derivation checks and release gates.

Local workflow and transfer fault tests cover full closure export, compressed
round-trip, failed queries/exports/imports, damaged archives and a missing
evaluated runtime. Native build and VM results must still be collected from CI;
the host has no Nix installation and its Docker daemon is unavailable.

## 2026-10-27 Oh My Pi configuration review

The shared coding launcher uses OMP's native `modelRoles.default` and
`PI_CONFIG_FILES`. Passing `--provider` alone did not select an initial model,
and configuration subcommands ignored the session's `--config` flag. The real
v18.13.1 CLI now reads the fleet defaults and accepts an explicit Anthropic model
through RPC `get_state`, without credentials or inference. `coding-launcher`
adds that regression check to the Linux build checks. Boot readiness also probes
the private browser HTTP endpoint. `ci-gpu` is now included in signed-cache
publication alongside `ci` and `devbox`, so GPU nodes have an update path.

Local verification includes the portable Fleet checks, typechecking, formatting,
agent links, generated integration guides, and all-system flake evaluation with
`--no-build`. Runtime OMP configuration/RPC checks used the SHA-256-verified
upstream macOS ARM64 release binary, with an isolated home and no account state.
Existing Nixpkgs, disko and sops pins are unchanged.

The x86_64 Linux launcher build was attempted under Rosetta, but stopped in the
pinned Claude Code package's `auto-patchelf` helper with `ModuleNotFoundError:
elftools`. A diagnostic found the module installed in the Python environment,
while the emulated interpreter used its base prefix instead. The same pinned
Python environment imports the module successfully in native ARM64 Linux. This
does not prove the x86_64 build: native CI must still build the launcher and run
the VM tests. No dependency was patched and no VM acceptance result is claimed.

The read-only live fleet health report still says no nodes have registered.
The shared SSH key list remains empty. Deployment, owner-approved subscription
authentication, model requests and physical-node acceptance remain unverified.

## 2026-10-27 runner service prerequisites

The CI role supplies `gh` alongside the pinned NixOS module's Bash, Git and
Nix. Before accepting a job, every slot now probes tool discovery/execution,
symlinks, paths longer than 260 characters and a local Git clone, under its
actual service identity, PATH and sandbox. Fleet readiness and the node console
explain failed probes and refuse readiness without successful evidence. The
slot-written result is diagnostic evidence, not a security attestation.

Passed locally on macOS ARM64:

- Five real-shell probe tests, with real Bash/Git and fixture `gh`/`nix` tools:
  successful checkout and cleanup, missing/nonexecuting tools, symlinks
  materialized as files, Git's `core.symlinks=false`, and filesystem failure.
- Thirteen runner-readiness tests, including an online runner with missing
  proof, failed probe stages and rejection of FIFO/symlink/malformed records.
- Existing runner-job tests, 17 onboarding tests, eight node-console tests,
  61 agent tests and 14 telemetry tests.
- Package shell lint (including ShellCheck), BDD lint, typecheck, documentation
  formatting, agent links, generated integration guides and `git diff --check`.
- Nix syntax parsing for the runner module and VM test in disposable Docker
  using Nix 2.28.5. The host has no Nix installation.
- `nix flake check --no-build --all-systems path:/fleet` in that disposable
  container passed, including CI closures and the updated VM derivation.
  This used a filesystem snapshot with revision `unknown`; it did not build
  or publish release closures.

The VM test now runs a shell through the service PATH, checks that probe records
belong to each slot user, and exercises failed `gh` execution followed by service
recovery. These VM scenarios have not been executed locally. A mock listener
does not prove a real GitHub Actions job. No physical node, Windows registry,
service, application repository or workflow was changed. A real checkout and
the application's pinned toolchain/browser smoke job remain rollout gates;
see [project onboarding](onboard-project.md). Repository-wide checks, builds,
VM execution and hardware acceptance still require their normal CI/live gates.

## 2026-10-24 automatic installer preparation across platforms

The wizard now performs bounded preparation after disk consent: missing Linux
boot tools through known system package managers, or one Windows free-space
consolidation attempt. Hard failures stop before preparation, disk identity is
checked again under the device lease, and strict preflight must pass afterward.
NixOS retains its bundled tools; macOS and ARM64 remain media-making platforms.
Downloads retry transient network failures only, up to three attempts. Reload
reconnects to the existing job without repeating the write or erase approval.

Passed locally on macOS ARM64:

- `bun run --filter @pkgs/fleet check`: 596 Python tests and package lint.
- 27 local browser Gherkin scenarios, including USB preparation and reload
  under all five modeled OS/architecture combinations, and existing reinstall,
  busy-job refusal and changed-disk scenarios.
- Wizard Chromium click-through and the 13-check source launcher self-test.
- 17 focused automation tests, including interrupted-transfer recovery to a
  verified file, bounded retries, cancellation, hard failures before mutation,
  changed disks, ineffective preparation and terminal elevation.
- Fleet typecheck, BDD lint, formatting, agent-command links and generated-guide
  checks. Additional imaging/automation verification: 33 tests.
- Actual Linux boot-tool preparation in an ephemeral `python:3.12-slim`
  container: the helper installed `kexec-tools` through apt, and `kexec` was
  available afterward. No host package installation or boot command ran.

The new automation tests are included in the five-platform installer CI matrix.
Windows free-space consolidation is exercised with a command stand-in, not a
real volume. Browser platform scenarios simulate disk discovery and write only
regular temporary files. This does not qualify physical Windows handoff, USB
boot or hardware compatibility. These changes have not been published; native
Nix builds, VM checks and rebuilt packaged installers still require CI.
The repository-wide `bun run check` was not run for this change.

## 2026-10-16 native NixOS and explicit hard reinstalls

The local Playwright BDD suite passes **21 Gherkin scenarios** on macOS ARM64,
using the real wizard, helper subprocess and bundled CLI. Coverage includes
same-role hard reinstalls for all five roles, default CLI idempotence, explicit
CLI replacement, read-only preview, busy-runner refusal, changed disk identity,
failed boot handoff recovery, platform eligibility, verified USB writes, App
manifest retry without reverse DNS and build-version identity.

Disk writes use regular temporary files. Firmware, disk discovery and boot
commands are stand-ins; the tests verify the extracted kernel, role parameters,
runner withdrawal order and closed job admission. They do not erase a physical
disk or boot an actual installer kernel.

`bun run check` also passes: **42 tasks**, including **572 Fleet Python tests**.
Focused Fleet BDD and Fleet API typecheck/lint checks pass.

The Fleet workflow now runs browser acceptance against every compiled platform
download, and additionally against native Nix packages on Linux x86-64 and
ARM64. The web NixOS VM exercises the native launcher and reinstall CLI with
`nix-ld` disabled. Those new CI checks must pass for the exact revision before
claiming platform validation. Reports are uploaded as `fleet-bdd-<os>` and
`fleet-bdd-native-<os>`.

NixOS ARM64 and macOS can make USB media; fleet targets remain x86-64 UEFI.
Real Windows firmware handoff, physical USB boot, storage/network compatibility
and a runner executing a real job still require a spare-machine acceptance run.

## 2026-10-16 installer recovery and browser acceptance

The original `fleet-installer` release was absent. Re-running the failed main
Fleet workflow [38685265311, attempt 2](https://github.com/crvouga/fleet/actions/runs/38685265311/attempts/2)
passed its NixOS checks, VM tests, role/ISO builds, five wizard platform builds
and publication. All five public installer downloads now return HTTP 200.
The release-recovery workflow change also rebuilds an incomplete/missing
release on a main push rather than accepting a skipped build as publication.

The owner created and installed `crvouga-fleet-runners` on github.com. Setup
saved its IDs in `settings/github.json` and its private key only in the
CI-recipient-encrypted `secrets/fleet.yaml`, enabled by `fleet.nix`.
Distinct enrollment keys for all five roles were applied through a reviewed
saved vault-root plan (five additions, no updates/deletions), with missing
prior Vault metadata checked first. The complete key map was then persisted
in OpenTofu-managed CI vault inputs through a reviewed saved foundation plan
(one secret update). Verification plans showed no changes for those targets.
No private key, state, plan or secret input was committed.

Installed pinned `playwright-bdd` 9.2.1 and `@playwright/test` 1.63.0. The latter
matches the existing cross-platform wizard browser job. Playwright 1.64.1
produced a generated-test source-location mismatch with this BDD version;
1.63.0 runs the unmodified dependencies successfully.

`vault run --config prd -- bun run --filter @pkgs/fleet test:bdd`:
**11 passed in 18.7 seconds** in Chromium on macOS ARM64, none skipped:

- Three local scenarios reproduce the GitHub authentication/manifest loss and
  retry the real setup form/callback; refuse an unconfirmed erase; write and
  read back the verified image; and refuse an unavailable image without
  changing the simulated disk. GitHub is a local stand-in in the retry test;
  disk access uses both existing guards and temporary regular files.
- Eight live scenarios load the actual authenticated Fleet `/add` page,
  follow its actual GitHub release link, download the Windows PE executable
  and match its bytes/size/SHA-256 against release metadata; check HTTP 200
  for all five platform downloads; compare every image part's availability,
  size and GitHub asset digest with the manifest; and authenticate using the
  real encrypted App key, verify the configured repository is private, and
  obtain an HTTP 201 runner registration token. Tokens are never attached or
  traced. No runner is registered by these tests.

The full `bun run check` passed all **42 tasks**, including **568 Fleet tests**,
with native PowerShell on PATH. The initial full run hit a concurrent Tailwind
package-cache copy error in the API CSS test; a direct CSS build populated the
cache and the complete rerun passed, including all 571 API tests. No dependency
or check was patched or weakened. Fleet BDD typecheck and ESLint also pass.

Gherkin and step definitions are under `bdd/`. The ignored HTML report is
`dist/bdd-report/index.html`, with JSON at `dist/bdd-results.json` and sanitized
checksum/registration evidence attached. CI runs the local scenarios in the
Ubuntu wizard job before publication, preserving its report as an artifact.
The live scenarios require owner credentials and are run explicitly, not
silently skipped in credential-free CI.

This proves the deployed downloads and the new App's registration permission.
It does not prove a Windows UAC/firmware handoff, a physical NixOS install or
a runner successfully executing a job. The published image tested above
predates this newly enabled App configuration; a main Fleet publication of
these changes is required before relying on the image's runner setup.

## Windows CI configuration follow-up

The planned role/path is now CI by converting an existing Windows installation.
The chosen repository was verified private through GitHub's read-only API.
Its bootstrap registration data is confined to `settings/github.json`; Nix,
setup and the runner health check consume that file. Runtime routing continues
to use the existing fleet API/Postgres settings. No repository-specific value
was added to Python, Nix modules or workflow code.

Generated distinct role age keys with `just fleet-keys`. Private values remain
only in the ignored vault input (verified mode `0600`); `.sops.yaml` contains
only matching public recipients. Nothing was seeded into live Vault. The same
complete key map must be supplied to the managed CI vault inputs before a CI
apply; merging public recipients alone cannot deploy private keys.

Validation after the JSON configuration change:

- Setup tests: **14 pass**, including the real encryption round trip, manifest
  resume, idempotence and reading the allowlist from JSON without CLI arguments.
  Key-generation tests: **3 pass**. Fleet lint and generated bundle checks pass.
- Infra: **62 tests pass**, typecheck passes; health checks now read JSON rather
  than parsing Nix source. Formatting, generated guide/agent checks and
  `git diff --check` pass.
- Nix in the ARM64 Docker image evaluated the CI configuration and printed its
  system derivation successfully. The full `--no-build --all-systems` flake
  check did not finish: it stalled evaluating the combined installer, Docker
  stopped responding to status requests, and a stop was requested for that
  test container. This is partial evaluation evidence, not a full flake check,
  Linux build or VM test.

The project's existing jobs still select hosted Ubuntu; there is no root
project flake, and Chrome setup assumes Ubuntu's native libraries. Registering
a fleet node alone will not migrate those jobs. No project workflow or GitHub
App/settings was changed. The readiness record lists these remaining gates.

## 2026-10-14 pre-install readiness audit

The [readiness record](readiness.md) contains the live blockers and bring-up
order. This audit found that the ISO had built successfully on GitHub, but its
release upload failed because the image exceeded GitHub's per-asset limit.
Publication now packages verified 1 GiB parts; the CLI and wizard assemble and
verify the complete ISO. The legacy artifact fetcher selects a real, unexpired
main-branch artifact rather than the latest possibly skipped workflow run.

Validated locally on macOS ARM64:

- `bun run --filter @pkgs/fleet check`: **passed (566 tests, one skipped)**
  (the existing large Windows staging test needs 12 GiB free in the temporary
  filesystem). This includes ShellCheck, pinned actionlint, bundled entry
  freshness, workflow copies and cattle checks. PowerShell parser tests used
  the official native macOS ARM64 PowerShell 7.4.6 archive in a temporary
  directory; the default amd64 Docker image crashed under emulation and that
  initial run was stopped, then rerun with native PowerShell.
- The nine full-chain tests passed with the actual release packager and a
  multipart HTTP release: shipped shell entry, enrollment, installer, real API,
  throwaway PostgreSQL and dashboard. Process mode, not Docker image mode.
- Packaged and reassembled **2,147,549,184 bytes** with default part sizes
  **1,073,741,824 + 1,073,741,824 + 65,536**, checking each part and the full
  image. Regular temporary files on the workspace volume; no physical disks.
- Eight new multipart regression tests cover both probes/download clients,
  progress, missing/corrupt/truncated/oversized parts, cancellation, manifest
  path restrictions and destination preservation.
- Prettier for changed Markdown/workflows, `git diff --check`,
  `bun run check:llms` and `bun run check:agents`: **pass**.

Read-only GitHub evidence: [main run 38659022284](https://github.com/crvouga/fleet/actions/runs/38659022284)
passed the Linux flake check, VM tests, five role builds and ISO build, and all
five wizard builds/self-tests/browser tests. Its **publish failed** with HTTP
422 on the oversized ISO. The later green Fleet status skipped the builds;
it does not prove publication. These are prior-build results, not CI results
for this fix. No Nix or VM build was run locally for this change.

`bun run health`: **220 pass, 14 warn, 8 fail, 9 skip**. Fleet API DNS/TLS/health,
its image, Vault enrollment policy/JWT role/API settings and the CI deployment
are not healthy. Runner settings and the binary cache remain unconfigured.
The live main ruleset lacks the declared Fleet check and merge queue. No
production plan/apply, GitHub settings/secret change, release publication,
hardware test or installation was performed in this audit.

Validated on 2026-10-10 in the current worktree (macOS ARM64):

- `bun run --filter @pkgs/fleet check`: **pass**, ShellCheck, workflow lint, lock checks and 8 Python tests. Tests reject USB/removable/mounted/missing/duplicate/unstable disk targets, verify root-only atomic short-lived registration-token files, exercise both scopes, custom-label drain, pagination, and busy-job timeout.
- `actionlint .github/workflows/runner-check.yml` and package workflow examples with `actionlint.yaml`: **pass**. The existing `CI` workflow structure passes `actionlint -shellcheck=''`; its full ShellCheck integration reports pre-existing SC2016/SC2129 warnings in unrelated scripts.
- `just --list`, `just check-local`, recipe parsing and a dry-run ISO command: **pass**, using a temporary downloaded official just binary.
- Prettier for changed documentation/config, `git diff --check`, `bun run check:llms`, `bun run check:agents`: **pass**.
- Nix **evaluation**: `nix flake check --no-build --all-systems --no-write-lock-file path:SOURCE`: **pass**, including node, installer, guarded remote disko and mocked VM derivations. A temporary official Nix 2.31.2 Darwin binary with a diverted store was used; Nix was not installed system-wide. Nix verified fetched input hashes and generated the updated `nixos-26.05` lock. The checked source was copied to a temporary space-free path because this checkout path contains spaces. Intel Darwin's upstream end-of-support warning is informational.

## Blocked acceptance checks

The full `nix flake check --system x86_64-linux` was attempted with local jobs/substitution disabled and no remote builders to prevent trying Linux builds in the temporary Darwin store. It reached all three checks and returned **Unable to start any build; either increase '--max-jobs' or enable remote builds**. This Mac has no configured x86_64 Linux builder. The actual node closure build, installer ISO build, VM boot/assertions, offline installer behavior, and optional container/cache integrations **have not passed runtime validation**. Evaluation is not a Linux build or VM test. No physical disk operation, GitHub configuration/secret/billing change, push or deployment was performed.

On a Nix-enabled x86_64 Linux builder, from this package run:

```sh
just check
just build-node
just build-iso
just vm-test
```

`just check` builds every host, the installer ISO, and the `runNixOSTest` checks (`vm`, `web-vm`, `lifecycle`, `follow-up`, `netboot-vm`). The hosted `CI` workflow runs the package check and `nix flake check` for fleet changes. A local evaluation is not green CI.

## 2026-10-12 control-surface change

Bootstrap, `fleet-sync`, the attic and netboot roles, the lifecycle and netboot VM tests, and `.github/workflows/fleet.yml` were added on a Mac without Nix. This change was not evaluated with `nix flake check`, and the VM tests were not executed. Do not treat the 2026-10-10 evaluation above as coverage for this tree. The CI closure changes on purpose: `base.nix` now imports sync, the revision endpoint, the generation limit, and the optional attic substituter. comin was not added; it is not in nixpkgs at `7c8764b7`, and an unlocked input was not pinned from this machine.

Before node installation, fill that role's settings file and its encrypted secret file, rerun the acceptance checks against that exact source, and qualify the real NICs, firmware, thermals, and hardware watchdog. The default template stays evaluable. `fleet-install` runs on the machine and generates the role age key there. Empty `sshKeys` is valid. The boot menu chooses the role. `FLEET_AUTO=1` wipes the disk `select-disk` returned. A manual run still asks for that path to be typed.

## 2026-10-12 interchangeable hardware

Role and capability configuration replaced the MS-A2 profile, the configured disk path, MAC canaries, and `ci-$mac` / `web-$mac` hostnames. `scripts/cattle.py check` is part of the portable check. This change was not evaluated with `nix flake check`, and the VM tests were not executed. Do not treat the 2026-10-10 evaluation as coverage. The CI closure changes on purpose: generic initrd modules, systemd-networkd for wired DHCP, boot-time hostnames, and runner slots derived from the live CPU and RAM. The kernel is no longer pinned to 6.12. `ci-gpu` evaluates as a NixOS configuration and is not in the default build list.

## 2026-10-12 main tracking

Nodes poll `main` and switch only from the binary cache. `deploy` and `canary` are gone. `fleet-drift`, the merge-queue cache push, and the lifecycle VM test were added on a Mac without Nix. `nix flake check` was not run, and the VM tests were not executed. The portable check covers `fleet-sync` and `fleet-drift` with stand-in `nix` and `git`. Do not treat that as a NixOS evaluation.

## 2026-10-13 self-healing

Post-switch health checks, previous-generation rollback, systemd-boot tries-left, the netboot local-disk default, `fleet-disk`, and the `follow-up` nixosTest were added on a Mac without Nix. `nix flake check` was not run. The `follow-up` VM test was not executed. `bun run --filter @pkgs/fleet check` passed: 49 tests OK, covering the sync rollback, the boot-count script, and the netboot decision with stand-ins, plus shell syntax, ShellCheck, workflow copies, and cattle enforcement. Do not treat that as a NixOS evaluation. `monitoring.pushUrl` is unused. No PDU model is integrated. Nothing was deployed and no machine was contacted.

The installer ISO carries the `ci`, `web`, `cache`, and `netboot` closures. Its boot menu installs one of those roles without a work computer, from whatever OS is on the disk or from an empty disk. `just fetch-iso` downloads the `Fleet` workflow artifact. That workflow change was not run. The ISO was not built, flashed, or booted. `bun run --filter @pkgs/fleet check` was not re-run; from `packages/fleet`, `python3 -B -m unittest discover -s tests -p 'test_*.py'` passed with 67 tests OK, and ShellCheck, cattle enforcement, and `git diff --check` passed. Those tests cover `fleet-install`, `fetch-iso`, and `flash-usb` with stand-ins. The netboot ramdisk still does not carry the closures, and the netboot host does not serve the ISO.

## 2026-10-14 node setup story

Added on a Mac without Nix, Windows, or a second machine: publishing the installer release on every merge to `main` (the `push` trigger), self-service approval through a GitHub issue and the `Fleet enroll` workflow, the `fleet-enroll` Vault policy and JWT role, converting a Windows computer in place, and the owner's one-time `just setup`.

Ran and passed here (306 tests, `bun run --filter @pkgs/fleet check`, which includes ShellCheck, the bundled `fleet-node.sh` freshness check, workflow lint and copies, and cattle enforcement): the X25519 and sealing code against the RFC 7748 vectors; the node polling a fake GitHub (conditional requests, forged and foreign comments, wrong role, timeouts, cancel); the workflow script against a fake Vault and OIDC endpoint, asserting the read is wrapped and the raw key never appears in any output; the shipped one-file entry installing through approval, refusing and leaving every disk alone on timeout, workflow error, stale token and wrong role; the Windows sequence through stand-in `powershell`, `bcdedit` and `shutdown` (order, bytes at the partition offset, zeroed hybrid MBR, EFI files, one-time boot entry, and the complete undo when `bcdedit` or the read-back fails, including restoring an existing `grub.cfg`); the setup script through a fake GitHub (manifest, redirect state, App token signed by real `openssl` and verified, resume without a second App), and a real `sops` and `age` round trip showing only the ci key opens the App secret; `bun run check:infra` (OpenTofu fmt, validate and tests with the new role and policy), `@pkgs/infra` tests, `check:llms`, `check:agents`, and Prettier.

**Not run, and therefore not claimed:**

- Anything on a real Windows machine. Whether `Resize-Partition` frees enough space on a given machine, whether Windows lets `\\.\PHYSICALDRIVEn` be written inside an unformatted partition, whether the firmware honors a `bcdedit /copy {bootmgr}` entry as a one-time boot, and whether the ISO's GRUB finds the image by its marker file when the image sits in a raw partition are all unproven. Try a spare machine first. The undo path is tested with stand-ins only.
- The `Fleet enroll` workflow on github.com, the Vault role and policy against a real Vault (declared in the inventory, not applied), and the GitHub App manifest flow against github.com. The first real run needs `just setup`, a merged pull request, and a reviewed vault apply.
- `nix flake check`, the VM tests, the installer ISO build and the wizard's PyInstaller builds and Chromium click-through. The `Fleet` workflow runs them; none ran here.
- Booting a GRUB that is not signed. Secure Boot must be off, which the Windows check enforces.
- Any hardware: no NIC, firmware, thermal or watchdog qualification, and no machine was contacted.

The installer release does not exist until a fleet change lands on `main` and the `Fleet` workflow publishes it. Until then the wizard says the installer cannot be reached.

## 2026-10-14 Windows conversion hardening

Run on a Mac, without Windows. Added: both one-time boot mechanisms (`bcdedit` and direct UEFI variables), the early shrink check that also asks for the download's room and the exact re-measurement after the download, deleting the installer's own downloaded copy, the RAM refusal (image size plus 2 GiB), the retry through the partition device, `--plan`, and `docs/windows.md`. Ran and passed here: every generated PowerShell script through the real PowerShell 7.6 parser and against stand-in cmdlets (Docker, arm64 Linux); the `Boot####` load option byte for byte against a hand-derived value; the `kernel32` calls against stand-in DLLs; the whole conversion against a model of Windows with a failure injected at each step, requiring the model to end as it began; raw writes at offsets past 4 GiB and past 2 TiB (a real sparse file and a sector-checking fake device). **Not run:** anything on Windows. See "What is verified and what is not" in `docs/windows.md` for the six places a first real run is most likely to fail.

## 2026-10-14 fleet API, node agent and the full-chain test

Added: the fleet API and dashboard (`packages/fleet-api`, deployed by OpenTofu as a Railway Docker service at fleet.example.com, on the shared Postgres in its own `fleet` schema built by Atlas), the node agent with dynamic settings, hardening of the Windows conversion (a second one-time-boot mechanism through UEFI variables, retry on the partition device, RAM and space checks, `--plan`), and an end-to-end test that runs the real programs against each other.

Ran here and passed:

- **Full chain, `tests/test_e2e_chain.py` (9 tests, about 8 s):** `fleet-node.sh` downloads the installer from a release server and shows the GitHub approval link; the owner's click is played by running the real `scripts/enroll.py` against a Vault stand-in that refuses unwrapped reads; the node opens the sealed token and boots the installer only after that; `fleet-install.sh` unwraps the key and installs the node's credentials (mode 0600); the real `agent.py` registers with the real server (`bun src/server.ts`) on a throwaway Postgres whose schema the real Atlas CLI built; the node appears online on the dashboard with its runner slots. Also: an unknown node waits as pending and is approved from the API; settings put through the API reach the node's files (`runner-labels`, `assign/`, `config.json`), out-of-range and misspelled settings are refused, a node-scoped setting beats the fleet's; a deleted node registers again by itself; `retire` is recorded; a wrong role token never approves; a rollback becomes an event; dashboard sign-in through Vault (admin policy only) gives an HttpOnly, SameSite=Lax session; nothing exists outside the `fleet` schema and only a hash of the node secret is stored; the server refuses to start misconfigured without echoing a value.
- **It found two real defects, both fixed:** `python3 scripts/enroll.py` crashed because `scripts/token.py` shadows Python's `token` module (the unit tests had hidden it with `-I`; the script now removes its own directory from the import path and the workflow uses `-I`), and, with the Docker image, Bun took its JSX settings from the working directory so the image could not start (it now runs from the package directory).
- **The Docker image:** builds, runs as the unprivileged `bun` user, passes its own health check, serves the login page, stylesheet and script, and a real agent registered against it with the role token; nothing outside `fleet` appeared in the database.
- **Fleet API:** 571 tests, lint and typecheck, against real Postgres built by Atlas, with decoy tables in `public` proven untouched.
- **Windows scripts under real PowerShell 7.4.6** (`tests/test_powershell.py`, 24 tests): every generated script parses, and the actions run with mocked cmdlets (shrink, new partition, mount, restore). The local image is arm64 Linux; the scripts have not run on Windows.
- **Nix:** `nix flake check --no-build --all-systems` (Nix 2.35.3, in Docker) printed "all checks passed": every role closure with the agent and dynamic-config changes, the installer ISO, the VM tests as derivations. The new `agent-units` check fails (naming all five roles) when the API address is blank, and passes otherwise. Evaluation only; nothing was built.
- **The fleet suite:** 558 tests, one skipped (it needs 12 GiB of free temp space). The wizard's Chromium click-through passes. Infra: `tofu` fmt, validate and mocked-provider tests, 57 unit tests, Prettier, `llms.txt`, agent links.

Still not run, so not claimed:

- Any real Windows machine, a real Secure Boot-off GRUB boot from a raw partition, and a real kernel boot of the installer.
- `nix build` of any closure or the installer ISO, and the NixOS VM tests (no KVM here); the `Fleet` workflow does both in CI. The VM tests were not extended for the agent.
- The wizard's PyInstaller builds on the five platforms.
- The production rollout: the Vault and foundation plans, Atlas against the real PlanetScale database, the Railway service, DNS, TLS, and the GitHub App creation on github.com. The container was exercised against a local Postgres container, not PlanetScale (`sslmode=require`, the pooler).
- The `fleet-e2e` job itself. It mirrors the local run (process, then image with host networking) but has not run on GitHub. The image-mode path of `test/e2e/stack.ts` could not run on this Mac, where the Docker VM cannot reach the host's loopback Postgres.

## 2026-10-26 role registry and the two-role fleet

Added: `roles.json` as the only definition of a role, `roles.nix` (validated read for the flake and modules), and `scripts/fleet_roles.py` (complete rules, repository-side reads, `sync`/`check` of the copies node scripts, fleet-api, Atlas and the vault root keep, and `placement`, which `fleet-sync` runs against `roles.json` at the fetched revision). `ci` and `devbox` are active; `web`, `cache` and `netboot` are retired, with their modules, hosts, settings, tests and sops recipients deleted. The web VM's native-without-nix-ld coverage moved to `tests/native.nix`. Postgres check constraint, vault role list and token set are byte-identical to before, so neither the Atlas schema nor the vault plan changes.

Ran on a Mac without Nix and passed: the fleet suite (`tests/run.py`, including the new `test_roles.py` and the `fleet-sync` registry cases) with `scripts/lint.sh` (shellcheck, actionlint, bundle freshness, `fleet_roles.py check`); fleet-api unit tests, lint and typecheck of the changed files; the cache-probe test; `tofu fmt` of the vault root and tests; Prettier.

Not run, so not claimed: `nix flake check`, any closure or ISO build, and the NixOS VM tests (including the new `native-vm` and the `checks.roles` derivation); the `Fleet cache` workflow's registry-driven role list and the `lib.cacheProbe` evaluation; the vault plan and Atlas apply. Whether any live node still carries a retired role is runtime data; such a node's own `fleet-sync` predates this change and fails as a cache miss, while fleet-api marks it not ready with the retirement reason.
