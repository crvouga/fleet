# Onboard any trusted private project

1. Commit a project `flake.nix` and `flake.lock` with a `devShell` containing its language toolchain and test dependencies. Check locally with `nix develop --command bash -euo pipefail -c 'YOUR_CHECK'`. The runner service supplies Bash, Git, `gh`, Nix, nix-ld and operational tools; NixOS runner internals also provide their required Node runtime, not a project SDK. Workflow steps must supply their own scoped `GH_TOKEN` when using authenticated `gh` commands; the host does not log in or share its registration credential with jobs.
2. With approval, include the repository in the organization runner group's selected private repositories, or add its `owner/name` to `settings/github.json`'s `repositories` list and deploy. Personal-account repositories cannot share an organization-level group. Repository mode distributes the configured total slot count round-robin; if repositories outnumber slots, some have no runner and need hosted fallback or more slots/nodes.
3. Call `.github/workflows/runner-check.yml` at a reviewed commit SHA in this workspace (replace `OWNER/REPO` below), or copy [the example](../workflows/project-example.yml). Change `runs-on` in existing jobs to `[self-hosted, nixos, ci]` and run commands inside the project's devShell. Protect workflow changes. The reusable entrypoint permits private same-repository PRs on self-hosted execution; forks must explicitly select hosted fallback, and `pull_request_target` is never sent to the fleet.

   ```yaml
   jobs:
     check:
       uses: OWNER/REPO/.github/workflows/runner-check.yml@COMMIT_SHA
       with:
         nix_command: bun run check
         use_github_hosted: false
   ```

4. Projects opt into disposable persistence using `CI_CACHE_DIR` (per slot) or `CI_PROJECT_CACHE_DIR` (namespaced by repository). Point `XDG_CACHE_HOME`, compiler caches or package caches there deliberately. Never put credentials, essential artifacts or authoritative data in them. For example `nix develop --command bash -c 'export XDG_CACHE_HOME="$CI_PROJECT_CACHE_DIR"; YOUR_CHECK'`. Concurrent slots have separate directories; within one slot use explicit project namespaces. The Nix store is cached automatically and periodically collected.
5. Set `use_github_hosted: true` to route to Ubuntu when the fleet is unavailable. This is an explicit scheduling choice; GitHub cannot automatically fall back after a self-hosted job queues. Hosted Nix installation is performed by the reusable workflow. GitHub-hosted fallback needs outbound downloads and may incur normal account usage; no billing settings are changed here.
6. Set a project matrix's `max-parallel` to its available total slots (node count × slots in organization mode, or the smaller per-repository allocation). A 16-core 32 GiB machine supplies 4 slots, not 32 jobs. A larger machine supplies more, up to 8. Ask for `gpu` or `high-mem` only when the job needs that capability. Cancel outdated PR runs with concurrency; cap compiler/Turbo parallelism so one job does not assume every core and all of the RAM.

`apt-get` and Playwright `--with-deps` are Ubuntu-specific: replace them with devShell packages. Pin browsers and Playwright together; a browser downloaded for Ubuntu may lack compatible NixOS libraries. `nix-ld` provides an ELF loader, not every possible dependency: put libraries/source builds in the devShell or use a Nix-packaged program. Rootless Podman is optional and exposes a per-slot Docker-compatible socket. Enable `containers` only for trusted jobs, validate the exact `container:` and `services:` actions those projects use, and keep the hosted fallback available; Podman does not implement every Docker API behavior.

## Qualify the service and project before routing production jobs

Every slot runs a prerequisite probe before its listener starts, using the
service's PATH, slot user, working filesystem and sandbox. It resolves and
executes `bash`, `git`, `gh` and `nix`, creates symlinks and paths longer than
260 characters, and clones a local Git repository containing both. No network,
GitHub login or project code is involved. Versions and failures go to
`journalctl -u github-runner-slot-N`; `/run/fleet/slot-N/prerequisites` contains
the bounded result. A failed probe prevents the listener from accepting jobs.
The Fleet heartbeat and node console report the failed stage, or missing proof,
rather than treating GitHub's online status alone as sufficient. These records
are slot-written diagnostics, not security attestations.

The NixOS VM test checks those probes and runs a shell through the service PATH.
It uses a mock listener and does not prove that a real Actions job, external
tool download or project browser works. Before production routing, run a trusted
smoke workflow on `[self-hosted, nixos, ci]` that performs actual
`actions/checkout`, verifies a committed symlink and creates another, prints
tool versions, enters the project's pinned devShell and executes its real
toolchain and headless-browser smoke test. Fail the smoke job if the browser
cannot start; a warning is not qualification. Keep the browser sandbox enabled.
Validate this within the runner sandbox, not from root or the coding desktop.
Do not grant runner users general sudo or weaken all service restrictions to
make an Ubuntu-specific setup work. Any necessary OS capability must be reviewed
and declared in the existing role/capability modules, with a service-context test.

Linux symlinks do not require Windows Developer Mode, and Windows Git/registry
long-path switches are not Linux settings. The probe checks actual Linux
behavior instead. A successful generic probe does not qualify every project
dependency or replace the real-job smoke gate.

Only trusted private code may run here. Separate slot users and work directories prevent ordinary accidental mixing; they are not a hostile multi-tenant security boundary. All jobs share a kernel, Nix daemon and persistent caches. No fork PRs, public repo code, or unreviewed workflow changes. All fleet jobs must request `nixos` and `ci` so label-based draining prevents new assignments.

GitHub documentation: [registration scopes](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners), [runner-group private access](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access), [ephemeral runners and external logs](https://docs.github.com/en/actions/reference/runners/self-hosted-runners), and [job hooks](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts).
