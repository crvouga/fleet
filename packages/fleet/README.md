# Fleet

`@pkgs/fleet` is the NixOS flake for the physical machines we own and run ourselves. Every machine has one **role**, and any machine can be replaced by any other of the same role. Cloud resources stay in `@pkgs/infra`.

Before the first rollout, read the [bring-up readiness record](docs/readiness.md)
for the verified builds, outstanding production prerequisites and installation order.

Roles are defined once, in [`roles.json`](roles.json). Change a role there,
then run `python3 scripts/fleet_roles.py sync` (`just roles-sync`); see the
Roles section of [AGENTS.md](AGENTS.md).

| Role     | What the machine does                                                      |
| -------- | -------------------------------------------------------------------------- |
| `ci`     | GitHub Actions runners for trusted private repositories                    |
| `devbox` | SSH development machine (`dev` account, persistent `/nix/devbox`, no sudo) |

`web`, `cache` and `netboot` are retired: no machine can be installed as them,
and a remaining node reports `FLEET_ROLE_RETIRED` until it is reinstalled.

## Add a machine

You need the machine, power, and working Ethernet or supported personal Wi-Fi.
No second computer or node-terminal commands are needed for the supported
Windows/Linux x86-64 UEFI conversion path. Firmware and hardware constraints
are listed in the readiness record.

1. Open [Fleet](https://fleet.example.com) on the new machine and download its installer:

   | The machine runs       | Download                                |
   | ---------------------- | --------------------------------------- |
   | Windows (Intel/AMD)    | `fleet-installer-windows-x64.exe`       |
   | Linux (Intel/AMD)      | `fleet-installer-linux-x64.tar.gz`      |
   | macOS                  | the wizard makes a USB stick instead    |
   | nothing (a blank disk) | see [a blank machine](#a-blank-machine) |

2. Open it and answer one question: **what kind of machine is this?** (`ci` or `devbox`). The installer shows the exact disk it will erase and asks you to confirm.
3. A GitHub page opens. Press **Submit new issue**, signed in as the repository owner. That click approves this machine and is the only approval anywhere. (Over SSH or without a browser, the installer prints the same link.)
4. Accept the operating system's permission prompt (Windows UAC).

That is all. The installer does the rest, unattended:

The wizard distinguishes a scheduled restart from an installed, integrated
node. Follow its **Monitor in Fleet** link: **Ready** confirms approved reporting,
automatic update/cache checks, and live GitHub runners for CI. Configuration,
credential and connectivity failures stop before erasure where possible and
expose a copyable diagnostic report. A failed update keeps or restores the
previous system and automatically restores runner admission.

```text
download the installer image, check its sha256
ask the owner to approve (the GitHub issue)            nothing erased yet
Windows: shrink C:, write the image into the new       Windows still boots until the restart
         partition, read it back, add a one-time boot entry
restart into the installer
erase the disk, partition it, install NixOS            Windows is gone here
generate the SSH host key, install the role's age key
boot into the role; the hostname is  <role>-<4 hex>
CI: register GitHub runners with the GitHub App; every role: poll main
```

The wizard also installs missing Linux boot tools on supported distributions,
attempts Windows free-space consolidation when needed, retries temporary
download failures, and reconnects to an active job after a browser reload.
There is no separate doctor/plan step for a person using the wizard. See the
[cross-platform installer guide](docs/installer.md) for automatic preparation
and the physical or firmware steps that still require a person.

On a `ci` machine the runners appear in GitHub on their own. On every machine `fleet-node status` answers whether it came up. Nothing was typed into the machine except the role.

Windows needs two things the installer cannot change from inside Windows: **Secure Boot off** (the installer is not signed; `doctor` says so and gives the one command that opens the firmware screen) and a UEFI/GPT disk. Both are checked first, before anything is changed.

### Other ways to start the same install

| Situation                | Do this                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux or macOS, no GUI   | `curl -fsSL -o fleet-node.sh https://github.com/crvouga/fleet/releases/download/fleet-installer/fleet-node.sh && sudo bash fleet-node.sh ci`                 |
| Let an agent do it       | Tell it: `Set this machine up as a fleet <role> node by following https://raw.githubusercontent.com/crvouga/fleet/main/packages/fleet/docs/agent-install.md` |
| No questions at all      | `sudo bash fleet-node.sh ci --yes` (the confirmation is taken as typed; every disk refusal still applies)                                                        |
| Check without changing   | `sudo bash fleet-node.sh doctor ci` (`--json` for programs). Writes nothing, reports every problem at once, names the exact disk.                                |
| Install without approval | add `--no-enroll`. The node makes its own age key, so it cannot read the secrets other nodes of that role share.                                                 |
| You already have a token | `--token-file PATH` (never an argument). A token is a single-use Vault wrapping token; `just enroll <role>` prints one.                                          |

A USB, removable, hotplug or ambiguous disk is refused on every operating system. A mounted internal disk is not: the disk holding the running system is always mounted, and converting that machine is the point.

### A blank machine

A machine with no operating system cannot download anything. On any other computer run the wizard and choose **Make an install USB stick** (or `bash fleet-node.sh flash`). Boot the blank machine from the stick, pick the role in the menu (it waits for you, and every entry says it erases the disk), and it installs. A USB install cannot carry an approval, so that node makes its own age key; reinstall it from its own OS if it must share its role's secrets.

## Remove or replace a machine

- Remove: `fleet-node remove` on the node. It withdraws the runner, writes `/nix/fleet-state/withdrawn` (the runner refuses to start again, even after a reboot) and powers off once no job is running. It never stops a running job.
- Replace: add another machine of the same role. There is no host file to edit.
- Convert: run the installer again and choose another role. This erases the machine.

## One-time setup (the repository owner, once for the whole fleet)

A new machine needs none of this. It exists so a new machine can need nothing.

```sh
mise install                       # just, age, sops, opentofu, gh (repo root)
just setup                       # in packages/fleet; reads settings/github.json
```

`just setup` does four things and is safe to run twice:

1. creates one age key per role (private keys to the vault OpenTofu root's git-ignored `fleet-age-keys.auto.tfvars.json`, public recipients to `.sops.yaml`),
2. creates the **GitHub App** that registers runners, from a manifest: you press **Create GitHub App** and then **Install**, choosing the private repositories. Repositories are never guessed,
3. encrypts the App's private key into `secrets/fleet.yaml` for the `ci` role only,
4. fills `settings/github.json` with the App and installation IDs, scope and bootstrap repository allowlist, then enables the encrypted secret in `fleet.nix`. Use `--repos owner/private-repo` only to override the JSON allowlist for setup.

On the local setup page, press **Create runner GitHub App**. Keep that page open: GitHub opens in another tab. If GitHub asks you to sign in or confirm access and then reports a missing App Manifest, finish authentication, return to the setup page, and press its button again.

Finish the reviewed setup steps:

1. Merge the pull request with `settings/github.json`, `fleet.nix`, `secrets/fleet.yaml` and `.sops.yaml`. The `Fleet` workflow builds every role and publishes the installer release.
2. Apply the vault root so Vault holds the role keys and the `fleet-enroll` login:

   ```sh
   bun run infra:vault plan -out=fleet.plan     # review
   bun run infra:vault apply fleet.plan
   ```

   Include the same complete `fleet_age_keys` map in the foundation root's `vault_inputs` JSON, which manages the `TOFU_VAULT_INPUTS` GitHub secret. CI uses that input for later Vault applies; the local ignored tfvars file is not available there.

3. Apply the `foundation` root (it creates the `fleet` Postgres schema and its tables) and the `fleet` root (it deploys the fleet API at https://fleet.example.com). CI does both in order on a merge once `TOFU_MIGRATION_READY` is true; the exact order and what to check is in [the infra README](../infra/tofu/README.md#fleet-api-fleet-api).

After that, `bun run health` reports the Vault role and policy as healthy. The bootstrap repository allowlist and GitHub App metadata live only in `settings/github.json`. The dashboard stores runtime repository assignments in Postgres (`runners.repositories`); the App installation bounds which repositories can register. Credentials stay in the existing encrypted secret/Vault flow, never in the JSON file. Do not list public repositories: pull requests from strangers would run on your machines.

## How approval works

The installer release is public, so a machine cannot simply ask Vault for its role key. Instead a human approves it:

1. The machine makes a one-time key pair (X25519, in memory) and opens `issues/new` prefilled with its role and **public** key.
2. The owner submits the issue. The `Fleet enroll` workflow runs only for an issue whose author is the repository owner, from `main`.
3. The workflow logs in to Vault with its **GitHub OIDC identity** (no stored secret). The Vault role is bound to that exact workflow file on `main`, and its policy only allows a **response-wrapped** read of `secret/data/fleet/<role>`, so the workflow never holds the age key.
4. The workflow posts the single-use wrapping token as a comment, **sealed to the machine's public key**. Anyone can read the comment; only that machine can open it.
5. The machine opens it, checks the token with `sys/wrapping/lookup` (which does not spend it), and the installer unwraps it before the disk is touched. A refused, expired or spent token erases nothing.

If the workflow cannot help (no key in Vault yet, Vault down) it comments `fleet-error: …` with the fix, and the installer stops at once, still having erased nothing. Roles never share an age key or a secrets file.

## The fleet API and dashboard

Every machine reports to the **fleet API** at https://fleet.example.com ([`packages/fleet-api`](../fleet-api/README.md)) and shows up on its dashboard within a minute of booting: online, stale or offline, its role, revision, load, memory, disk, runner slots busy, failed units and rollbacks, with a history and an event feed. A machine that stops reporting becomes `offline` and raises an event (and a webhook, if you set one), so a dead machine no longer goes unnoticed. One that removes itself with `fleet-node remove` is retired, not alarmed.

- **Joining.** A machine approved through the GitHub flow holds its role's token and is accepted at once. Any other machine (a USB install, `--no-enroll`) appears under **Pending**, with its facts, until you approve it.
- **Dynamic settings.** Heartbeat interval, pausing updates, reboot behavior, the disk alert threshold, runner capacity, runner labels, which repositories the runners serve, cordoning a machine, and the offline threshold are changed in the dashboard for the whole fleet, a role, or one machine, and reach the node within a minute. No commit, no rebuild. The list, bounds and what each does on the node is [dynamic-config.md](docs/dynamic-config.md). What a machine _is_ (role, closure, secrets, GitHub App) stays in git.
- **Safe by construction.** The API sends data, never code, so a compromised API cannot run anything on the fleet. Without the API, nodes keep their last settings and the values in their image, and updates keep flowing from `main`.
- **Isolated.** The service uses only the Postgres schema `fleet` in the shared database ([why and how](../fleet-api/README.md#the-database-is-shared)).

## What stays physical

Hardware replacement and cleaning, cabling, and one-time firmware settings (Secure Boot off, UEFI boot, power-on after AC loss). See [the checklist](docs/checklist.md). Everything else that seems to need a person at a machine is a bug in the automation.

## Day to day

Git is the only control surface. Open a pull request; `Check` and `Fleet` pass on GitHub-hosted runners; the merge lands on `main`; nodes poll `main` and switch only to a system that is already in the binary cache. A bad change is a revert pull request. `fleet-node status` on a node is read-only. See [operations](docs/runbook.md).

## NixOS installs and hard reinstalls

Every fleet role includes the native `fleet-installer` browser wizard and
`fleet-node` CLI. They carry their runtime and boot tools and work without
`nix-ld`. Both are available as flake apps for x86-64 and ARM64 Linux; ARM64 can
make USB media, while fleet nodes remain x86-64 UEFI only. See the
[NixOS instructions](docs/installer.md#nixos) for the latest `nix run` commands
and headless operation.

`sudo fleet-node ci --reinstall --plan` previews a hard reinstall;
`sudo fleet-node ci --reinstall` asks for the role and exact disk confirmation,
then obtains fresh enrollment and replaces even a same-role installation.
Without the flag, an existing healthy same-role node is preserved. The wizard
has the same explicit **Hard reinstall** option. Running jobs block either
path; idle CI nodes withdraw and close admission before boot handoff.

## Browser acceptance tests (Gherkin)

Install from the workspace root with `bun install --frozen-lockfile`, then:

```sh
cd packages/fleet
bunx playwright install chromium
bun run test:bdd:local
```

`playwright-bdd` generates Playwright tests from `bdd/features/*.feature`.
The local scenarios drive the real setup form/callback and installer wizard
in Chromium. They also exercise hard reinstalls for every installer role, CLI
idempotence and preview, busy-job refusal, changed-disk refusal and recovery
after a failed boot handoff. Reinstall scenarios use stand-in disks, firmware
facts, runner control and kexec; ISO parsing, checksums, helper processes and
admission locking run for real. They reproduce GitHub losing the manifest during authentication,
retry the original form, verify erase confirmation and image read-back, and
refuse a missing download. GitHub authentication is simulated for this local
regression; disks are temporary regular files behind both existing test guards.
CI runs these scenarios against each actual built download before publication and uploads `fleet-bdd-<os>`. Linux x86-64 and ARM64 also run them against the native Nix package, with separate `fleet-bdd-native-<os>` reports. POSIX-only scenarios are filtered out on Windows; the platform, USB and App setup scenarios run there.

To check the actual deployed `/add` page, GitHub release, all five platform
downloads, multipart manifest and configured private-repository runner App,
run from the workspace root:

```sh
vault run --config prd -- bun run --filter @pkgs/fleet test:bdd
```

The live scenarios require `FLEET_ADMIN_TOKEN`, `sops` and the CI role age key
in `SOPS_AGE_KEY` or the ignored vault-root role-key inputs from setup. Missing
access fails the test. The Windows executable is downloaded through the real
release page and checked against GitHub's published SHA-256 and size. Image
parts receive HTTP checks and their manifest hashes/sizes are compared with
GitHub's asset metadata. The App uses its real encrypted key to obtain a runner
registration token for the configured private repository; it never registers a
runner or writes a physical disk. Live traces/video are disabled and evidence
attachments contain no credentials.

Open `packages/fleet/dist/bdd-report/index.html` for the HTML report and
`packages/fleet/dist/bdd-results.json` for machine-readable results. Reports and
generated tests stay ignored under `dist/`. These tests do not prove a Windows
firmware handoff or a boot on the user's physical machine.

## What is tested, and what is not

| Layer                                                                                  | How                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role selection, disk refusals, confirmation, logs, exit codes                          | `tests/test_fleet_node.py` runs the shipped one-file entry on Linux, macOS and Windows disks                                                                                                                                                         |
| Windows conversion (shrink, raw write, read-back, boot entry, undo)                    | `tests/test_fleet_node.py`, `tests/test_windows*.py` with stand-in `powershell`, `bcdedit`, UEFI variables; every script through the real PowerShell parser in `tests/test_powershell.py`                                                            |
| Approval (X25519 against RFC 7748, sealing, polling, the workflow's half)              | `tests/test_enroll.py` against fake GitHub and fake Vault servers                                                                                                                                                                                    |
| One-time setup (manifest flow, App token, `sops` round trip, `fleet.nix`)              | `tests/test_setup.py` against a fake GitHub, plus real `sops` and `age` when installed                                                                                                                                                               |
| The wizard (server, helper, USB writer, page)                                          | `tests/test_wizard.py`; `wizard/ui-e2e.cjs` in Chromium; each build's `--selftest` on 5 OSes                                                                                                                                                         |
| Everything together: installer scripts, approval, node agent, API, Postgres, dashboard | `tests/test_e2e_chain.py` runs the real programs against each other (no stand-ins except GitHub, Vault, the release host, the disk listing and `kexec`), once with the API as a process and once as its Docker image; CI job `fleet-e2e` requires it |
| The node agent and dynamic settings (register, report, apply, offline, corrupt state)  | `tests/test_agent.py`, `tests/test_node_scripts.py` against a real HTTP server speaking the protocol                                                                                                                                                 |
| The fleet API (routes, auth, jobs, schema isolation, dashboard)                        | `bun run --filter @pkgs/fleet-api test`: real Postgres built by the real Atlas CLI, decoy tables to prove nothing leaves the `fleet` schema                                                                                                          |
| Every role evaluates with the agent wired in                                           | `agent-units` and the other `nix flake check` items                                                                                                                                                                                                  |
| Role closures, installer ISO, sync, rollback, lifecycle                                | `nix flake check` and NixOS VM tests in the `Fleet` workflow                                                                                                                                                                                         |

Run the portable ones with `bun run --filter @pkgs/fleet check`. The owner has created and installed the runner App on github.com; live acceptance tests check its registration permission and the deployed download. Windows conversion, the unsigned-GRUB boot from a raw partition and installation on physical hardware still need a spare-machine test. See [the validation record](docs/validation.md) for the dated evidence and remaining limits.

## Coding on every node

Every fleet role installs Oh My Pi (OMP), Chromium and a private browser desktop, alongside
native Claude Code and Codex. OMP provides one conversation with a model picker;
SSH and the desktop share its session. People give goals to the agent and complete
browser consent. See [the interaction and rollout guide](docs/coding.md), including
provider billing, browser consent and per-node verification.

## Reference

- [Installer guide](docs/installer.md) for people, [agent runbook](docs/agent-install.md) for agents.
- [Operations](docs/runbook.md), [checklist](docs/checklist.md), [onboard a project](docs/onboard-project.md), [secrets](secrets/README.md), [hardware notes](docs/hardware.md).
- [Agent operating rules](AGENTS.md) and [validation record](docs/validation.md).

`fleet.nix` is the CI settings file (the historical name). Shared values are in `settings/shared.nix`. Runner slots are counted at boot: reserve 4 GiB, then one slot per 2 cores and 6 GiB, at most 8. A 16-core 32 GiB machine gets **4 slots**. The root is tmpfs; the EFI partition and `/nix` persist. `just` and the other tools are pinned in the repo-root `mise.toml`.
