import { errorDetails } from '@pkgs/logger';
import type { JobDeps } from './offline-notifier';
import { runOfflineSweep } from './offline-notifier';
import { runPrune } from './prune';

export interface JobTimings {
  readonly sweepEveryMs: number;
  readonly pruneEveryMs: number;
  /**
   * No offline notice before this long after boot. After an API outage every
   * node looks silent until it has had time to report again.
   */
  readonly graceMs: number;
}

export const DEFAULT_TIMINGS: JobTimings = {
  sweepEveryMs: 30_000,
  pruneEveryMs: 60 * 60 * 1000,
  graceMs: 120_000,
};

export interface RunningJobs {
  stop(): void;
}

function guarded(
  deps: JobDeps,
  name: string,
  task: () => Promise<unknown>
): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    task()
      .catch((err: unknown) => {
        deps.log.error('background job failed', {
          job: name,
          error: errorDetails(err),
        });
      })
      .finally(() => {
        running = false;
      });
  };
}

/** Starts the offline notifier and the hourly prune. Never throws; failures are logged. */
export function startJobs(
  deps: JobDeps,
  timings: JobTimings = DEFAULT_TIMINGS
): RunningJobs {
  const graceEnds = deps.now().getTime() + timings.graceMs;
  const sweep = guarded(deps, 'offline-notifier', async () => {
    if (deps.now().getTime() < graceEnds) return;
    await runOfflineSweep(deps);
  });
  const prune = guarded(deps, 'prune', () => runPrune(deps));
  const timers = [
    setInterval(sweep, timings.sweepEveryMs),
    setInterval(prune, timings.pruneEveryMs),
  ];
  prune();
  return {
    stop: () => {
      for (const timer of timers) clearInterval(timer);
    },
  };
}
