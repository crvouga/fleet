> The shared Turbo/Nix cache described below is retired. Current updates use bounded local builds and upstream Nix substitutes; installation validates bundled closures. See [update reliability](update-reliability.md). Cache design details below are historical.

# Two-role fleet: target design and migration

Status: proposal, 2026-10-26. Migration steps 2 and the code half of 3 are
implemented: `roles.json` defines the roles, `ci` and `devbox` are active, and
`web`, `cache` and `netboot` are retired with their Vault tokens, age keys and
Postgres constraint value kept (see the Roles section of
[AGENTS.md](../AGENTS.md)). Deleting the retired entries is still the reviewed
state change in step 3, after Q1 and Q2. The rest is unimplemented. Every claim
about the current state cites the source it was read from; anything not verified
is listed under [Open questions](#open-questions-to-investigate) and must be
settled before the step that depends on it.

## Goals

1. The fleet has exactly two roles: `ci` (runs GitHub Actions jobs) and
   `devbox` (local application development over SSH). `web`, `cache` (Attic)
   and `netboot` are removed everywhere, including state in Postgres and Vault.
2. Both roles are hardened for their actual threat model.
3. A repository starts using CI boxes with one reviewed inventory change and a
   one-line `uses:` in its workflow. Everything else is automatic.
4. Every node, runner, job and update is observable off the node, with alerts
   that reach a person.
5. Nodes stay cattle: no per-machine configuration, Git is the only control
   surface, and every node converges to every release without a person.

## What exists today (summary)

- **Removed roles carry no live load.** `web.nix` serves only a placeholder app
  with `image = null`; every inventory service is hosted on Railway. Attic is
  disabled (`modules/cache-server.nix:5`, `cache.nix` `secretsFile = null`) and
  nodes substitute from the cloud `cache.example.com/nix` cache.
  `netboot` cannot finish an install (AGENTS.md "Bootstrap") and both
  `reinstall` lists are empty (`settings/shared.nix:43-48`).
- **State outside Git still names them:** the `nodes_role_known` check in
  `packages/fleet-api/schema.hcl:116-118`; `fleet_roles` in
  `packages/infra/tofu/vault/main.tf:8` (role tokens and their hashes on the
  fleet-api service); `vault_kv_secret_v2.fleet` keyed by `var.fleet_age_keys`
  with `prevent_destroy` (`vault/main.tf:207-216`); age recipients in
  `.sops.yaml`.
- **CI runners** are the nixpkgs `services.github-runners` module, one
  ephemeral runner per slot with a registration token minted on every restart
  (`modules/runners.nix:184-239`, `scripts/runner_control.py`). Each slot is
  bound to one repository by round-robin (`runners.nix:82-83`,
  `cattle.py:367-371`). Upstream systemd hardening applies, but there are no
  per-slot resource limits, no egress filtering, a shared Nix daemon, a
  world-writable `/run/fleet/gate` (`runners.nix:183`), and fork-PR protection
  only in the caller's opt-in `if:` (`.github/workflows/runner-check.yml:18`).
- **Onboarding a repository** is manual and split across GitHub UI (install the
  App), `settings/github.json` or the dashboard (`runners.repositories`), and
  the project's workflows (`docs/onboard-project.md`).
- **Observability** is the `fleet-agent` heartbeat to fleet-api plus a daily
  `bun run health`. Nothing scrapes either `/metrics` endpoint, the journal is
  volatile and never shipped, and the only push alert is an optional webhook
  for "node offline" (`packages/fleet-api/src/jobs/offline-notifier.ts`).
- **Updates** track every commit on `main` (`modules/sync.nix:14-17`). Each
  node fetches Git, evaluates the flake locally, and switches only on a cache
  hit (`scripts/fleet-sync.sh:177-196`). There is no release object; every
  monorepo commit changes `self.rev` and therefore every closure.
- **Devbox**: one `dev` user, one SSH key fixed at install, broad toolchain from
  nixpkgs, no container runtime, reboots under an active session on kernel
  updates (`drainCommand = ""`, `settings/shared.nix:94`), and loses all work on
  reinstall without warning beyond the motd.

## Target design

### Roles and capabilities

| Closure  | Purpose                 | Notes                                                                                     |
| -------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `ci`     | GitHub Actions jobs     | Default CI box.                                                                           |
| `ci-gpu` | `ci` plus NVIDIA driver | Published with the base closures; kept off the installer ISO. See [Q4](#q4-gpu-closures). |
| `devbox` | Development over SSH    | One closure.                                                                              |

`high-mem` stays a runtime threshold, not a closure. A new `kvm` capability
(runtime label, opt-in per node through dynamic config) is proposed for jobs
that run `nixosTest`; see [CI hardening](#ci-hardening).

The `FLEET-KEY`, enrollment, wizard, Windows conversion and kexec paths stay as
they are, with two roles instead of five. `ci` and `devbox` keep separate age
keys and sops files.

### Releases and convergence

A **release** is a `main` commit whose role closures the Fleet cache workflow
has published, signed and verified. Nodes follow releases, not `main`.

1. After `publish-fleet-cache.ts` uploads and verifies the closures, it writes
   a small release manifest next to the Nix cache:
   `{ seq, rev, publishedAt, roles: { ci: <toplevel>, devbox: <toplevel>, ... } }`.
   `seq` is strictly increasing. The manifest is signed with an Ed25519 release
   key owned by the vault OpenTofu root (separate from the narinfo key, or the
   same key: see [Q6](#q6-release-manifest-transport-and-key)).
2. `fleet-sync` fetches the manifest, verifies its signature against the key
   pinned in `settings/shared.nix`, refuses a `seq` lower than the one it last
   applied (rollback protection; a revert is a new, higher release), then
   realises its role's toplevel from the cache and switches. No Git fetch and
   no flake evaluation on the node.
3. Everything else in `fleet-sync.sh` stays: health probes, rollback, boot
   counting, kernel-change stagger and drain.
4. The installer release records the release `seq` and `rev` it was built
   from; a fresh node converges to the newest release on first sync, as today.
5. "In sync" means: node `seq` equals the newest manifest `seq`, or the node is
   inside a bounded grace window (publication time plus kernel stagger plus
   drain bound). `fleet-drift` and the dashboard both compare against the
   manifest, not `main` HEAD, which fixes today's false "behind" during every
   publication window.
6. Optional: derive the revision from the fleet sources rather than the whole
   monorepo, so unrelated commits do not create a release. See
   [Q5](#q5-content-addressed-release-identity).

Rollback stays a revert pull request. A bad release is never "unpublished";
the next release supersedes it.

### CI role

#### CI hardening

The threat model is code from private repositories and their dependencies,
running as an ephemeral runner on a shared box. Fork pull requests and
`pull_request_target` must never run. The controls, in order of value:

1. **Admission enforced on the node.** `ACTIONS_RUNNER_HOOK_JOB_STARTED` reads
   `$GITHUB_EVENT_PATH` and fails the job before any step when the event is
   `pull_request_target`, when a pull request's head repository differs from the
   base, or when `repository.private` is false. The caller's `if:` remains, but
   is no longer the only guard ([Q9](#q9-runner-hook-guarantees)).
2. **Per-slot resource limits.** Each slot gets a systemd slice with
   `MemoryMax`, `MemorySwapMax=0`, `CPUWeight`/`CPUQuota`, `TasksMax` and
   `IOWeight`, derived from the same `capacity` numbers that size the slot
   count. Nix builds that a job triggers run in the daemon's cgroup and escape
   these limits; see [Q11](#q11-nix-builds-and-slot-limits).
3. **Egress policy.** nftables output rules matched on the slot UID range deny
   RFC 1918, link-local, CGNAT and the node's own loopback services (`:9101`,
   the agent) while allowing the internet and DNS. This stops jobs from reaching
   the LAN, devboxes and other fleet nodes ([Q12](#q12-egress-filtering)).
4. **Root-owned control state.** `/run/fleet/gate` becomes `0600 root`.
   "Busy" is derived by root from a `Runner.Worker` process in the slot's
   cgroup (and GitHub's `busy` flag), not from a file the job can create or
   delete. Drain, capacity and cache cleanup stop trusting job-writable files.
5. **JIT runners instead of registration tokens.** Each slot run gets a
   just-in-time configuration for exactly one job, so no registration token is
   written to disk and a runner cannot be reused. The nixpkgs module does not
   support `--jitconfig`, so the slot unit becomes a fleet-owned unit that
   keeps the same upstream hardening options ([Q10](#q10-jit-runners)).
6. **Narrow tokens.** Installation tokens are requested with an explicit
   `repositories` and `permissions` body. If runners move to an organization,
   the App drops `administration: write` on repositories for
   `organization_self_hosted_runners: write` ([Q7](#q7-personal-account-or-organization)).
7. **Per-repository caches enforced by root.** `CI_CACHE_DIR` becomes
   `/nix/ci-cache/<owner>--<repo>/<slot>`, created by the root pre-start step
   for the assigned repository and never shared across repositories.
   `fleet-cache-clean` evicts by repository and age, can evict idle slots, and
   clears its own `draining` marker once space recovers (today it never does).
8. **Workspace on disk.** `workDir` moves from `/run` (RAM, shared default size)
   to `/nix/ci-work/<slot>`, wiped by the unconfigure step. Big boxes have the
   disk; RAM goes to jobs.
9. **Containers stay off by default.** Rootless Podman force-disables five
   hardening options (`runners.nix:221-227`). If a repository needs
   `services:`/`container:`, prefer the microVM option below over turning those
   off fleet-wide.
10. **KVM as an opt-in capability.** `DeviceAllow=/dev/kvm` and the `kvm` label
    only on nodes flagged by dynamic config. This repository's own `ci.yml`
    still never runs on the fleet (AGENTS.md "Sync and rollback").
11. **Stronger isolation (phase 2, optional).** Run each slot's job inside a
    microVM (for example microvm.nix with cloud-hypervisor) so a job escape
    lands in a throwaway guest, not the host with the App key. Big boxes make
    this affordable. Decide after measuring the overhead ([Q13](#q13-microvm-isolation)).

#### Using CI boxes from any repository

Target experience for a repository owner:

1. Add the repository to the OpenTofu inventory with `fleet_ci = true` and merge
   the reviewed plan. OpenTofu then:
   - adds the repository to the runner App's installation
     (`github_app_installation_repositories` or equivalent, [Q8](#q8-github-provider-coverage));
   - applies repository Actions policy: fork pull request workflows disabled
     for private repositories, allowed actions, and SHA pinning where the
     provider supports it.
2. In the repository, call the reusable workflow:
   ```yaml
   jobs:
     ci:
       uses: crvouga/fleet/.github/workflows/fleet-ci.yml@fleet-ci-v1
       with:
         command: just check
   ```
   It sets the routing labels, the admission `if:`, per-repository cache
   directories (`XDG_CACHE_HOME`, Bun, Turborepo), a timeout, and an optional
   GitHub-hosted fallback.

Nothing else is manual. Nodes discover eligible repositories from the App
installation (`GET /installation/repositories`, private and not archived only),
so `settings/github.json` keeps only the App identity and `runners.repositories`
becomes an optional restriction in the dashboard rather than a required step.

**Demand-driven assignment.** Static slot-to-repository binding leaves slots
idle while another repository queues. Target:

1. The runner App subscribes to `workflow_job` webhooks; fleet-api receives
   them (webhook secret owned by OpenTofu/Vault) and keeps a queue of
   `(repository, labels)` with queued jobs. A periodic reconciliation lists
   queued jobs in case a webhook was missed.
2. Each node's agent asks fleet-api for queued work matching its labels. The
   answer is data: a repository name and labels, never a credential or command.
3. The node checks the repository against its own installation listing (private,
   installed, not denied), mints a JIT configuration with its App key, and
   starts an idle slot for it. An unclaimed JIT runner expires and deregisters.
4. The same webhooks give queue time, run time and outcome per job for
   observability.

A compromised fleet-api can only point nodes at repositories the App is
already installed on and the node has verified, which is no wider than today's
`runners.repositories`. GitHub's runner scale set API may replace steps 1–3;
see [Q7](#q7-personal-account-or-organization).

### Devbox role

The threat model is a single trusted developer whose box sits on a home or
office network and holds working copies and development credentials.

**Hardening:**

- sshd: `AllowUsers dev` (root keeps only the emergency `sshKeys` path),
  `AuthorizedKeysFile none` so only the root-owned
  `AuthorizedKeysCommand` grants access (closes the
  `~/.ssh/authorized_keys` side door, unverified today),
  `PubkeyAcceptedAlgorithms` limited to Ed25519 and `sk-` keys,
  `MaxAuthTries 3`, `ClientAliveInterval`, `AllowTcpForwarding local`,
  `AllowAgentForwarding no`, `PermitTunnel no`, `X11Forwarding no`. Each
  setting is asserted in `tests/devbox.nix`.
- Keys: `/nix/fleet-state/devbox/authorized_keys` may hold several keys (the
  installer stops silently dropping all but the first). A role-wide list of
  public keys in Git (`settings/devbox-keys`) is merged with it, so adding or
  revoking a key is a pull request.
- Pinned `dev` UID, because the UID map lives on the tmpfs root.
- Firewall: TCP 22 only, plus whatever the remote-access choice needs
  ([Q15](#q15-devbox-remote-access)). Dev servers stay on loopback and are
  reached by SSH local forwarding.
- No CI credentials, no App key, no runner units (kept from today).

**Usability:**

- Toolchain from the repository, not the image: `mise` and `direnv` with
  `nix-direnv` installed; the workspace's `mise.toml` decides Bun and Node
  versions. The image keeps only general tools (`git`, `gh`, build essentials,
  `tmux`, `ripgrep`, `fd`, `just`).
- Rootless Podman with Compose for the `dev` user, so
  `packages/auth-relay/development/compose.yml` and similar stacks run. This is
  safe on a devbox in a way it is not on CI.
- Nix GC roots for `nix develop` and direnv shells, so weekly GC does not
  discard a working environment.
- Reachable by name: Avahi publishes `devbox-xxxx.local`. Overlay networking is
  a decision ([Q15](#q15-devbox-remote-access)).

**Updates and reboots:**

- In-place switches apply on every release, as on CI.
- Kernel releases set a devbox-specific `drainCommand` that waits until `dev`
  has no SSH session and no tmux server for 30 minutes, bounded by a maximum
  deferral (for example 24 hours). It broadcasts a warning 10 minutes before
  rebooting. This makes the existing `reboot.enabled=false` dashboard switch
  unnecessary for normal use.

**Cattle without losing work:**

- `/nix/devbox` is a cache of work that lives in Git remotes, and the motd and
  docs say so.
- `fleet-node devbox --reinstall`, a role change and `fleet-remove` refuse when
  any Git repository under `/nix/devbox` has uncommitted changes, unpushed
  commits or stashes, and print them. `--discard-work` overrides.
- The host key changes on reinstall, as today. Publishing host-key fingerprints
  to fleet-api so clients can verify them is optional.

### Observability

"Complete" means every question below has an answer off the node, with history
and an alert where a person must act:

| Question                         | Signal                                                                     | Source                                       |
| -------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| Is the node alive?               | heartbeat age; metrics `up`                                                | fleet-agent, collector                       |
| Is it on the newest release?     | node `seq` vs manifest `seq`, time behind                                  | agent, fleet-api                             |
| Did an update fail or roll back? | sync result, failure count, last success time, rollback events             | agent, journal                               |
| Is it healthy?                   | failed units, disk, memory, temperatures, boot-count/bless state, watchdog | node exporter (systemd, hwmon), agent        |
| Are runners serving?             | slots idle/busy/offline, registration status per repository                | agent, GitHub API                            |
| Are jobs waiting?                | queue time, run time and outcome per repository and label set              | `workflow_job` webhooks                      |
| What happened before a reboot?   | system journal                                                             | log shipping plus a small persistent journal |
| Is the control plane up?         | external probe of fleet-api liveness and readiness                         | backend synthetic check, `bun run health`    |
| Is publication working?          | newest release age vs newest `main` commit                                 | fleet-cache workflow, health check           |

**Pipeline (recommended, see [Q14](#q14-observability-backend)):**

- Each node runs a collector (Grafana Alloy, `services.alloy` at the locked
  nixpkgs) that scrapes the existing `:9101` endpoint, a node exporter with the
  systemd and hwmon collectors, and the journal, and pushes them to a managed
  metrics and logs backend. The push credential is write-only and role-scoped,
  delivered in the role's sops file. Runner job output (`Runner.Worker`) is
  excluded from shipping because it can contain secrets; GitHub already keeps
  job logs.
- The journal persists to `/nix/fleet-state/journal`, capped (for example
  1 GiB), so a node that lost network still has its history after reboot.
- The backend, its tokens, dashboards, alert rules and contact points are
  OpenTofu resources (for example the `grafana` provider) in the inventory. No
  dashboard is edited by hand.
- fleet-api stays the inventory and control plane. It gains alert events for
  rollback, update failure, behind release beyond grace, failed units,
  sustained disk, readiness regression and recovery, not just offline. It
  exposes separate liveness and readiness endpoints per the logger contract
  (today `/health` is both and depends on the database). Its background jobs log
  job id, duration and outcome. The backend scrapes its admin `/metrics` with a
  read-only credential.
- The heartbeat adds sync state: target `seq`, last attempt and success times,
  consecutive failures, waiting-for-stagger-until, boot-count/bless state.
- `bun run health` gains a `fleet-release` check (newest release is recent and
  every online node is on it within grace), the runner check covers discovered
  repositories with pagination, and the permanent `fleet revision` SKIP becomes
  a real check. Each gets a `health:fix` entry.
- The fleet does not observe itself: the backend and its alerting run off the
  fleet, so a fleet-wide failure still alerts.

## Migration plan

Each step is a reviewed pull request (and, for OpenTofu, a reviewed saved plan).
Steps 1–3 are mechanical; later steps depend on the answers to the open
questions.

### 1. Confirm nothing uses the removed roles (read-only)

- List fleet-api nodes with roles `web`, `cache`, `netboot` (admin API
  `/v1/nodes`). Retire any and power off the machines ([Q1](#q1-live-nodes-of-removed-roles)).
- Check which role age keys exist in `TOFU_VAULT_INPUTS` and the local
  `fleet-age-keys.auto.tfvars.json` ([Q2](#q2-retiring-vault-state)).

### 2. Remove the roles from code

- `packages/fleet`: delete `web.nix`, `cache.nix`, `netboot.nix`,
  `hosts/{web,cache,netboot}.nix`, `modules/{web-server,cache-server,netboot}.nix`,
  `scripts/netboot-policy.py`, `tests/{web,netboot}.nix`,
  `tests/test_netboot_policy.py`.
- `flake.nix`: settings imports, `mkHost`, `installerNetboot`, ISO
  `storeContents`, readiness/manifest roles, `nixosConfigurations`,
  `packages`, `disko-*`, `attic-client`, checks (`web-vm`, `netboot-vm`) and the
  `update-units`/`agent-units` role sets.
- Modules: `installer-iso.nix` boot-menu roles; `base.nix` `fleet-role.ipxe`
  and the `reinstall.*` assertions; `identity.nix` allowed roles;
  `onboarding.nix` `providesCache`; `settings/shared.nix` `reinstall`;
  `modules/cache.nix` assertion text that names Attic.
- Scripts and tests: role lists in `agent.py`, `cattle.py`, `decide.py`
  (including the `retire` branch, keeping `devbox`), `fleet-keys.py`,
  `ci-impact.py`, `ci-checks.py`, `bootstrap.sh`, `fleet-install.sh`,
  `fleet-auto.sh`, `live_console.py`, `wizard/server.py`, `wizard/index.html`,
  `e2e/setup.sh`, `bdd/features/reinstall.feature`, and every test that uses
  `web` as the sample non-CI role (switch to `devbox`). Regenerate
  `scripts/fleet-node.sh` with `scripts/bundle-fleet-node.sh`.
- `justfile`: `build-web`, `build-cache`, `build-netboot`, `enroll` role check,
  `vm-test` list.
- `.sops.yaml`: drop the three recipients.
- CI: `.github/workflows/fleet-cache.yml` role list and published results;
  `packages/turborepo-remote-cache/scripts/check-fleet-cache{,.test}.ts`;
  `scripts/wait-cache.py`; the unused `FLEET_ATTIC_TOKEN` input in `ci.yml`.
- `packages/fleet-api`: `src/types.ts` `ROLES` and everything typed from it,
  `add-node` role help and lists, demo data and tests.
- Docs: root `AGENTS.md` fleet bullet; `packages/fleet/AGENTS.md` role list,
  key separation, web apps, bootstrap and netboot TODOs, VM groups, just
  targets; `README.md`, `secrets/README.md`, `installer/README.md`, and
  `docs/{agent-install,checklist,installer,runbook,readiness,validation,dynamic-config}.md`.
  The runbook's stale Attic and merge-queue text goes too.

### 3. Remove the roles from state (ordered)

1. After step 1 confirms no rows: narrow `nodes_role_known` to
   `('ci', 'devbox')` in `schema.hcl` and apply through the foundation root's
   Atlas resource.
2. Vault root: `fleet_roles = ["ci", "devbox"]`, remove the three keys from
   `fleet_age_keys` inputs, and retire `vault_kv_secret_v2.fleet["web"|"cache"|"netboot"]`
   despite `prevent_destroy` ([Q2](#q2-retiring-vault-state)). Update
   `variables.tf.json` validation, `tests/vault.tftest.hcl` and the README.
   The changed `FLEET_ROLE_TOKEN_HASHES` reaches fleet-api through the existing
   Railway variable.

### 4. CI hardening (no new infrastructure)

Admission hook, per-slot slices, egress rules, root-owned gate and busy
detection, per-repository caches, on-disk workspaces, cache-clean fixes and
narrowed installation tokens. Each control gets a VM assertion in
`tests/vm.nix` (for example: a slot cannot reach `127.0.0.1:9101` or a LAN
address; a `pull_request_target` event fails at the hook; a job cannot hold the
gate).

### 5. Releases

Release manifest in the publisher, manifest route in `turborepo-remote-cache`,
release key in the vault root, manifest-driven `fleet-sync`, manifest-based
drift and dashboard "behind", release `seq` in the heartbeat and installer.
Extend `checks.follow-up` to drive a fixture manifest.

### 6. Observability

Backend and alert routing in OpenTofu, collector module in `base.nix`,
persistent journal, heartbeat sync fields, fleet-api alert events and
liveness/readiness split, health checks and fixers.

### 7. Multi-repository CI

Inventory `fleet_ci` flag and GitHub policy in OpenTofu, installation-based
repository discovery, `fleet-ci.yml` reusable workflow with a versioned tag,
JIT runners, then `workflow_job` demand-driven assignment. Rewrite
`docs/onboard-project.md` around the two-step experience and add self-hosted
CI guidance to `scripts/llms-txt.template.md`.

### 8. Devbox

sshd hardening and tests, multi-key and Git key list, pinned UID, mise and
direnv, rootless Podman, GC roots, session-aware reboot drain, unpushed-work
guard, Avahi, and the remote-access decision.

## Open questions to investigate

### Q1. Live nodes of removed roles

Are any physical machines installed as `web`, `cache` or `netboot`? The
dashboard and `nodes` table answer this; the repository cannot. Rows with
those roles block the narrowed check constraint.

### Q2. Retiring Vault state

`vault_kv_secret_v2.fleet` has `prevent_destroy` per instance, so dropping
`web`, `cache` and `netboot` from `fleet_age_keys` fails the plan. The options
are a `removed` block (forgets the documents but leaves them in Vault, so their
enrollment tokens could still be minted by the `fleet-enroll` policy, which
reads `secret/data/fleet/+`) or a reviewed one-time lift of `prevent_destroy`
for those three instances to delete them. Deleting is preferable; confirm
OpenTofu 1.13 `removed`/`lifecycle` semantics and that no other root reads them.

### Q3. Releases versus every commit

Is "every release" meant to be every published `main` commit (this design), or
a deliberate, tagged release cadence? A tagged cadence needs a release workflow
and changes the "merge to change a node" contract in AGENTS.md.

### Q4. GPU closures

Resolved in the 2026-10-27 coding-harness configuration: `ci-gpu` is marked
published in `roles.json`, so its closure is built, signed and cached with the
base closures. The [locked Nixpkgs driver package](https://github.com/NixOS/nixpkgs/blob/7c8764b7c7b09b34f632464276218ef9090eaa11/pkgs/os-specific/linux/nvidia-x11/generic.nix)
marks its licence `unfreeRedistributable`; the fleet uses that maintained package
without changing its contents or licence files. Publishing still depends on
successful CI and the signed-cache workflow. The GPU variant is not on the ISO.

### Q5. Content-addressed release identity

`system.configurationRevision = self.rev` makes every monorepo commit a new
closure. Can the flake derive an identity from `packages/fleet` and its locked
inputs alone in pure evaluation, so unrelated commits do not create releases?
If not, every commit stays a release and nodes switch in place each time.

### Q6. Release manifest transport and key

`turborepo-remote-cache` serves only `nix-cache-info`, `*.narinfo` and `nar/*`
publicly (`src/cache/nix-routes.ts:6-40`). Adding a manifest route is a
runtime change; the signing key is OpenTofu-owned. Decide whether the manifest
key is the narinfo key or a separate key, and how `seq` is allocated
atomically when two publications race.

### Q7. Personal account or organization

Runners are repository-scoped because a personal account has no organization
runner groups (`docs/onboard-project.md:4`). An organization would allow one
runner group serving every repository, a narrower App permission, and possibly
GitHub's runner scale set API for demand-driven JIT runners without fleet-api
webhooks. Moving repositories changes their URLs and settings. Check whether
the scale set API works for repository-level scale sets on a personal account.

### Q8. GitHub provider coverage

Confirm the pinned `integrations/github` provider can manage the repository
set of a user-owned App installation and the fork pull request settings of a
private repository. Anything it cannot manage stays a documented one-time
manual step, never an API call from this repository.

### Q9. Runner hook guarantees

Confirm on the locked runner version that `ACTIONS_RUNNER_HOOK_JOB_STARTED`
sees `GITHUB_EVENT_PATH`, that a non-zero exit fails the job before any step,
and that a workflow cannot unset or override the hook.

### Q10. JIT runners

`generate-jitconfig` needs the same `administration: write` as registration
tokens at repository scope. The nixpkgs module has no JIT mode, so slots need a
fleet-owned unit. Verify upstream's hardening options carry over unchanged.

### Q11. Nix builds and slot limits

Jobs reach the shared daemon as untrusted users, and builds run in the daemon's
cgroup. Options: daemon-wide `max-jobs`/`cores`, a resource-limited daemon
slice, Nix's experimental `cgroups` with `auto-allocate-uids` at the locked
version, or per-slot daemons. Measure on a real box.

### Q12. Egress filtering

UID-matched nftables rules do not cover builds run by `nixbld` users, and
fixed-output derivations need the internet. Decide whether builder egress gets
the same LAN deny rules, and whether any repository needs LAN access at all.

### Q13. microVM isolation

Measure job overhead and confirm KVM availability on the delivered hardware
before committing to per-job microVMs.

### Q14. Observability backend

No metrics or logs backend exists in the inventory. Options: a managed stack
(for example Grafana Cloud, fully provisioned by OpenTofu) or a self-hosted
stack on Railway (for example VictoriaMetrics and VictoriaLogs). Decide on
cost, retention and where alerts go (email, push, chat). Also check whether
`alerts.webhookUrl` is set in fleet-api today.

### Q15. Devbox remote access

SSH on the LAN with local forwarding works today. Remote use outside the LAN
needs an overlay network (for example Tailscale with ACLs and auth keys
managed by OpenTofu) or a jump host. Decide whether that is in scope, and
whether several developers share one devbox or each gets their own.

### Q16. Devbox credentials

`dev` scripts in this repository load credentials from Vault and fail without
it. Decide how a headless devbox logs in to Vault (OIDC with a forwarded
callback, or no Vault on devboxes) without storing a long-lived token.

### Q17. Physical acceptance still open

Real EFI counted-boot fallback, power-loss recovery, hardware watchdog,
installed Wi-Fi, the Windows handoff and a real job on a CI node remain
unverified on hardware (`docs/readiness.md`, `docs/update-reliability.md`).
This design does not change that; each phase above adds VM coverage, not
hardware proof.
