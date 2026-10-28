import { errorDetails, type Logger } from '@pkgs/logger';

import type { ListedObject } from './object-store';

/** How often the monitor compares the database with its replica. */
export const SYNC_POLL_MS = 10_000;
const METRICS_TIMEOUT_MS = 2_000;
const FAILURES_BEFORE_WARNING = 3;

/** A free loopback TCP port for Litestream's metrics endpoint (it only logs if the bind later fails). */
export function freeLoopbackPort(): number {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => {} },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** The database's committed transaction id, from Litestream's Prometheus text. */
export function parseLocalTxid(metrics: string): number | null {
  const found = /^litestream_txid(?:\{[^}]*\})?\s+(\S+)\s*$/m.exec(metrics);
  const value = found?.[1] === undefined ? Number.NaN : Number(found[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `<level>/<min txid>-<max txid>.ltx`: the highest max txid among the replica's objects. */
export function newestReplicaTxid(
  objects: readonly ListedObject[]
): number | null {
  let newest: number | null = null;
  for (const { key } of objects) {
    const found = /\/\d{4}\/[0-9a-f]{16}-([0-9a-f]{16})\.ltx$/.exec(key);
    if (found?.[1] === undefined) continue;
    const txid = Number.parseInt(found[1], 16);
    if (newest === null || txid > newest) newest = txid;
  }
  return newest;
}

export interface SyncMonitorDeps {
  /** Litestream's `http://127.0.0.1:<port>/metrics`. */
  readonly metricsUrl: string;
  /** The objects of the generation being replicated. */
  readonly list: () => Promise<ListedObject[]>;
  readonly wall: () => number;
  /** The replica last held everything the database had committed (or advanced), at this wall time. */
  readonly onSynced: (atWall: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
  /** Poll interval; defaults to SYNC_POLL_MS. */
  readonly pollMs?: number;
}

interface Progress {
  replicaTxid: number | null;
}

/**
 * One comparison. The replica is in sync when its newest transaction is at
 * least the database's, and also whenever it advanced since the last look
 * (a busy database is never idle, only possibly behind). An idle database is
 * therefore always in sync: the age measured from this stays near zero, and
 * grows only while committed transactions are not reaching object storage.
 */
export async function pollSyncOnce(
  deps: SyncMonitorDeps,
  progress: Progress
): Promise<void> {
  const response = await fetch(deps.metricsUrl, {
    signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
  });
  const local = parseLocalTxid(await response.text());
  if (!response.ok || local === null)
    throw new Error('Litestream metrics did not report a transaction id');
  const replica = newestReplicaTxid(await deps.list());
  if (replica === null) return;
  const advanced =
    progress.replicaTxid !== null && replica > progress.replicaTxid;
  progress.replicaTxid = replica;
  if (replica >= local || advanced) deps.onSynced(deps.wall());
}

export interface SyncMonitor {
  stop(): void;
}

/** Polls until stopped. Failures only leave the sync age growing: they are logged, never raised. */
export function startSyncMonitor(deps: SyncMonitorDeps): SyncMonitor {
  let stopped = false;
  let wake: () => void = () => {};
  const woken = new Promise<void>((resolve) => (wake = resolve));
  const progress: Progress = { replicaTxid: null };
  let consecutiveFailures = 0;
  void (async () => {
    while (!stopped) {
      try {
        await pollSyncOnce(deps, progress);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        // Litestream needs a moment to start serving; warn once per outage, not per poll.
        if (consecutiveFailures === FAILURES_BEFORE_WARNING)
          deps.log.warn('could not check replica synchronisation', {
            event: 'replica.sync_check_failed',
            error: errorDetails(error),
          });
      }
      await Promise.race([deps.sleep(deps.pollMs ?? SYNC_POLL_MS), woken]);
    }
  })();
  return {
    stop: () => {
      stopped = true;
      wake();
    },
  };
}
