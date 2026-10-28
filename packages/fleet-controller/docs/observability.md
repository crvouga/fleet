# Observability: hardware health, restarts and incidents

This extends the "Extended telemetry" section of `PROTOCOL.md` (the lead links
the two). Everything here is **optional** in protocol v2: an older agent omits
it, and an absent field means _unknown_, never zero. Unknown keys are still
discarded and the 64 KiB request cap still applies.

## Provenance: measured, estimated, unsupported, stale

Each metric family the agent reports carries `status` and `reason`:

| status        | meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `measured`    | read from a kernel counter or a tool's own report                                                              |
| `estimated`   | inferred (for example throttling from a CPU frequency below its maximum under load); `reason` says how         |
| `unsupported` | this hardware/image cannot provide it; `reason` (always present) says why. Values are `null`/empty, never zero |

`stale` is not sent by the node. The controller shows **stale** instead of
measured/estimated whenever the whole sample is older than the freshness window
(`sampleIsFresh`: 2.5 heartbeat intervals, at least 90 s) or the node is not
online. A family the agent does not report at all is shown as "Not reported by
this agent" with no badge.

Inside a supported family an individual value that could not be read is `null`
(for example GPU power on a card that does not report it, or a rate on the
first sample after boot). The dashboards print "Unavailable", the charts leave a
gap, and Prometheus omits the series.

## Fields added to `telemetry`

All optional; array sizes are capped (`HEALTH_LIMITS` in
`src/domain/telemetry-health.ts`).

- `gpus`: `{ status, reason, devices[≤8] }`, device
  `{ name, vendor: nvidia|amd|intel, utilizationPercent, memoryUsedBytes,
memoryTotalBytes, temperatureCelsius, powerWatts }`. NVIDIA through
  `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`; AMD through sysfs
  (`gpu_busy_percent`, `mem_info_vram_*`, hwmon temperature/power); Intel only
  hwmon temperature/power when the driver exposes them (otherwise unsupported
  with a reason). Nothing is invented: `[N/A]` and out-of-range values become
  `null`.
- `diskIo`: `{ status, reason, devices[≤16] }`, device `{ name,
readBytesPerSecond, writeBytesPerSecond, iops, busyPercent }` from
  `/proc/diskstats` deltas, whole disks only (`sd*`, `vd*`, `nvme*n*`,
  `mmcblk*`; partitions, loop and device-mapper nodes are skipped). A counter
  reset, wrap or first sample gives `null`, not a negative or zero.
- `diskHealth`: `{ status, reason, devices[≤8] }`, device `{ name, state:
ok|warning|failing|unknown, source: smartctl|sysfs, temperatureCelsius,
wearPercent, powerOnHours, detail }`. With `smartctl` installed the agent runs
  `smartctl -j -H -A -n standby /dev/<disk>` (read-only; `-n standby` never
  wakes a sleeping disk; at most every five minutes, 8 s timeout per disk, 20 s
  total). Without it the family is `estimated` and only kernel device state is
  available: `offline`/`dead` is `failing`, otherwise health is `unknown`
  (SMART health is never claimed from a bare "running").
- `cpuFrequency`: `{ status, reason, currentMHz (mean), minMHz, maxMHz }` from
  cpufreq; unsupported in most virtual machines.
- `throttling`: `{ status, reason, throttled, events, basis }`. `basis:
thermal_throttle` uses `core/package_throttle_count` deltas (**measured**; a
  throttle stays reported for 5 minutes after the last increase so a bursty
  throttle does not flap); `basis: frequency` is **estimated** (CPU ≥ 80 % busy
  while the mean clock is below 70 % of its maximum) and can also be a
  power-saving governor. Power-limit throttling is not visible.
- `pressure`: `{ status, reason, cpu, memory, io }`, each `{ someAvg10,
someAvg60, fullAvg10, fullAvg60 }` or null, from `/proc/pressure/*`.
- `connectivity`: `{ status, reason, controllerLatencyMs, consecutiveFailures }`.
  The latency is the node-measured round trip of its _previous_ heartbeat
  (`agent.py` records it after a 200 reply); `consecutiveFailures` is the
  agent's failure counter when the report was built. Unsupported until a first
  round trip has been measured.
- `lifecycle`: `{ uptimeSeconds, restartCount, trackedSince }`. `restartCount`
  is the number of boots this agent has itself observed since `trackedSince`
  (kept in `telemetry-state.json` across boots); it is not a lifetime count.
- `network[]` entries may add `receiveErrors`, `transmitErrors`,
  `receiveDropped`, `transmitDropped`: counts since the previous sample, `null`
  when unknown (first sample, counter reset, or no error columns).

The collectors are in `packages/fleet/scripts/telemetry_hw.py` (bundled with
`telemetry.py` by the Nix closures and the installer). Each family is wrapped:
an unexpected exception degrades that family to `unsupported` instead of losing
the heartbeat.

## History, retention and charts

Heartbeat history stores a compact summary in `heartbeats.telemetry` (schema
unchanged): CPU, hottest temperature, largest power domain, plus now the busiest
and hottest GPU (at most two devices), the busiest disk and the memory/CPU/IO
pressure averages. Unsupported families are dropped. The summary validates as
telemetry and compacting it again changes nothing.

`FLEET_HEARTBEAT_RETENTION_DAYS` (whole days 1-365, default **30**) sets how
long heartbeat history is kept (the hourly prune job). Events, settings history
and the audit log are not pruned. History responses stay capped at 1,440 points.
`GET /v1/nodes/:id/history?hours=N` (1 to 8760) returns that bounded window; the
console offers 24 hours, 7 days and 30 days. Charts: load, memory, disk, CPU,
hottest sensor, largest power domain, GPU utilization, hottest GPU, busiest
disk, memory pressure and runner slots; unknown values are gaps.

## Prometheus

`/metrics` (admin authorization, `no-store`) adds, for **current** samples of
online nodes only: `fleet_node_metric_provenance{family,provenance}` (1 per
reported family), `fleet_node_gpu_*`, `fleet_node_disk_io_*`,
`fleet_node_disk_busy_percent`, `fleet_node_disk_health_state` (0 ok, 1 warning,
2 failing; unknown omitted), `fleet_node_disk_temperature_celsius`,
`fleet_node_disk_wear_percent`, `fleet_node_cpu_frequency_mhz`,
`fleet_node_cpu_throttled{provenance,basis}`, `fleet_node_cpu_throttle_events`,
`fleet_node_pressure_percent{resource,kind,window}`,
`fleet_node_network_errors_since_last_sample`,
`fleet_node_network_dropped_since_last_sample`,
`fleet_node_controller_latency_ms`, `fleet_node_heartbeat_consecutive_failures`,
`fleet_node_uptime_seconds` and `fleet_node_restarts_observed`. Stale nodes and
samples export none of them; unsupported families and unknown values are
omitted, never exported as zero (the provenance series is the one place an
unsupported family is visible).

## Derived health events

Generated by the controller once per change, like the other derived events in
`src/domain/heartbeat-events.ts` (an unchanged condition is announced once; an
unknown or unsupported reading never opens or closes anything; an event the
node reported itself is not duplicated). Thresholds are constants in
`src/domain/health-events.ts` (`HEALTH_THRESHOLDS`), not settings.

| open                                                                            | close                | condition                                         |
| ------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| `disk_health_degraded` (warn, error when failing; raised again when it worsens) | `disk_health_ok`     | any known disk `warning`/`failing`                |
| `gpu_hot` (warn)                                                                | `gpu_ok`             | hottest GPU ≥ 85 °C                               |
| `throttling` (warn)                                                             | `throttling_ok`      | **measured** throttling only                      |
| `memory_pressure_high` (warn)                                                   | `memory_pressure_ok` | PSI memory some avg60 ≥ 40 % or full avg60 ≥ 10 % |

There is no hysteresis band: a value hovering at a threshold can open and close
repeatedly (the stateless edge comparison has no memory between reports).
`units_failed`/`units_recovered` and `disk_high`/`disk_ok` events now also carry
`data.units` / `data.mount` so incidents pair per unit set and per mount.

## Incidents

`src/domain/incidents.ts` derives incidents from the event stream (nothing is
stored): an opening event starts an incident for (node, rule, subject), the
matching closing event ends it.

| rule                                                | opens                                     | closes                                                   |
| --------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| offline                                             | `offline`                                 | `recovered`                                              |
| units                                               | `units_failed`                            | `units_recovered` (when every failed unit has recovered) |
| disk (per mount)                                    | `disk_high`                               | `disk_ok`                                                |
| rollback                                            | `rollback`                                | `rollback_cleared`                                       |
| reconcile                                           | `reconcile_blocked`                       | `role_converged`                                         |
| disk_health, gpu_hot, throttling, memory_pressure   | the events above                          | their `_ok` partners                                     |
| runner_queue, runners_offline (fleet-wide, no node) | `runner_queue_stalled`, `runners_offline` | `runner_queue_ok`, `runners_ok`                          |
| runner_registration (per node)                      | `runner_registration_failing`             | `runner_registration_ok`                                 |

A repeated opening event only escalates severity; a closing event with nothing
open is ignored; duplicate event ids are collapsed, so deriving twice gives the
same answer and incidents of one rule never overlap on a node. `startedAt` is
when the opening event was stored (for `offline`, when the controller declared
the node silent, not its last report). Each incident has `reportHref`
(`/report-issue?kind=node&event=<opening event id>`).

- `GET /v1/incidents?open=true|false&node=<64 hex>&before=<opening event id>&limit=1..200`
  returns `{ incidents, nextBefore, summary: { open, total, openBySeverity },
truncated }`. Readable by viewers. At most the 5,000 most recent matching
  events are examined; `truncated` says when more existed.
- `/incidents` is the dashboard page (nav link) and the console page; the node
  page has a per-node incident panel.

## Restart and uptime history

`src/domain/restart-history.ts` derives recent boots (at most 20) from `boot`
events (the agent's `boot:<bootId>` key; controller-derived boots without an id
are included) and `unclean-shutdown` events (`data.bootId` names the boot that
ended badly). `GET /v1/nodes/:id/restarts` returns `{ boots[], restarts,
uncleanShutdowns, restartsLast24h, restartsLast7d, current: { bootId,
uptimeSeconds, bootedAt } }`. `previousShutdown` is `unclean` when the node
reported an unclean shutdown for the boot before, `clean` when it did not (an
agent too old to report one looks clean), and `unknown` for the oldest retained
boot, which is where observation began and is therefore not counted as a
restart. The node page shows the panel with uptime and clean versus unclean.

## What was not exercised

The Linux collectors were tested against fixture `/proc` and `/sys` trees and
fake `nvidia-smi`/`smartctl` output (`packages/fleet/tests/test_telemetry_hw.py`).
They were **not** exercised on real GPU, SMART or NVMe hardware, and the Nix
closure change (`smartmontools` on the agent's PATH, the extra `telemetry_hw.py`
copy) was not built here (no Nix on the development machine).
