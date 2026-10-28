import { describe, expect, test } from 'bun:test';

import type { Claim } from '../../src/ownership/acquire';
import { Lease } from '../../src/ownership/lease';
import { ObjectStoreError } from '../../src/ownership/object-store';
import {
  ownerKey,
  parseOwner,
  serializeOwner,
  type OwnerRecord,
} from '../../src/ownership/record';
import {
  DELETE_BATCH,
  SWEEP_INTERVAL_MS,
  planRetention,
  startRetention,
  sweep,
} from '../../src/ownership/retention';
import {
  DEFAULT_RETENTION,
  readRetentionPolicy,
} from '../../src/ownership/retention-policy';
import { recordingLogger } from '../support/recording-logger';
import { MemoryStore, PREFIX, VirtualClock, contextFor } from './support';

const DAY = 24 * 60 * 60 * 1000;
const hex = (n: number) => n.toString(16).padStart(16, '0');
const ltx = (n: number) => `0000/${hex(n)}-${hex(n)}.ltx`;
const generationKey = (generation: number, n: number) =>
  `${PREFIX}/generations/${generation}/${ltx(n)}`;
const instantly = async () => {};
const legacyKey = (n: number) => `${PREFIX}/${ltx(n)}`;

/** Instance `a` owns `generation` with its replica published, as after confirmReplica. */
async function setup(generation = 10) {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const log = recordingLogger();
  const ctx = { ...contextFor('a', store, clock), log };
  const record: OwnerRecord = {
    version: 1,
    generation,
    holder: 'a',
    handoverTo: null,
    beat: 0,
    replica: generation - 1,
  };
  const written = await store.put(ownerKey(PREFIX), serializeOwner(record), {
    ifNoneMatch: '*',
  });
  if (!written.ok) throw new Error('seed failed');
  const claim: Claim = {
    generation,
    restoreFrom: generation - 1,
    etag: written.etag,
    since: clock.now(),
  };
  const lease = new Lease(ctx, claim);
  expect(await lease.confirmReplica()).toBe(true);
  const deps = {
    ctx,
    lease,
    policy: DEFAULT_RETENTION,
    wall: () => Date.now(),
    sleep: clock.sleep,
  };
  /** Fills generations with `objects` objects each, `ageDays` old. */
  const seed = (generations: number[], ageDays: number, objects = 2) => {
    for (const g of generations)
      for (let n = 1; n <= objects; n += 1)
        store.seed(generationKey(g, n), ageDays * DAY);
  };
  const generationsLeft = () =>
    [
      ...new Set(
        [...store.objects.keys()]
          .map((k) => /\/generations\/(\d+)\//.exec(k)?.[1])
          .filter((g): g is string => g !== undefined)
          .map(Number)
      ),
    ].sort((x, y) => x - y);
  /** Lets virtual time pass in renewal-sized steps, renewing as the keep-alive loop would. */
  const run = async (ms: number) => {
    for (let left = ms; left > 0; left -= 5_000) {
      await clock.advance(Math.min(5_000, left));
      await lease.renew();
    }
  };
  return { store, clock, ctx, lease, deps, log, seed, generationsLeft, run };
}

describe('old-generation retention', () => {
  test('deletes only generations older than the keep count and the window', async () => {
    const t = await setup(10);
    t.seed([1, 2, 3, 4, 6, 7], 8);
    t.seed([5], 1); // Inside the window: protected although far behind.
    t.seed([8, 9], 30); // The previous two generations: protected although old.
    t.seed([10], 30); // The current generation.
    t.store.seed(`${PREFIX}/probes/x.json`, 90 * DAY);
    expect(await sweep(t.deps)).toBe('idle');
    expect(t.generationsLeft()).toEqual([5, 8, 9, 10]);
    expect(t.store.objects.has(ownerKey(PREFIX))).toBe(true);
    expect(t.store.objects.has(`${PREFIX}/probes/x.json`)).toBe(true);
  });

  test('one fresh object protects its whole generation', async () => {
    const t = await setup(10);
    t.seed([2], 30);
    t.store.seed(generationKey(2, 99), 1 * DAY);
    await sweep(t.deps);
    expect(t.generationsLeft()).toEqual([2]);
    expect(t.store.objects.size).toBeGreaterThan(3);
  });

  test('the window and keep count come from the policy', async () => {
    const t = await setup(10);
    t.seed([1, 2, 3, 4, 5, 6, 7], 2);
    const policy = { keepGenerations: 5, retainMs: 1 * DAY };
    await sweep({ ...t.deps, policy });
    expect(t.generationsLeft()).toEqual([5, 6, 7]);
  });

  test('never deletes the generation the owner record names as the replica', () => {
    const record: OwnerRecord = {
      version: 1,
      generation: 10,
      holder: 'a',
      handoverTo: null,
      beat: 1,
      replica: 3,
    };
    const objects = [1, 3, 4].map((g) => ({
      key: generationKey(g, 1),
      lastModified: Date.now() - 40 * DAY,
    }));
    const steps = planRetention(PREFIX, objects, record, {
      ...DEFAULT_RETENTION,
      now: Date.now(),
    });
    expect(steps.map((s) => s.generation)).toEqual([1, 4]);
  });

  test('deletes nothing unless the owner published this generation as the replica', async () => {
    const t = await setup(10);
    t.seed([1, 2], 30);
    const found = (await t.store.get(ownerKey(PREFIX)))!;
    // Another reader sees the record where `replica` still names an older generation.
    await t.store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...parseOwner(found.body), replica: 4 }),
      { ifMatch: found.etag }
    );
    expect(await sweep(t.deps)).toBe('aborted');
    expect(t.store.removed).toEqual([]);
  });

  test('nothing is deleted while a hand-over is requested or after ownership moved', async () => {
    const t = await setup(10);
    t.seed([1, 2], 30);
    const found = (await t.store.get(ownerKey(PREFIX)))!;
    const record = parseOwner(found.body);
    const next = await t.store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...record, handoverTo: 'b' }),
      { ifMatch: found.etag }
    );
    expect(await sweep(t.deps)).toBe('aborted');
    if (!next.ok) throw new Error('unexpected');
    await t.store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...record, holder: 'b', generation: 11, replica: 11 }),
      { ifMatch: next.etag }
    );
    expect(await sweep(t.deps)).toBe('aborted');
    expect(t.store.removed).toEqual([]);
  });

  test('a lease lost mid-sweep stops the deletes at once', async () => {
    const t = await setup(10);
    t.seed([1, 2, 3], 30, 30);
    let deleted = 0;
    t.store.onRemove = async () => {
      deleted += 1;
      if (deleted !== 3) return;
      // Another instance takes over; the next renewal notices and fences.
      const found = (await t.store.get(ownerKey(PREFIX)))!;
      await t.store.put(
        ownerKey(PREFIX),
        serializeOwner({
          ...parseOwner(found.body),
          holder: 'b',
          generation: 11,
          replica: 10,
        }),
        { ifMatch: found.etag }
      );
      expect(await t.lease.renew()).toBe('lost');
    };
    expect(await sweep(t.deps)).toBe('aborted');
    expect(t.store.removed).toHaveLength(3);
  });

  test('ownership is re-proven before every batch', async () => {
    const t = await setup(10);
    t.seed([1, 2, 3], 30, 30); // 90 objects: five batches.
    let reads = 0;
    const get = t.store.get.bind(t.store);
    t.store.get = async (key) => {
      if (key === ownerKey(PREFIX)) reads += 1;
      return get(key);
    };
    expect(await sweep({ ...t.deps, sleep: instantly })).toBe('idle');
    // One read to plan plus one before each batch.
    expect(reads).toBe(1 + Math.ceil(90 / DELETE_BATCH));
  });

  test('a failing delete stops the sweep, is logged without secrets, and the next run finishes', async () => {
    const t = await setup(10);
    t.seed([1, 2], 30, 5);
    t.store.onRemove = (key) => {
      if (key === generationKey(1, 3))
        throw new ObjectStoreError('delete', 500);
    };
    expect(await sweep(t.deps)).toBe('failed');
    expect(t.store.removed).toHaveLength(2);
    const warn = t.log.lines.map(
      (l) => JSON.parse(l) as Record<string, unknown>
    );
    expect(
      warn.find((l) => l['event'] === 'retention.delete_failed')
    ).toMatchObject({
      level: 'warn',
      generation: 1,
    });
    t.store.onRemove = () => {};
    expect(await sweep(t.deps)).toBe('idle');
    expect(t.generationsLeft()).toEqual([]);
    // Idempotent: nothing left to do, nothing deleted.
    const before = t.store.removed.length;
    expect(await sweep(t.deps)).toBe('idle');
    expect(t.store.removed).toHaveLength(before);
  });

  test('a listing outage is logged and serving is untouched', async () => {
    const t = await setup(10);
    t.seed([1], 30);
    t.store.list = async () => {
      throw new ObjectStoreError('list', 503);
    };
    expect(await sweep(t.deps)).toBe('failed');
    expect(t.log.lines.join('\n')).toContain('retention.sweep_failed');
    expect(t.generationsLeft()).toEqual([1]);
  });

  test('pagination: a listing over many pages is processed completely', async () => {
    const t = await setup(10);
    t.store.listPageSize = 7;
    t.seed([1, 2, 3], 30, 15);
    await sweep({ ...t.deps, sleep: instantly });
    expect(t.store.listRequests).toBeGreaterThan(1);
    expect(t.generationsLeft()).toEqual([]);
  });
});

describe('generation 0 (the replica written before ownership existed)', () => {
  test('is deleted only when old, far behind, and nothing unrecognised sits beside it', async () => {
    const t = await setup(10);
    for (const n of [1, 2]) t.store.seed(legacyKey(n), 30 * DAY);
    t.store.seed(`${PREFIX}/probes/p.json`, 30 * DAY);
    await sweep(t.deps);
    expect(
      [...t.store.objects.keys()].filter((k) => k === legacyKey(1))
    ).toEqual([]);
    expect(t.store.objects.has(ownerKey(PREFIX))).toBe(true);
    expect(t.store.objects.has(`${PREFIX}/probes/p.json`)).toBe(true);
  });

  test('is kept when any object under the root is not a known Litestream file', async () => {
    const t = await setup(10);
    t.store.seed(legacyKey(1), 30 * DAY);
    t.store.seed(`${PREFIX}/notes.txt`, 30 * DAY);
    t.store.seed(`${PREFIX}/0000/not-an-ltx-name`, 30 * DAY);
    await sweep(t.deps);
    expect(t.store.removed).toEqual([]);
  });

  test('is kept while inside the window, or while within the keep count', async () => {
    const young = await setup(10);
    young.store.seed(legacyKey(1), 1 * DAY);
    await sweep(young.deps);
    expect(young.store.removed).toEqual([]);
    const close = await setup(3); // With keep 3, generation 0 is not below 3 - 3.
    close.store.seed(legacyKey(1), 30 * DAY);
    await sweep({
      ...close.deps,
      policy: { keepGenerations: 3, retainMs: DAY },
    });
    expect(close.store.removed).toEqual([]);
  });

  test('numbered generations never touch the legacy layout', async () => {
    const t = await setup(10);
    t.store.seed(legacyKey(1), 1 * DAY);
    t.seed([1], 30);
    await sweep(t.deps);
    expect(t.store.objects.has(legacyKey(1))).toBe(true);
    expect(t.generationsLeft()).toEqual([]);
  });
});

describe('background schedule', () => {
  test('starts soon after publication, bounded per renewal interval, then hourly', async () => {
    const t = await setup(10);
    t.seed([1, 2, 3], 30, 30); // 90 objects
    const retention = startRetention(t.deps);
    await t.run(5_000);
    expect(t.store.removed).toHaveLength(0); // Not before two renewal intervals.
    await t.run(5_000);
    expect(t.store.removed).toHaveLength(DELETE_BATCH);
    await t.run(5_000);
    expect(t.store.removed).toHaveLength(2 * DELETE_BATCH);
    await t.run(50_000);
    expect(t.store.removed).toHaveLength(90);
    // Idle for an hour; then newly aged generations are cleaned up.
    t.seed([4], 30);
    const nextSweep = 10_000 + 4 * 5_000 + SWEEP_INTERVAL_MS;
    await t.run(nextSweep - 5_000 - t.clock.now());
    expect(t.generationsLeft()).toEqual([4]);
    await t.run(10_000);
    expect(t.generationsLeft()).toEqual([]);
    retention.stop();
    t.seed([5], 30);
    await t.run(SWEEP_INTERVAL_MS * 2);
    expect(t.generationsLeft()).toEqual([5]);
  });

  test('stops for good once ownership is gone', async () => {
    const t = await setup(10);
    t.seed([1], 30);
    startRetention(t.deps);
    const found = (await t.store.get(ownerKey(PREFIX)))!;
    await t.store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...parseOwner(found.body), holder: null }),
      { ifMatch: found.etag }
    );
    await t.run(60_000);
    expect(t.store.removed).toEqual([]);
    t.seed([2], 30);
    await t.run(SWEEP_INTERVAL_MS * 2);
    expect(t.store.removed).toEqual([]);
  });
});

describe('retention policy settings', () => {
  const read = (source: Record<string, string>) => {
    const problems: string[] = [];
    return { policy: readRetentionPolicy(source, problems), problems };
  };

  test('defaults to the previous two generations and seven days', () => {
    expect(read({}).policy).toEqual({
      keepGenerations: 2,
      retainMs: 7 * DAY,
    });
  });

  test('accepts the documented ranges', () => {
    expect(
      read({
        FLEET_OWNERSHIP_RETAIN_DAYS: '365',
        FLEET_OWNERSHIP_RETAIN_GENERATIONS: '20',
      }).policy
    ).toEqual({ keepGenerations: 20, retainMs: 365 * DAY });
    expect(read({ FLEET_OWNERSHIP_RETAIN_DAYS: '1' }).policy.retainMs).toBe(
      DAY
    );
  });

  test('refuses values outside the ranges, naming the variable', () => {
    for (const [key, value] of [
      ['FLEET_OWNERSHIP_RETAIN_DAYS', '0'],
      ['FLEET_OWNERSHIP_RETAIN_DAYS', '366'],
      ['FLEET_OWNERSHIP_RETAIN_DAYS', '1.5'],
      ['FLEET_OWNERSHIP_RETAIN_GENERATIONS', '0'],
      ['FLEET_OWNERSHIP_RETAIN_GENERATIONS', '21'],
      ['FLEET_OWNERSHIP_RETAIN_GENERATIONS', 'many'],
    ] as const) {
      const { problems } = read({ [key]: value });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(key);
    }
  });
});
