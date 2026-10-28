import { errorDetails, type Logger } from '@pkgs/logger';

import type { ConditionalStore } from './object-store';
import {
  OwnerRecordError,
  ownerKey,
  parseOwner,
  serializeOwner,
  type OwnerRecord,
} from './record';

/** Defaults suit rolling deploys: hand-over within one renewal, takeover after a crash in 30 s. */
export interface OwnershipTiming {
  /** How often the holder renews and checks for a hand-over request. */
  readonly renewMs: number;
  /** A record unchanged this long (measured by the waiter) belongs to a dead holder. */
  readonly expireMs: number;
  /** A holder that could not renew this long stops accepting writes. Must be well below expireMs. */
  readonly fenceMs: number;
  /** How often a waiting instance re-reads the record. */
  readonly pollMs: number;
}

export const DEFAULT_TIMING: OwnershipTiming = {
  renewMs: 5_000,
  expireMs: 30_000,
  fenceMs: 20_000,
  pollMs: 2_000,
};

export interface OwnershipContext {
  readonly store: ConditionalStore;
  readonly prefix: string;
  /** Random per process; never reused. */
  readonly instance: string;
  readonly timing: OwnershipTiming;
  /** Monotonic milliseconds; never wall-clock time. */
  readonly now: () => number;
  /** Resolves after ms, or early once `stopped()` turns true. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly stopped: () => boolean;
  readonly log: Logger;
}

/** This instance owns `generation` and must first restore from `restoreFrom`. */
export interface Claim {
  readonly generation: number;
  readonly restoreFrom: number;
  readonly etag: string;
  /**
   * Monotonic time taken before the claiming request was sent: the latest
   * moment storage can have applied it, so fencing never starts late.
   */
  readonly since: number;
}

/**
 * request: a newly started instance asks the holder to hand over (rolling deploy).
 * standby: an instance that already handed over or was fenced only takes
 * released or expired ownership, so two instances never trade it back and forth.
 */
export type AcquireMode = 'request' | 'standby';

interface Watch {
  readonly etag: string;
  readonly since: number;
}

function claimed(
  instance: string,
  generation: number,
  replica: number
): OwnerRecord {
  return {
    version: 1,
    generation,
    holder: instance,
    handoverTo: null,
    beat: 0,
    replica,
  };
}

async function create(
  ctx: OwnershipContext,
  since: number
): Promise<Claim | null> {
  const written = await ctx.store.put(
    ownerKey(ctx.prefix),
    serializeOwner(claimed(ctx.instance, 1, 0)),
    { ifNoneMatch: '*' }
  );
  return written.ok
    ? { generation: 1, restoreFrom: 0, etag: written.etag, since }
    : null;
}

async function take(
  ctx: OwnershipContext,
  current: OwnerRecord,
  seen: { readonly etag: string; readonly since: number }
): Promise<Claim | null> {
  const generation = current.generation + 1;
  const written = await ctx.store.put(
    ownerKey(ctx.prefix),
    serializeOwner(claimed(ctx.instance, generation, current.replica)),
    { ifMatch: seen.etag }
  );
  return written.ok
    ? {
        generation,
        restoreFrom: current.replica,
        etag: written.etag,
        since: seen.since,
      }
    : null;
}

async function requestHandover(
  ctx: OwnershipContext,
  current: OwnerRecord,
  etag: string
): Promise<string | null> {
  const written = await ctx.store.put(
    ownerKey(ctx.prefix),
    serializeOwner({ ...current, handoverTo: ctx.instance }),
    { ifMatch: etag }
  );
  if (written.ok)
    ctx.log.info('asked the current writer to hand over', {
      generation: current.generation,
    });
  return written.ok ? written.etag : null;
}

interface Step {
  readonly claim: Claim | null;
  readonly watch: Watch | null;
}

const expired = (ctx: OwnershipContext, watch: Watch | null, etag: string) =>
  watch !== null &&
  watch.etag === etag &&
  ctx.now() - watch.since >= ctx.timing.expireMs;

/**
 * Released ownership is free, except that a release made for a hand-over is
 * reserved for the requester; others wait for it to expire unclaimed.
 */
const claimable = (ctx: OwnershipContext, current: OwnerRecord) =>
  current.holder === null &&
  (current.handoverTo === null || current.handoverTo === ctx.instance);

const resumed = (current: OwnerRecord, etag: string, since: number): Claim => ({
  generation: current.generation,
  restoreFrom: current.replica,
  etag,
  since,
});

/** One read-and-decide round. Lost conditional writes simply lead to another round. */
async function attempt(
  ctx: OwnershipContext,
  mode: AcquireMode,
  watch: Watch | null
): Promise<Step> {
  const since = ctx.now();
  const found = await ctx.store.get(ownerKey(ctx.prefix));
  if (found === null) return { claim: await create(ctx, since), watch: null };
  const current = parseOwner(found.body);
  if (current.holder === ctx.instance)
    // Our claiming write was applied but its response was lost.
    return { claim: resumed(current, found.etag, since), watch: null };
  if (claimable(ctx, current) || expired(ctx, watch, found.etag)) {
    if (current.holder !== null)
      ctx.log.warn('taking over from a writer that stopped renewing', {
        generation: current.generation,
      });
    const claim = await take(ctx, current, { etag: found.etag, since });
    return { claim, watch: null };
  }
  return waitFor(ctx, mode, current, { found: found.etag, watch });
}

/** Ownership is held (or reserved): ask for hand-over when allowed and keep watching. */
async function waitFor(
  ctx: OwnershipContext,
  mode: AcquireMode,
  current: OwnerRecord,
  seen: { readonly found: string; readonly watch: Watch | null }
): Promise<Step> {
  const next =
    seen.watch?.etag === seen.found
      ? seen.watch
      : { etag: seen.found, since: ctx.now() };
  const ask =
    mode === 'request' &&
    current.holder !== null &&
    current.handoverTo !== ctx.instance;
  if (!ask) return { claim: null, watch: next };
  const etag = await requestHandover(ctx, current, seen.found);
  return {
    claim: null,
    watch: etag === null ? next : { etag, since: ctx.now() },
  };
}

/**
 * A stopping instance takes back its hand-over request (or the release
 * reserved for it) so the holder or the next instance is not left waiting
 * for a requester that is gone. Best effort: expiry remains the fallback.
 */
async function withdraw(ctx: OwnershipContext): Promise<void> {
  try {
    const found = await ctx.store.get(ownerKey(ctx.prefix));
    if (found === null) return;
    const current = parseOwner(found.body);
    if (current.handoverTo !== ctx.instance) return;
    await ctx.store.put(
      ownerKey(ctx.prefix),
      serializeOwner({ ...current, handoverTo: null }),
      { ifMatch: found.etag }
    );
  } catch (error) {
    ctx.log.warn('could not withdraw the hand-over request', {
      error: errorDetails(error),
    });
  }
}

/** Waits for ownership; null when the process is told to stop first. */
export async function acquire(
  ctx: OwnershipContext,
  mode: AcquireMode
): Promise<Claim | null> {
  let watch: Watch | null = null;
  while (!ctx.stopped()) {
    try {
      const step = await attempt(ctx, mode, watch);
      if (step.claim !== null) return step.claim;
      watch = step.watch;
    } catch (error) {
      if (error instanceof OwnerRecordError) throw error;
      // Transient storage trouble never grants ownership; keep waiting.
      ctx.log.warn('could not read writer ownership; retrying', {
        error: errorDetails(error),
      });
    }
    await ctx.sleep(ctx.timing.pollMs);
  }
  await withdraw(ctx);
  return null;
}
