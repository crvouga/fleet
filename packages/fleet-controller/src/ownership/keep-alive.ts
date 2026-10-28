import { errorDetails } from '@pkgs/logger';

import type { OwnershipContext } from './acquire';
import type { Lease, LeaseState } from './lease';
import { writeOwnershipStatus } from './status';
import { openGateUntil } from './write-gate';

/** Where the supervisor publishes ownership for the worker's monitoring endpoints. */
export interface StatusSink {
  readonly path: string;
  /** Wall time when the replica last held everything committed; null before the first sync. */
  readonly lastSyncAt: () => number | null;
}

export interface KeepAlive {
  /** Resolves once the lease leaves the held state (hand-over requested or lost). */
  readonly changed: Promise<LeaseState>;
  /** Closes the write gate for good: draining, stopping or fenced. */
  closeGate(): void;
  /** Rewrites the status file now, e.g. after the replica sync time changed. */
  refresh(): void;
  stop(): void;
}

/**
 * Renews from the moment of the claim (restore and initial sync included) and
 * keeps renewing while the worker drains, so a waiting instance never sees an
 * expired holder that is still flushing its final writes.
 */
export function keepAlive(
  lease: Lease,
  ctx: OwnershipContext,
  gatePath: string,
  status?: StatusSink
): KeepAlive {
  let stopped = false;
  let closed = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let report: (state: LeaseState) => void = () => {};
  const changed = new Promise<LeaseState>((resolve) => (report = resolve));
  const publish = () => {
    const remaining = lease.writableUntil() - ctx.now();
    openGateUntil(gatePath, closed ? 0 : Date.now() + remaining);
    if (status) publishStatus(lease, ctx, status, closed);
  };
  publish();
  void (async () => {
    while (!stopped) {
      const state = await lease.renew();
      if (stopped) return;
      if (state !== 'held') closed = true;
      publish();
      if (state !== 'held') report(state);
      if (state === 'lost') return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ctx.timing.renewMs);
      });
    }
  })();
  return {
    changed,
    closeGate: () => {
      closed = true;
      publish();
    },
    refresh: publish,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      wake?.();
    },
  };
}

/** A draining holder (gate closed) reports `handover`: still the owner, no longer accepting writes. */
function publishStatus(
  lease: Lease,
  ctx: OwnershipContext,
  status: StatusSink,
  closed: boolean
): void {
  const state = closed && lease.current === 'held' ? 'handover' : lease.current;
  try {
    writeOwnershipStatus(status.path, {
      state,
      generation: lease.claim.generation,
      holder: ctx.instance,
      renewedAtWall: Math.max(
        0,
        Math.floor(Date.now() - (ctx.now() - lease.lastRenewedAt))
      ),
      lastSyncAtWall: status.lastSyncAt(),
      replicaGeneration: lease.replicaGeneration,
    });
  } catch (error) {
    // Monitoring must never disturb ownership renewal.
    ctx.log.warn('could not publish ownership status', {
      error: errorDetails(error),
    });
  }
}
