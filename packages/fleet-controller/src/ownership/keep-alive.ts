import type { OwnershipContext } from './acquire';
import type { Lease, LeaseState } from './lease';
import { openGateUntil } from './write-gate';

export interface KeepAlive {
  /** Resolves once the lease leaves the held state (hand-over requested or lost). */
  readonly changed: Promise<LeaseState>;
  /** Closes the write gate for good: draining, stopping or fenced. */
  closeGate(): void;
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
  gatePath: string
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
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      wake?.();
    },
  };
}
