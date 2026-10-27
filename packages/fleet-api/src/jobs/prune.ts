import type { JobDeps } from './offline-notifier';

export const HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Deletes heartbeat history older than seven days. Events and settings history stay. */
export async function runPrune(deps: JobDeps): Promise<number> {
  const before = new Date(deps.now().getTime() - HEARTBEAT_RETENTION_MS);
  const removed = await deps.store.pruneHeartbeats(before);
  if (removed > 0) deps.log.info('pruned heartbeat history', { removed });
  return removed;
}
