import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import {
  auth,
  bucketView,
  enabled,
  healthy,
  integrityOf,
  killAll,
  newPrefix,
  read,
  seedLegacyReplica,
  startInstance,
  stop,
  write,
  type Instance,
} from './support/ownership-drill';

/**
 * Old-generation retention and ownership monitoring with real Litestream
 * against disposable S3 storage (scripts/check-replication.py), skipped unless
 * the same environment as test/ownership-replication.test.ts is set.
 */
const DAY = 24 * 60 * 60 * 1000;
const owner = (prefix: string) => `${prefix}/fleet-owner.json`;

afterEach(killAll);

/** Generation directories and root objects present under the prefix. */
async function layout(prefix: string) {
  const keys = (await bucketView(prefix).list(`${prefix}/`)).map((o) =>
    o.key.slice(prefix.length + 1)
  );
  const generations = new Set(
    keys
      .map((k) => /^generations\/(\d+)\//.exec(k)?.[1])
      .filter((g): g is string => g !== undefined)
      .map(Number)
  );
  const legacy = keys.filter((k) => /^\d{4}\//.test(k));
  return { keys, generations: [...generations].sort((a, b) => a - b), legacy };
}

async function eventually<T>(
  observe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await observe();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(500);
    value = await observe();
  }
  return value;
}

/** A new instance joins; once it serves, the previous one stops cleanly. */
async function rollTo(previous: Instance, prefix: string, extra = {}) {
  const next = await startInstance(prefix, extra);
  await healthy(next, 90_000);
  expect(await stop(previous)).toBe(0);
  return next;
}

async function freshState(prefix: string, expected: number, marker: number) {
  const fresh = await startInstance(prefix);
  await healthy(fresh, 90_000);
  expect(await read(fresh)).toBe(expected);
  expect(await stop(fresh)).toBe(0);
  expect(integrityOf(fresh.directory)).toEqual({ integrity_check: 'ok' });
  const db = new Database(join(fresh.directory, 'fleet.db'), {
    readonly: true,
  });
  try {
    expect(db.query('select v from legacy').all()).toEqual([{ v: marker }]);
  } finally {
    db.close();
  }
}

describe.skipIf(!enabled)('old-generation retention (real Litestream)', () => {
  test('the owner prunes old generations, keeps the recent ones, and a fresh restore still works', async () => {
    const prefix = newPrefix();
    seedLegacyReplica(prefix, 4242);
    expect((await layout(prefix)).legacy.length).toBeGreaterThan(0);
    // The supervisor's clock runs eight days ahead: everything written now counts as old.
    const aged = {
      clockSkewMs: 8 * DAY,
      env: {
        FLEET_OWNERSHIP_RETAIN_DAYS: '1',
        FLEET_OWNERSHIP_RETAIN_GENERATIONS: '1',
      },
    };
    let current = await startInstance(prefix, aged);
    await healthy(current, 90_000);
    expect(await write(current, 41)).toBe(200);
    const instances = [current];
    for (const value of [42, 43, 44]) {
      current = await rollTo(current, prefix, aged);
      instances.push(current);
      expect(await write(current, value)).toBe(200);
    }
    // Generation 4 is current; keeping one previous generation leaves 3 and 4.
    const settled = await eventually(
      () => layout(prefix),
      (l) => l.generations.join() === '3,4' && l.legacy.length === 0
    );
    expect(settled.generations).toEqual([3, 4]);
    expect(settled.legacy).toEqual([]);
    expect(settled.keys).toContain('fleet-owner.json');
    const record = JSON.parse(
      (await bucketView(prefix).get(owner(prefix)))!.body
    ) as { generation: number; replica: number };
    expect(record).toMatchObject({ generation: 4, replica: 4 });
    const output = instances.map((i) => i.output()).join('\n');
    expect(output).toContain('deleted an old replica generation');
    expect(output).not.toContain('retention.delete_failed');
    expect(output).not.toContain('retention.sweep_failed');
    expect(await stop(current)).toBe(0);
    // The pre-ownership data travelled forward through the generations, not through generation 0.
    await freshState(prefix, 44, 4242);
  }, 240_000);

  test('nothing is pruned while the data is young, whatever the generation count', async () => {
    const prefix = newPrefix();
    seedLegacyReplica(prefix, 7);
    const young = {
      env: {
        FLEET_OWNERSHIP_RETAIN_DAYS: '7',
        FLEET_OWNERSHIP_RETAIN_GENERATIONS: '1',
      },
    };
    let current = await startInstance(prefix, young);
    await healthy(current, 90_000);
    expect(await write(current, 21)).toBe(200);
    for (const value of [22, 23]) {
      current = await rollTo(current, prefix, young);
      expect(await write(current, value)).toBe(200);
    }
    await Bun.sleep(8_000); // Several sweeps' worth.
    const state = await layout(prefix);
    expect(state.generations).toEqual([1, 2, 3]);
    expect(state.legacy.length).toBeGreaterThan(0);
    expect(await stop(current)).toBe(0);
    await freshState(prefix, 23, 7);
  }, 240_000);
});

describe.skipIf(!enabled)('ownership monitoring (real Litestream)', () => {
  test('reports ownership, generation, holder and replica lag over the API and /metrics', async () => {
    const prefix = newPrefix();
    const a = await startInstance(prefix);
    await healthy(a, 90_000);
    expect(await write(a, 31)).toBe(200);
    const view = async () =>
      (
        await fetch(`${a.base}/v1/ownership`, { headers: auth })
      ).json() as Promise<Record<string, unknown>>;
    const first = await view();
    expect(first).toMatchObject({
      supervised: true,
      state: 'held',
      held: true,
      generation: 1,
      replicaGeneration: 1,
    });
    expect(typeof first['holder']).toBe('string');
    expect(first['renewalAgeSeconds'] as number).toBeLessThan(5);
    const firstSync = first['replicaLastSyncAgeSeconds'] as number;
    expect(firstSync).not.toBeNull();

    // The monitor compares Litestream's position with the replica: the age keeps resetting while idle.
    const lagged = await eventually(
      view,
      (v) =>
        (v['replicaLastSyncAgeSeconds'] as number) < firstSync - 3 ||
        (v['replicaLastSyncAgeSeconds'] as number) < 3,
      30_000
    );
    expect(lagged['replicaLastSyncAgeSeconds'] as number).toBeLessThan(15);
    await Bun.sleep(12_000);
    expect((await view())['replicaLastSyncAgeSeconds'] as number).toBeLessThan(
      15
    );
    expect(await write(a, 32)).toBe(200);
    await Bun.sleep(12_000);
    expect((await view())['replicaLastSyncAgeSeconds'] as number).toBeLessThan(
      15
    );

    const metrics = await (
      await fetch(`${a.base}/metrics`, { headers: auth })
    ).text();
    expect(metrics).toContain('fleet_ownership_held 1');
    expect(metrics).toContain('fleet_ownership_generation 1');
    expect(metrics).toMatch(
      /^fleet_ownership_renewal_age_seconds \d+(\.\d+)?$/m
    );
    expect(metrics).toMatch(
      /^fleet_replica_last_sync_age_seconds \d+(\.\d+)?$/m
    );
    const output = a.output();
    expect(output).toContain('acquired writer ownership');
    expect(output).not.toContain('replica.sync_check_failed');
    expect((await fetch(`${a.base}/health`)).status).toBe(200);
    expect(await (await fetch(`${a.base}/health`)).json()).toEqual({
      ok: true,
    });
    expect(await stop(a)).toBe(0);
  }, 240_000);
});
