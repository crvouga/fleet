# Technology decisions

Why each candidate technology was adopted, deferred or rejected for Fleet, what was
considered instead, and which requirements it serves. Companion to
[ARCHITECTURE.md](ARCHITECTURE.md) (design) and
[packages/fleet-controller/docs/verification.md](packages/fleet-controller/docs/verification.md)
(what the tests prove).

The rule applied to every row: **inspect what exists, prefer a mature maintained
project over custom code, never run two tools with the same job, and count the
operational cost of each dependency.** "Verified" means checked in this repository
or by a test that was run; "unverified" says what could not be run here (this
review ran on macOS without Nix, hardware or a real GitHub organisation).

## The workload that decides the architecture

Facts from the repository, not assumptions:

| Fact                                                                                                                                                 | Evidence                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Jobs are Nix-first: a project `devShell`, `nix develop --command …`, a node-local Nix store as the cache.                                            | `packages/fleet/docs/onboard-project.md`, `workflows/project-example.yml`                      |
| Only trusted private-repository code runs. No fork PRs, no public repos.                                                                             | `onboard-project.md` ("Only trusted private code may run here")                                |
| A handful of owned physical machines (16-core class), not elastic cloud capacity.                                                                    | `docs/hardware.md`, `cattle.py` (slots from live CPU/RAM, max 8)                               |
| Runners are already ephemeral: one job, then the listener exits and re-registers.                                                                    | `modules/runners.nix` (`ephemeral = true`)                                                     |
| Container jobs are an opt-in (`containers = false` by default), served by rootless Podman with a Docker-compatible socket.                           | `fleet.nix`, `modules/runners.nix`                                                             |
| The controller runs apart from the nodes (own host, own SQLite), and a node keeps converging on its cached desired state during a controller outage. | `Dockerfile`, `examples/deployment/`, `PROTOCOL.md` ("The fleet works without the controller") |

## Decision summary

| Technology                                  | Decision                                                    | One-line reason                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| NixOS + flakes                              | **Adopted** (existing)                                      | The OS and the reproducible unit of change.                                                                          |
| disko                                       | **Adopted** (existing)                                      | One declarative disk layout for every node.                                                                          |
| nixos-anywhere                              | **Kept as an optional operator tool, not the install path** | Same mechanism as our installer (kexec + disko) but needs a reachable Linux host and a shell.                        |
| sops-nix                                    | **Adopted** (existing)                                      | Per-node age identities, role-scoped recipients.                                                                     |
| Clan / Colmena                              | **Rejected**                                                | Push-over-SSH deployment duplicates the controller and `fleet-sync`, and the repo forbids applying changes over SSH. |
| K3s + Flux CD                               | **Deferred**, with explicit adoption triggers               | A second control plane and reconciler for a workload that does not need one today.                                   |
| Actions Runner Controller (ARC)             | **Deferred** (needs K3s)                                    | Its value is scale-from-zero and bin-packing, which fixed owned hardware does not need; it fights Nix-native jobs.   |
| GitHub App authentication                   | **Adopted** (controller-owned)                              | No personal access tokens; the App key lives only on the controller.                                                 |
| Requests, limits, priority                  | **Adopted via systemd cgroups**                             | The native equivalent on a node, with no scheduler. Added in this change.                                            |
| Container actions / service containers      | **Partially supported** (opt-in rootless Podman)            | Works for what Podman implements; documented limits.                                                                 |
| Turborepo remote cache / Attic              | **Not deployed** (retired by the operator)                  | Upstream substituters plus per-slot disposable caches were chosen over a private cache service.                      |
| Prometheus metrics                          | **Adopted as the export interface**                         | The controller already serves protected `/metrics`; the operator's Prometheus scrapes it.                            |
| node_exporter, kube-state-metrics, cAdvisor | **Not adopted**                                             | The agent already reports the same host facts; a second collector would duplicate it.                                |
| Grafana, Alertmanager                       | **Operator-side, not installed by Fleet**                   | Consumers of `/metrics`; the controller keeps its own incidents and webhook alert.                                   |
| Loki, Tempo, OpenTelemetry collector        | **Not adopted**                                             | No log or trace backend is in scope; correlation ids are in place so one can be added without code churn.            |
| lm-sensors, smartmontools                   | **smartmontools adopted; lm-sensors not needed**            | Sensors come from sysfs hwmon directly; SMART needs `smartctl`.                                                      |
| Canonical MAAS                              | **Rejected**                                                | Ubuntu-centred; NixOS is not an upstream-supported image, and it adds a region/rack controller and database.         |
| Redfish / IPMI                              | **Deferred**                                                | The fleet's current hardware class has no BMC; no requirement it would meet today.                                   |
| Tailscale / WireGuard                       | **Deferred**                                                | Nodes only make outbound HTTPS calls, so no mesh is needed for the primary workload.                                 |

## Core infrastructure

### NixOS + flakes, disko, sops-nix: adopted

These already carry the architecture (`packages/fleet/flake.nix` pins nixpkgs, disko
and sops-nix). Nothing here was replaced.

- **Satisfies:** declarative OS, reproducible closures, secrets at rest, role separation.
- **Operational cost:** low and already paid.
- **Verified:** `packages/fleet/tests/test_roles.py`, `test_keys.py`, `test_node_state.py` (run); the per-node age identity and rotation protocol in `ARCHITECTURE.md`.
- **Unverified here:** `bun run check:nix` and the Nix VM tests (no Nix on this machine).

### nixos-anywhere: kept, not the install path

`outputs.nix` exposes the package for operators. The installer does the same work
(kexec into a live image, then disko and install) but starts from a downloaded
wizard instead of an SSH session, which is what the zero-command requirement needs.
nixos-anywhere requires a Linux machine reachable over SSH with operator credentials,
which is the opposite of that experience and conflicts with the rule against system
changes over SSH.

- **Alternative considered:** replace our kexec step with nixos-anywhere. Rejected: it would add an SSH trust step and remove nothing.
- **Remaining limitation:** a universal one-click OS replacement is not possible. The supported paths are listed in [packages/fleet/docs/installer.md](packages/fleet/docs/installer.md) (Windows x64 in place, Linux x64 and NixOS x64 via kexec, macOS and ARM only as USB makers) and classified supported, partially automated or unsupported before anything is erased.

### Clan, Colmena: rejected

Colmena and deploy-rs are push tools: the operator's machine connects to every host
over SSH and activates a configuration, so hosts must be reachable at deploy time.
Clan builds on that model (this is from background knowledge; its documentation
was not checked here). Fleet already has the pull-based equivalent:

- The controller holds each node's desired state (role, closure, settings).
- `fleet-sync` pulls Git, builds, switches with health-checked rollback.
- Nodes tolerate long offline periods and converge on return.

Adding a push tool would create a second authority for "what runs on this node" and
break the stated rule `Never apply system changes over SSH`. A pull-only tool such
as comin would duplicate `fleet-sync` without the controller's role assignment,
drain gate or rollback reporting.

- **Satisfies instead:** deterministic precedence and no split-brain (below).

### Ownership and precedence (Git versus controller)

One owner per value, with a fixed order when layers meet:

| Concern                                                                             | Owner                                                                 | Notes                                                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| System code, closures, the role registry, encrypted secrets                         | **Git**                                                               | A node only builds closures in the `roles.json` of the revision it fetched. |
| Assignment: which role a node has, runtime settings, runner repositories and labels | **Controller**                                                        | Nodes report observed state and never change it.                            |
| Hardware facts                                                                      | **Node**                                                              | Reported, never trusted for assignment.                                     |
| Effective settings, lowest to highest priority                                      | derived controller defaults, then `fleet`, `role:<role>`, `node:<id>` | `src/domain/effective-config.ts`; the GitHub placement layer is the lowest. |

A controller setting can only choose among things Git defined, so the two cannot
conflict. This is level-triggered and tested (`test/resilience/desired-state-invariants.test.ts`: desired revision is a pure function of role, closure and effective values).

## Shared compute: K3s, Flux CD and ARC

### Decision

**Do not adopt K3s, Flux or ARC now. Keep NixOS-native ephemeral runners.** Re-evaluate
when one of the triggers below fires. The role registry (`roles.json`) already lets a
`k3s` role be added later without redesign, so the option is preserved.

### Why not now (checked against the actual workload)

1. **Scale-from-zero and bin-packing are not needed.** GitHub already routes a queued job to any idle runner whose labels match, across all registered runners. On owned machines an idle ephemeral listener costs a process, not money. ARC's headline benefit (scale runner pods with the queue) matters for elastic cloud nodes.
2. **Nix-native jobs fit a NixOS host, not a pod.** The workload relies on the host Nix daemon, a persistent store as the cache, `nix-ld` and `nix develop`. In a pod each job would need Nix installed and a persistent store volume per node, and would lose the shared cache unless a hostPath is mounted, which weakens isolation.
3. **ARC's container modes carry constraints.** The runner scale set supports a Docker-in-Docker mode that needs a privileged daemon, and a Kubernetes mode that runs jobs through container hooks, requires job containers on every workflow by default and needs volumes or elevated rights (GitHub's own ARC documentation describes both). Our opt-in rootless Podman is unprivileged. The ARC behaviour is from public documentation read for this review; it was not exercised here.
4. **It adds a second reconciler.** K3s (server, datastore, CNI), Flux and the ARC controller and listener would reconcile in parallel with `fleet-sync` and the controller. The "avoid overlapping tools" rule excludes that, and node enrollment would need a second join credential and lifecycle.
5. **Control-plane placement.** A K3s server runs on a worker node, which conflicts with "the controller must remain functional independently of individual worker nodes" unless a dedicated server is added. That is more machines, not fewer.
6. **Operational cost** (upgrades, certificates, etcd or SQLite state, CNI, registry credentials) is high relative to a fleet that has about a handful of machines.

### What would change the answer (adoption triggers)

Adopt K3s as a new role, and ARC only on top of it, if any of these becomes true:

- Long-running services or AI-agent workloads need bin-packing and rescheduling across several nodes.
- Jobs must be isolated per pod or per microVM because untrusted code (forks, public repositories) will run.
- CI becomes bursty enough that runners should scale to zero or into rented cloud nodes.
- More than roughly ten nodes make a fleet-wide queue-based autoscaler worth its overhead.

If adopted: K3s with ARC ephemeral runner scale sets, GitHub App credentials held by the
controller, Flux only if there is a Git-managed manifest set to reconcile. Not before.

### What Fleet does instead (the native equivalent)

| Kubernetes concept       | Fleet equivalent                                                                                           | Status                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Ephemeral runner per job | `ephemeral = true`, clean slot state after each job                                                        | Verified in module and VM tests (VM tests not run here) |
| Resource requests/limits | One `fleet-ci.slice` capped at 88% soft and 92% hard memory; equal CPU and I/O weight per slot; `TasksMax` | **Added now**, static test only (see below)             |
| Priority class           | CI slots get `OOMScoreAdjust = 500`; `fleet-agent` gets `-500`, so CI is sacrificed first                  | **Added now**                                           |
| Node affinity, taints    | Runner labels from hardware capabilities (`gpu`, `high-mem`), `[self-hosted, nixos, ci]` routing           | Existing                                                |
| Pod disruption / drain   | Drain gate, label removal, reboot only when idle, health-checked rollback                                  | Existing; operations model added in the previous change |
| Queue visibility         | Controller mirrors jobs and runners from the GitHub API                                                    | Added in the previous change                            |

Limits of the native equivalent, stated plainly: there is **no per-slot absolute memory
limit** (the slot count is derived at boot from live CPU and RAM, which Nix cannot know
at evaluation time), and **all slots share one kernel and Nix daemon**.

## GitHub Actions

| Requirement                                             | Decision and evidence                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ARC ephemeral scale sets                                | Deferred (above). The ephemeral-runner property is met by `services.github-runners` from nixpkgs, an upstream-maintained module.                                                                                                                                                                       |
| GitHub App authentication                               | Adopted. The controller signs the App JWT and mints short-lived registration tokens; nodes request them with their own credential (`POST /v1/runner-registration`). No PAT is used. Verified: `test/github/*` against a loopback fake GitHub (100 tests, run). Unverified: a real GitHub organisation. |
| Organisation versus repository scope                    | Prefer **organisation scope with a runner group**: GitHub routes jobs, and the controller computes no placement. Controller placement exists only for repository scope (`src/github/runner-defaults.ts`), which is needed for personal accounts.                                                       |
| Container actions, service containers, Docker workflows | Partially. Opt-in rootless Podman with a Docker-compatible socket; Podman does not implement every Docker API, so each project's `container:` and `services:` usage must be qualified. Hosted fallback stays available (`use_github_hosted`).                                                          |
| Isolation and security boundary                         | Separate user, work directory, cache directory and cgroup per slot; trusted private repositories only; **not a hostile multi-tenant boundary** (shared kernel and Nix daemon). Runner users never receive the App key. Stated in `onboard-project.md`.                                                 |
| Turborepo remote cache, Attic                           | Not deployed. The private caches were retired by the operator (`docs/runbook.md`, "Caches"). Projects may point Turbo at their own scoped cache credentials. Revisit if rebuild time justifies running Attic; the module hook (`modules/cache.nix`) remains.                                           |

## Observability

The controller is the fleet's single pane: node health, convergence, incidents,
restart history, queue and runner state. It was extended in the previous change rather
than replaced by a monitoring stack, because the audit's requirements are about
fleet-lifecycle visibility that generic exporters do not provide (convergence,
drain state, readiness, per-slot job state).

| Tool                         | Decision                    | Reason and evidence                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prometheus                   | Interface, not a deployment | `GET /metrics` (admin-authenticated) exports node up, convergence, readiness and the new hardware series; unsupported or stale series are omitted, never exported as zero. Verified: `test/controller/admin-data.test.ts`, `health-metrics.test.ts`.         |
| node_exporter                | Not adopted                 | The agent already reports CPU, memory, filesystems, network, temperatures, GPU, disk I/O and pressure. A second collector on every node would duplicate it and add a port to protect. If an operator wants host metrics in their own stack, enable it there. |
| kube-state-metrics, cAdvisor | Not applicable              | No Kubernetes.                                                                                                                                                                                                                                               |
| Grafana, Alertmanager        | Operator-side               | They consume `/metrics`. Fleet keeps a built-in webhook alert and `/incidents`. Not installed.                                                                                                                                                               |
| Loki                         | Not adopted                 | Nodes send allowlisted summaries only, on purpose (arbitrary journald and job output are not ingested, because they can hold secrets). Full logs stay in `journalctl` and GitHub.                                                                            |
| Tempo / OpenTelemetry        | Not adopted                 | `@pkgs/logger` already emits a request id and trace id per controller request and `X-Request-ID`; issue reports carry them. This is correlation, not distributed tracing. An OTLP exporter can be added at that one boundary if a backend is ever deployed.  |
| lm-sensors                   | Not needed                  | Temperatures and power come from sysfs hwmon and powercap directly.                                                                                                                                                                                          |
| smartmontools                | Adopted                     | `smartctl -j -H -A -n standby` (read-only), added to the agent's PATH; falls back to sysfs state, labelled estimated. Unverified on real disks.                                                                                                              |

Limit: telemetry is a bounded current snapshot plus a compact history (default 30 days,
configurable), not a log or trace archive.

## Provisioning and networking

- **Canonical MAAS: rejected.** MAAS deploys Ubuntu and a few other systems from curated images; other systems need custom images built with community Packer templates and a curtin hook, and non-Ubuntu images still boot an Ubuntu ephemeral OS first (MAAS documentation). NixOS is not an upstream-supported target, so MAAS would add a region and rack controller and a database while still requiring our own installer logic. It does not meaningfully reduce complexity. The earlier PXE role was retired because it never produced an installer that could finish.
- **Redfish / IPMI: deferred.** They would let the controller power-cycle a node or mount an ISO remotely, but the current hardware class (compact workstations) has no BMC. Trigger: servers with a BMC. It would be a separate capability added then; nothing in the node record exists for it today.
- **Tailscale / WireGuard: deferred.** Nodes call the controller and GitHub outbound over TLS; no inbound path is needed for CI. A mesh becomes worthwhile for remote devbox access or BMC networks. It would be a NixOS module plus a controller-issued, rotating auth key, and should not be added before that need exists.

## Custom components that remain, and why

Every one is thin glue around an established system rather than a replacement for it.
Each has a removal trigger.

| Component                                    | Does                                      | Established alternative      | Why it stays                                                                                    | Remove when                                                  |
| -------------------------------------------- | ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Controller desired-state and reconcile loop  | Assigns role/settings, tracks convergence | Colmena/Clan/comin           | Push tools conflict with the SSH rule; pull tools lack assignment, drain and rollback reporting | A tool provides pull, assignment and health-checked rollback |
| Runner token broker                          | Mints short-lived registration tokens     | ARC                          | ARC needs Kubernetes                                                                            | K3s + ARC adopted                                            |
| GitHub job/runner mirror, orphan cleanup     | Visibility and cleanup                    | ARC's listener               | Same                                                                                            | K3s + ARC adopted                                            |
| Repository placement (repository scope only) | Spreads repositories over nodes           | Organisation runner group    | Needed only for personal-account repositories                                                   | Use organisation scope                                       |
| Telemetry collectors and incidents           | Fleet-lifecycle visibility                | node_exporter + Alertmanager | Convergence, drain and readiness are not exporter metrics                                       | A backend is chosen and the agent's report becomes redundant |
| Wizard installer                             | Zero-command install                      | nixos-anywhere, MAAS         | See above                                                                                       | A universal firmware-level installer exists                  |

## Verification status of this document

| Claim                                                  | Status                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository facts (modules, settings, docs cited above) | Verified by reading the files.                                                                                                                                                                                    |
| Controller tests (1188 pass, 2 skip, 0 fail)           | Run.                                                                                                                                                                                                              |
| Runner resource controls are declared and consistent   | Static test run (`packages/fleet/tests/test_runner_resources.py`). **The Nix evaluation and behaviour under memory pressure were not run: no Nix here.** Run `bun run check:nix` on Linux before relying on them. |
| ARC modes, MAAS image support, Colmena/Clan model      | From public documentation and background knowledge, not exercised here. Re-check against current upstream docs before acting on a trigger.                                                                        |
| Hardware paths, SMART and GPU collectors, real GitHub  | Not exercised.                                                                                                                                                                                                    |
