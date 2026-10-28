import { errorDetails } from '@pkgs/logger';

import type { OwnershipContext } from './acquire';
import type { Lease } from './lease';
import type { ListedObject } from './object-store';
import { ownerKey, parseOwner, OWNER_FILE, type OwnerRecord } from './record';
import type { RetentionPolicy } from './retention-policy';

/** Delete requests between two ownership checks, and per renewal interval. */
export const DELETE_BATCH = 20;
/** A full listing and plan once an hour; a failed sweep retries sooner. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const FAILED_SWEEP_RETRY_MS = 5 * 60 * 1000;

export interface RetentionDeps {
  readonly ctx: OwnershipContext;
  readonly lease: Lease;
  readonly policy: RetentionPolicy;
  /** Epoch ms, comparable with the storage server's LastModified. */
  readonly wall: () => number;
  /** Resolves after ms; the real one must not keep the process alive. */
  readonly sleep: (ms: number) => Promise<void>;
}

export interface RetentionStep {
  readonly generation: number;
  readonly key: string;
}

/** `generations/<n>/...` written by this version; anything else there is not ours. */
const NUMBERED = /^generations\/(0|[1-9]\d{0,8})\/./;
/**
 * Generation 0 is the replica Litestream 0.5 wrote directly under the prefix
 * before ownership existed: `<level>/<min txid>-<max txid>.ltx`. Only keys of
 * exactly this shape are ever deleted from it.
 */
const LEGACY_LTX = /^\d{4}\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/;

interface Inventory {
  readonly byGeneration: Map<number, { keys: string[]; newest: number }>;
  /** A key under the prefix root nobody recognises: generation 0 is then off limits. */
  readonly unknownRoot: boolean;
}

function inventory(
  prefix: string,
  objects: readonly ListedObject[]
): Inventory {
  const byGeneration = new Map<number, { keys: string[]; newest: number }>();
  let unknownRoot = false;
  const add = (generation: number, object: ListedObject) => {
    const entry = byGeneration.get(generation) ?? { keys: [], newest: 0 };
    entry.keys.push(object.key);
    entry.newest = Math.max(entry.newest, object.lastModified);
    byGeneration.set(generation, entry);
  };
  for (const object of objects) {
    const rest = object.key.slice(prefix.length + 1);
    const numbered = NUMBERED.exec(rest);
    if (numbered?.[1] !== undefined) add(Number(numbered[1]), object);
    else if (LEGACY_LTX.test(rest)) add(0, object);
    else if (
      rest !== OWNER_FILE &&
      !rest.startsWith('probes/') &&
      !rest.startsWith('generations/')
    )
      unknownRoot = true;
  }
  return { byGeneration, unknownRoot };
}

/**
 * What the owner of `current` may delete: generations strictly older than the
 * keep window AND untouched for the retention window, never the one the owner
 * record names as the authoritative replica, and generation 0 only while
 * nothing unrecognised sits next to it. Oldest first.
 */
export function planRetention(
  prefix: string,
  objects: readonly ListedObject[],
  record: OwnerRecord,
  policy: RetentionPolicy & { readonly now: number }
): RetentionStep[] {
  const { byGeneration, unknownRoot } = inventory(prefix, objects);
  const steps: RetentionStep[] = [];
  const ordered = [...byGeneration.entries()].sort(([a], [b]) => a - b);
  for (const [generation, found] of ordered) {
    if (generation >= record.generation - policy.keepGenerations) continue;
    if (generation === record.replica) continue;
    if (generation === 0 && unknownRoot) continue;
    if (policy.now - found.newest < policy.retainMs) continue;
    for (const key of found.keys) steps.push({ generation, key });
  }
  return steps;
}

/**
 * The owner record, only while this instance provably still owns the
 * generation it published as the authoritative replica; otherwise null and
 * nothing may be deleted.
 */
async function currentOwnerRecord(
  deps: RetentionDeps
): Promise<OwnerRecord | null> {
  const { ctx, lease } = deps;
  if (lease.current !== 'held' || ctx.now() >= lease.writableUntil())
    return null;
  const found = await ctx.store.get(ownerKey(ctx.prefix));
  if (found === null) return null;
  const record = parseOwner(found.body);
  const mine =
    record.holder === ctx.instance &&
    record.generation === lease.claim.generation &&
    record.handoverTo === null &&
    record.replica === lease.claim.generation;
  return mine ? record : null;
}

export type SweepOutcome = 'idle' | 'aborted' | 'failed';

/** Deletes one object; false (after logging) when storage refused. */
async function deleteOne(
  deps: RetentionDeps,
  step: RetentionStep
): Promise<boolean> {
  const { ctx } = deps;
  try {
    await ctx.store.remove(step.key);
    return true;
  } catch (error) {
    ctx.log.warn('could not delete an old replica generation; retrying later', {
      event: 'retention.delete_failed',
      generation: step.generation,
      holder: ctx.instance,
      error: errorDetails(error),
    });
    return false;
  }
}

function countByGeneration(
  steps: readonly RetentionStep[]
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const step of steps)
    counts.set(step.generation, (counts.get(step.generation) ?? 0) + 1);
  return counts;
}

/** Deletes one batch; the outcome is set when the sweep must stop. */
async function deleteBatch(
  deps: RetentionDeps,
  batch: readonly RetentionStep[],
  remaining: Map<number, number>
): Promise<SweepOutcome | null> {
  for (const step of batch) {
    if (deps.lease.current !== 'held') return 'aborted';
    if (!(await deleteOne(deps, step))) return 'failed';
    const left = (remaining.get(step.generation) ?? 1) - 1;
    remaining.set(step.generation, left);
    if (left === 0)
      deps.ctx.log.info('deleted an old replica generation', {
        event: 'retention.deleted_generation',
        generation: step.generation,
        holder: deps.ctx.instance,
      });
  }
  return null;
}

/** At most DELETE_BATCH deletes per renewal interval, ownership re-proven before each batch. */
async function deleteBatches(
  deps: RetentionDeps,
  steps: readonly RetentionStep[],
  stopped: () => boolean
): Promise<SweepOutcome> {
  const remaining = countByGeneration(steps);
  for (let at = 0; at < steps.length; at += DELETE_BATCH) {
    if (stopped() || (await currentOwnerRecord(deps)) === null)
      return 'aborted';
    const batch = steps.slice(at, at + DELETE_BATCH);
    const stop = await deleteBatch(deps, batch, remaining);
    if (stop !== null) return stop;
    if (at + DELETE_BATCH < steps.length)
      await deps.sleep(deps.ctx.timing.renewMs);
  }
  return 'idle';
}

/** One listing, one plan, bounded batches. Never throws: cleanup never affects serving. */
export async function sweep(
  deps: RetentionDeps,
  stopped: () => boolean = () => false
): Promise<SweepOutcome> {
  const { ctx, policy } = deps;
  try {
    const record = await currentOwnerRecord(deps);
    if (record === null) return 'aborted';
    const objects = await ctx.store.list(`${ctx.prefix}/`);
    const steps = planRetention(ctx.prefix, objects, record, {
      ...policy,
      now: deps.wall(),
    });
    return await deleteBatches(deps, steps, stopped);
  } catch (error) {
    ctx.log.warn('old replica generation cleanup failed; retrying later', {
      event: 'retention.sweep_failed',
      holder: ctx.instance,
      error: errorDetails(error),
    });
    return 'failed';
  }
}

export interface Retention {
  stop(): void;
}

/**
 * Cleans up in the background for as long as this lease holds ownership of a
 * published replica: first soon after the publication, then hourly. Call only
 * after `lease.confirmReplica()` succeeded.
 */
export function startRetention(deps: RetentionDeps): Retention {
  let stopped = false;
  let wake: () => void = () => {};
  const woken = new Promise<void>((resolve) => (wake = resolve));
  const pause = (ms: number) => Promise.race([deps.sleep(ms), woken]);
  void (async () => {
    await pause(deps.ctx.timing.renewMs * 2);
    while (!stopped) {
      const outcome = await sweep(deps, () => stopped);
      if (outcome === 'aborted') return;
      await pause(
        outcome === 'failed' ? FAILED_SWEEP_RETRY_MS : SWEEP_INTERVAL_MS
      );
    }
  })();
  return {
    stop: () => {
      stopped = true;
      wake();
    },
  };
}
