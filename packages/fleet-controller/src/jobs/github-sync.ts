import { errorDetails } from '@pkgs/logger';

import { runGithubSync } from '../github/sync';

import type { JobDeps } from './offline-notifier';

/**
 * The scheduler's GitHub task: one level-triggered pass. It does nothing (and
 * calls nothing) without an operator-supplied key and a saved integration, and
 * it decides for itself whether it is due (interval, backoff, rate limits).
 */
export async function runGithubSyncJob(deps: JobDeps): Promise<void> {
  if (deps.github === undefined) return;
  try {
    const outcome = await runGithubSync(deps.github, deps.store);
    if (outcome.ran) {
      deps.log.info('github sync finished', {
        status: outcome.status,
        runners: outcome.runners,
        jobs: outcome.jobs,
        orphans: outcome.orphans,
        removed: outcome.removed,
        held: outcome.held,
        error: outcome.error,
      });
    }
  } catch (error) {
    deps.log.error('github sync failed', { error: errorDetails(error) });
  }
}
