import { errorDetails } from '@pkgs/logger';
import type { JobDeps } from './offline-notifier';
import { runOfflineSweep } from './offline-notifier';
import { runGithubSyncJob } from './github-sync';
import { runIssueSyncJob } from './issue-sync';
import { runPrune } from './prune';
import { sweepOperations } from '../operations/reconcile';

export interface JobTimings {
  readonly sweepEveryMs: number;
  readonly pruneEveryMs: number;
  /** How often the GitHub sync is considered; it decides itself whether it is due. */
  readonly githubSyncEveryMs?: number;
  /** How often queued issue reports are retried when due. */
  readonly issueSyncEveryMs?: number;
  /**
   * No offline notice before this long after boot. After a controller outage every
   * node looks silent until it has had time to report again.
   */
  readonly graceMs: number;
}

export const DEFAULT_TIMINGS: JobTimings = {
  sweepEveryMs: 30_000,
  pruneEveryMs: 60 * 60 * 1000,
  graceMs: 120_000,
};

const GITHUB_SYNC_EVERY_MS = 15_000;
const ISSUE_SYNC_EVERY_MS = 15_000;

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
  // Operations on a silent node still time out: reconcile every active one.
  const operations = guarded(deps, 'operations', async () => {
    if (deps.now().getTime() >= graceEnds) await sweepOperations(deps);
  });
  const timers = [
    setInterval(sweep, timings.sweepEveryMs),
    setInterval(operations, timings.sweepEveryMs),
    setInterval(prune, timings.pruneEveryMs),
  ];
  if (deps.github !== undefined) {
    const sync = guarded(deps, 'github-sync', () => runGithubSyncJob(deps));
    timers.push(
      setInterval(sync, timings.githubSyncEveryMs ?? GITHUB_SYNC_EVERY_MS)
    );
    sync();
  }
  if (deps.issues !== undefined) {
    const issues = guarded(deps, 'issue-sync', () => runIssueSyncJob(deps));
    timers.push(
      setInterval(issues, timings.issueSyncEveryMs ?? ISSUE_SYNC_EVERY_MS)
    );
  }
  prune();
  return {
    stop: () => {
      for (const timer of timers) clearInterval(timer);
    },
  };
}
