# Automatic update recovery

Once a node is enrolled, routine system changes go through Git and CI. No SSH
command, reinstall or per-node approval is part of updating an existing node.
This applies after converting a Windows machine to its NixOS Fleet role too.

1. Merge the role configuration or code into `main`.
2. Each node builds the exact Git revision with upstream Nix substitutes and
   bounded local compilation (`--max-jobs 2 --cores 2`). No private cache
   service, publisher credentials or publication gate is required.
3. Each online node polls after its previous attempt finishes: normally 300
   seconds plus up to 30 seconds of jitter and one second of timer accuracy.
   Boot schedules an attempt after 15 seconds plus that jitter.
   Monotonic boot/retry timers do not use `Persistent`: its saved timestamp
   can suppress the first post-reboot attempt with the pinned systemd version.
4. An offline node keeps its existing generation. On reconnect or reboot, the
   same timer retries and selects current `main`, skipping missed intermediate
   commits. Failed builds retry without an additional commit or node action.
5. Activation must preserve an active update service and a timer enabled for
   subsequent boots. A failed health check restores the previous generation.

Kernel changes still use the configured reboot staggering and CI job drain.
That can delay a reboot by up to two hours before draining, and the drain itself
has a separate two-hour default bound. Other changes activate in place.

## Recovery boundaries

Only one updater can write the Git checkout or system profile at a time. Its
lock is inherited by child processes and released when those processes exit.
Once no writer exists, Git lock files left by interrupted updates are removed
from the private checkout automatically.

The previous generation stays GC-rooted while a candidate is unverified. If
power loss leaves the system profile on that candidate, the next attempt keeps
the saved rollback target instead of mistaking the candidate for a known-good
previous generation. The pending candidate is recorded before profile selection,
so this also works when another release arrives during the interruption.

Fetch, local building, profile selection, activation, rollback and runner recovery
are bounded (local builds default to one hour). Commands that ignore termination are killed after a grace period.
Activation and rollback default to five minutes each, followed by a 30-second
kill grace. A stuck candidate cannot hold the timer indefinitely. Failed
attempts retain diagnostics and do not advance `last-success`.

The updater is not restarted midway through its own NixOS activation. The next
timer invocation uses the newly installed unit and script. The Fleet API can
be unavailable without blocking Git-based updates; an explicit `sync.paused`
setting still pauses updates until the operator clears it.

## Required evidence

- `tests/test_sync_recovery.py` runs the real pull script against a temporary Git
  repository and controlled dependency failures. It covers missed commits,
  temporary build failures, inactive/disabled timers, stale Git locks and
  competing writers and interruption after profile selection, with
  previous-generation and success-marker assertions.
- `checks.update-units` verifies every deployable role and capability variant
  retains the boot timer, repeated scheduling and uninterrupted updater service,
  without a persistent timestamp that could strand the timer after reboot.
- `checks.follow-up` runs a NixOS VM with a real systemd timer, Git checkout,
  system profile and command timeouts. It exercises slow updates, offline
  reboot, multiple missed releases, temporary build failures, timer-breaking
  activation, hung activation, rollback, and two real NixOS generation switches
  that change the updater's own unit. Updates are driven by the timer throughout.
- The lifecycle and boot-health tests retain coverage for drain/resume,
  reboot failure, health rollback, generation retention and counted boot fallback.

The follow-up VM returns controlled fixture closures for local build commands.
It checks update control flow, rather than proving actual compilation. Upstream
substitute signatures remain checked by Nix; local outputs follow the pinned
Git source and derivations. VM evidence also does not
prove a particular physical machine's firmware or recovery from hardware faults.
Qualify the first physical node by merging a harmless configuration change,
observing its reported revision advance, then repeating after an offline reboot
and confirming a real CI job succeeds.

## Retiring the former cache

Existing nodes with the old substitution-only updater must receive the local-build
updater before the private cache is removed, or be reinstalled with the new
verified offline ISO. Do not change a node by hand. Inspect active node revisions
through Fleet before applying the retirement plan. The former service and
publisher workflow are retained as dormant source for migration reference only.
