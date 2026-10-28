import type { JobDeps } from './offline-notifier';
import { DEFAULT_HEARTBEAT_RETENTION_MS, retentionMs } from './retention';

/** The default retention (30 days). Set FLEET_HEARTBEAT_RETENTION_DAYS to change it. */
export const HEARTBEAT_RETENTION_MS = DEFAULT_HEARTBEAT_RETENTION_MS;

/**
 * Deletes heartbeat history older than the configured retention. Events,
 * settings history and the audit log stay.
 */
export async function runPrune(deps: JobDeps): Promise<number> {
  const before = new Date(
    deps.now().getTime() - retentionMs(deps.heartbeatRetentionDays)
  );
  const removed = await deps.store.pruneHeartbeats(before);
  if (removed > 0) deps.log.info('pruned heartbeat history', { removed });
  return removed;
}
