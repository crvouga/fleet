# Node resilience: failure modes, recovery and open questions

A fleet node must survive power loss, hard resets, crashes and network loss at
any moment, including in the middle of an update or a CI job, and come back to
work without a person. This page lists the failure modes we know of, what the
node does about each now, how that is tested, and the decisions that are still
open. It complements [two-role-design.md](two-role-design.md), whose
observability plan (persistent journal, metrics backend, alerts) is not
repeated here.

## What "without losing or duplicating work" means here

- **CI jobs cannot be resumed.** A GitHub Actions job runs once on one runner.
  If the runner disappears, GitHub fails the job after it loses contact; no
  runner can pick it up half way. So the node guarantees that an interrupted
  job is **reported exactly once** in Fleet, with the repository, run and a link,
  and that the slot it ran in starts the next job **clean** (its cache is
  cleared). It **never re-runs a job by itself**: a job may deploy, publish or
  migrate something, and only a person (or the workflow's own retry policy)
  knows whether repeating it is safe. See [Q1](#q1-automatic-re-runs).
- **Node operations are resumable and idempotent.** An update, a drain, a
  quarantine and a registration either finish or are retried from durable
  state after a reboot; repeating any step is harmless.
- **Recovery facts are delivered at least once and stored once.** Each is
  written to a durable outbox on the node with a stable key before anything
  else happens, resent until a heartbeat carrying it is accepted, and ignored
  by the server when its key is already stored.

## Building blocks

| Piece             | Where                                                                                              | What it guarantees                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable writes    | `recovery.durable_write`, `fleetconf.write_atomic`, `runner_job.durable`                           | Temp file, fsync, rename, fsync of the directory: after a power cut a reader sees the old file or the whole new one.                                                                                                                                                   |
| Boot record       | `scripts/recovery.py boot` / `shutdown`, `modules/recovery.nix` (`fleet-recovery.service`)         | Every boot is recorded as started; an orderly shutdown marks it clean. A boot that was never marked clean ended in power loss, a hard reset, a panic or a watchdog reset. A kernel crash record (pstore) is named when one exists; otherwise the cause is "not known". |
| Job record        | `runner_job.py` hooks, `/nix/ci-state/<slot>/job.json`, `interrupted-*.json`                       | The running job is on disk for the whole job. A record left by an earlier boot was cut off by a reset; a job its runner saw stopped is kept apart so the next job cannot overwrite it.                                                                                 |
| Outbox            | `/nix/fleet-state/recovery/outbox`, sent by `agent.py`, deduplicated by `fleet-api` `insertEvents` | Bounded (200, oldest dropped first) list of keyed events, cleared only after an accepted heartbeat.                                                                                                                                                                    |
| Drain reasons     | `/run/fleet/drain-reasons/{config,update,low-disk,manual}`                                         | Each closer of runner admission records why and clears only its own reason; admission reopens when none is left.                                                                                                                                                       |
| Kernel quarantine | `fleet-sync.sh` `detect_fallback`, `sync/pending-boot`, `sync/quarantine.json`                     | A kernel the firmware fell back from is not installed again until a newer kernel arrives or a person retries it.                                                                                                                                                       |
| Recovery facts    | heartbeat `recovery` (`PROTOCOL.md`), node page **Recovery** panel, node console **Recovery** line | Last shutdown clean or not, quarantined kernel, why admission is closed, undelivered events.                                                                                                                                                                           |
| Operations        | `sync.retryBootAfter`, `runners.reopenAfter` (node settings, set by node-page buttons)             | Declarative ("data, never code"): the node acts at its next report; settings history records who and when. No command channel.                                                                                                                                         |

## Failure modes

Status: **fixed** (changed and tested here), **handled** (already correct; verified in code), **open** (known, not changed; see the questions).

| #   | Scenario                                                                    | Before                                                                                                                                                                                                                  | Now                                                                                                                                                                                                                                                  | Status  | Tests                                                |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| 1   | A kernel update does not boot healthily and systemd-boot falls back         | The next sync saw the old kernel, installed the same one again and rebooted into it: a drain and three reboots on every poll, forever. A network outage during the first boots of a new kernel triggered the same loop. | The fallback is detected from `pending-boot` (which boot asked for which system). The kernel is quarantined, the working system becomes the default again, the new userspace is still applied without a reboot, and Fleet gets `update-quarantined`. | fixed   | `test_sync.py` quarantine tests                      |
| 2   | An update changes a runner unit while it runs a job                         | Runner units were restarted by `switch-to-configuration`, which killed the job. They embedded the shared scripts store path, so almost every update changed them.                                                       | `restartIfChanged = false` on runner units; the job hook has its own store path. A busy slot takes the new system after its job, an idle one is restarted by the agent (`refresh_stale_slots`).                                                      | fixed   | Nix evaluation; `test_agent.py`                      |
| 3   | Power loss or a panic in the middle of a CI job                             | The job identity lived only in tmpfs: nothing recorded which job died. The slot's half-written cache was reused by the next job.                                                                                        | At the next boot, before runners start, the job is reported as `job-interrupted` (repository, run, attempt, link; not re-run) and the slot's cache is cleared.                                                                                       | fixed   | `test_runner_job.py` `DurableJobRecoveryTests`       |
| 4   | A runner is stopped mid-job (drain timeout, crash, OOM)                     | `job.json` was marked interrupted in tmpfs and then overwritten by the slot's next job, often before the agent reported it.                                                                                             | Moved to its own `interrupted-*.json`, reported by the agent's next cycle, cache cleared by the slot itself.                                                                                                                                         | fixed   | `test_runner_job.py`                                 |
| 5   | Unclean shutdown (power loss, hard reset, panic, watchdog)                  | Indistinguishable from a planned reboot: every boot sent the same `boot` event.                                                                                                                                         | `unclean-shutdown` event with the previous boot's start time and any pstore record; the node page shows the last shutdown and how many recent boots ended uncleanly. The cause is stated as unknown unless the kernel kept a crash record.           | fixed   | `test_runner_job.py`, `test/domain/recovery.test.ts` |
| 6   | Low disk closes runner admission                                            | `fleet-cache-clean` closed the gate and nothing reopened it until a reboot: the node silently served no jobs.                                                                                                           | `low-disk` reason; the cleanup lifts it when space recovers and resumes if no other reason holds admission. `fleet-resume` refuses to reopen while low disk holds it.                                                                                | fixed   | `test_resume.py`                                     |
| 7   | A cordon lifted while its drain was still starting                          | The agent removed its marker before the drain closed the gate; the gate stayed closed with no owner.                                                                                                                    | A gate held by no reason (or only `config` when the config wants it open) is reopened and reported as `gate-reopened`.                                                                                                                               | fixed   | `test_agent.py`                                      |
| 8   | A heartbeat is stored but its response is lost; the agent resends           | Agent events were inserted again: duplicate rollback, boot and config events.                                                                                                                                           | Every agent event has a key; the server skips keys this node already reported. The server's own duplicate rollback event is gone too.                                                                                                                | fixed   | `test/api/recovery.test.ts`, `test_agent.py`         |
| 9   | Several reboots while Fleet is unreachable                                  | Collapsed into one `boot` event; nothing was kept for later.                                                                                                                                                            | Each unclean shutdown and interrupted job waits in the durable outbox (bounded at 200) and is delivered when Fleet is reachable again.                                                                                                               | fixed   | `test_runner_job.py`                                 |
| 10  | Power loss while `config.json` or agent state is written                    | Temp file and rename without fsync: an empty file after power loss made a cordoned node start runners again (fail-open).                                                                                                | fsync of the file and its directory before and after the rename.                                                                                                                                                                                     | fixed   | existing `test_agent.py`                             |
| 11  | Power loss during `nix build`, profile switch or activation                 | Handled: `pending-generation` keeps the previous rollback root; the timer retries.                                                                                                                                      | Unchanged.                                                                                                                                                                                                                                           | handled | `test_sync_recovery.py`                              |
| 12  | Power loss during a drain or the reboot stagger                             | Handled: the `/run` markers vanish, runners re-register with `replace = true`. The stagger sleep restarts from zero.                                                                                                    | Unchanged. A node that reboots often may never finish its stagger.                                                                                                                                                                                   | handled | `test_sync.py`                                       |
| 13  | Power loss while systemd-boot entries are rewritten (`boot-count.sh`, vfat) | Old entries are deleted before the new one is renamed into place; no `sync`.                                                                                                                                            | Unchanged.                                                                                                                                                                                                                                           | open    | [Q5](#q5-esp-write-ordering)                         |
| 14  | Removing a node (`fleet-node remove`) interrupted by power loss             | Runners are withdrawn on GitHub before the `withdrawn` marker is written, so the node can re-register after reboot.                                                                                                     | Unchanged (the code is in `decide.py`, which another change is editing).                                                                                                                                                                             | open    | [Q6](#q6-removal-ordering)                           |
| 15  | A devbox reboots for a kernel update                                        | No drain and no warning: SSH sessions and processes are killed.                                                                                                                                                         | Unchanged; the reboot is reported.                                                                                                                                                                                                                   | open    | [Q4](#q4-devbox-reboots)                             |
| 16  | History before a crash                                                      | The journal is volatile, so the logs leading up to a crash are gone.                                                                                                                                                    | Unchanged; planned in two-role-design.md (persistent capped journal).                                                                                                                                                                                | open    | two-role-design.md                                   |

## Operations in the dashboard

The node page has a **Recovery** panel (`packages/fleet-api/src/console/node-recovery.tsx`, `src/domain/recovery.ts`):

- **Last shutdown**: clean, not clean (with the recent unclean count), or not recorded yet.
- **Kernel update**: quarantined since when, from which revision, and why the
  cause is uncertain. **Retry the update** sets `sync.retryBootAfter` to now.
- **Runner admission** (ci): open, or closed with every reason. **Reopen runner
  admission** appears only for a manual drain and sets `runners.reopenAfter`;
  low disk and an update in progress still hold admission.
- **Interrupted jobs** in the last 7 days, each with a link to its run on GitHub.
- **Undelivered events** still waiting on the node.

Both operations are per-node settings, so they are audited in settings history
and reach the node through the existing configuration channel. The panel shows
the node's next report, which is the acknowledgement.

## Open questions

### Q1. Automatic re-runs

Should Fleet re-run a job a node interrupted? Re-running needs the GitHub App
`actions: write` permission (today it has runner administration only), and a
re-run repeats every side effect of the job. Options: never (today); opt-in per
repository through a Fleet setting; or a workflow-side convention (for example
jobs labelled idempotent). Needs a decision on which repositories' jobs are safe
to repeat.

### Q2. Rolling back on an outage during a kernel's first boots

`boot-health.sh` reboots a counted boot that cannot reach GitHub or the cache,
so an internet outage right after a kernel update makes the node fall back. That
is now bounded (one quarantine instead of a loop), but the kernel stays
quarantined until a newer kernel or a retry. Options: keep it (safe, costs an
update); reboot only when the local network itself is down (fewer false
fallbacks, but a kernel that breaks only the update path would be blessed); or
retry a quarantined kernel automatically once after a cool-off period. Needs a
decision on which failure is worse.

### Q3. What happens to slots when power returns

A node that loses power repeatedly (failing supply, tripping breaker) will keep
starting jobs that die. Should a node that recorded N unclean shutdowns within an
hour cordon itself until a person looks? Needs a threshold, or a decision that
Fleet only reports.

### Q4. Devbox reboots

Devboxes reboot for kernel updates without warning. Options: a maintenance
window, a broadcast to logged-in users with a delay, or reboots only on request
(`reboot.enabled: false` for the devbox role). Needs the devbox users' preference.

### Q5. ESP write ordering

`boot-count.sh` should create the new entry before deleting the old ones and
`sync -f /boot` after; the 300 s activation timeout can also kill a bootloader
install part way. Not changed here because it needs testing on real firmware
with real systemd-boot counting, which no VM test covers today (all VM tests
turn systemd-boot off).

### Q6. Removal ordering

`fleet-node remove` should write `withdrawn`, stop the runner units, then
withdraw on GitHub. The code is in `decide.py`, which the two-role change is
editing; change it after that lands.

### Q7. Alerts

Recovery events are visible in the dashboard but only `offline` is sent to
`alerts.webhookUrl`. Which of `update-quarantined`, `job-interrupted` and
`unclean-shutdown` should page a person, and where? Depends on the alerting
decision in two-role-design.md Q14.

### Q8. UPS and orderly shutdown

With a UPS that signals the host (NUT), a node could close admission and shut
down cleanly before the battery runs out. Depends on the hardware.

## Not verified

- Behaviour on real hardware: power cuts, real systemd-boot boot counting and
  fallback, pstore availability, and whether every machine has a hardware
  watchdog. The VM tests disable systemd-boot and never hard-reset a machine.
- GitHub's handling of a job whose runner vanished (my understanding: the job
  fails after a timeout of minutes and is not re-queued) and of the stale
  ephemeral registration (replaced by the next registration with the same name).
