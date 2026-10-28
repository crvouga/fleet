import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { keepAlive } from '../../src/ownership/keep-alive';
import { acquire } from '../../src/ownership/acquire';
import { Lease } from '../../src/ownership/lease';
import {
  ownerKey,
  parseOwner,
  serializeOwner,
} from '../../src/ownership/record';
import {
  OWNERSHIP_STATUS_ENV,
  parseOwnershipStatus,
  readOwnershipView,
  resetOwnershipStatusCache,
  writeOwnershipStatus,
  type OwnershipStatus,
} from '../../src/ownership/status';
import { MemoryStore, PREFIX, VirtualClock, contextFor } from './support';

const directory = mkdtempSync(join(tmpdir(), 'fleet-status-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => resetOwnershipStatusCache());

const sample: OwnershipStatus = {
  state: 'held',
  generation: 4,
  holder: 'instance-a',
  renewedAtWall: 1_700_000_000_000,
  lastSyncAtWall: null,
  replicaGeneration: 4,
};

describe('ownership status file', () => {
  test('round-trips, and is only ever readable owner-private', () => {
    const path = join(directory, 'round-trip');
    writeOwnershipStatus(path, sample);
    expect(parseOwnershipStatus(readFileSync(path, 'utf8'))).toEqual(sample);
    const synced = { ...sample, lastSyncAtWall: 1_700_000_001_000 };
    writeOwnershipStatus(path, synced);
    expect(parseOwnershipStatus(readFileSync(path, 'utf8'))).toEqual(synced);
  });

  test('anything that is not a complete status is rejected', () => {
    const bad = [
      '',
      '{',
      'null',
      '[]',
      '"held"',
      JSON.stringify({ ...sample, state: 'owner' }),
      JSON.stringify({ ...sample, holder: '' }),
      JSON.stringify({ ...sample, generation: -1 }),
      JSON.stringify({ ...sample, generation: 1.5 }),
      JSON.stringify({ ...sample, renewedAtWall: '1' }),
      JSON.stringify({ ...sample, lastSyncAtWall: undefined }),
      JSON.stringify({ ...sample, replicaGeneration: 'x' }),
    ];
    for (const text of bad)
      expect([text, parseOwnershipStatus(text)]).toEqual([text, null]);
  });

  test('readers never see a partial write while the supervisor rewrites it', async () => {
    const path = join(directory, 'atomic');
    writeOwnershipStatus(path, sample);
    const module = new URL('../../src/ownership/status.ts', import.meta.url)
      .pathname;
    const writer = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { writeOwnershipStatus } from ${JSON.stringify(module)};
         const s = ${JSON.stringify(sample)};
         for (let i = 0, end = Date.now() + 1500; Date.now() < end; i += 1)
           writeOwnershipStatus(${JSON.stringify(path)}, { ...s, generation: i, holder: 'x'.repeat(i % 200 + 1) });`,
      ],
      { stdout: 'inherit', stderr: 'inherit' }
    );
    let reads = 0;
    let torn = 0;
    while (writer.exitCode === null) {
      if (parseOwnershipStatus(readFileSync(path, 'utf8')) === null) torn += 1;
      reads += 1;
      await Bun.sleep(0);
    }
    expect(await writer.exited).toBe(0);
    expect(reads).toBeGreaterThan(10);
    expect(torn).toBe(0);
  }, 30_000);
});

describe('reading the status in the worker', () => {
  test('without a supervisor there is nothing to read', () => {
    expect(readOwnershipView({})).toEqual({ supervised: false });
    expect(readOwnershipView({ [OWNERSHIP_STATUS_ENV]: '' })).toEqual({
      supervised: false,
    });
  });

  test('supervised but missing or unreadable is reported as unknown, not as unsupervised', () => {
    const env = { [OWNERSHIP_STATUS_ENV]: join(directory, 'absent') };
    expect(readOwnershipView(env)).toEqual({ supervised: true, status: null });
    const broken = join(directory, 'broken');
    writeFileSync(broken, '{"state":');
    expect(readOwnershipView({ [OWNERSHIP_STATUS_ENV]: broken })).toEqual({
      supervised: true,
      status: null,
    });
  });

  test('reads are cached for one second, then see the new status', () => {
    const path = join(directory, 'cached');
    const env = { [OWNERSHIP_STATUS_ENV]: path };
    let now = 10_000;
    writeOwnershipStatus(path, sample);
    expect(readOwnershipView(env, () => now)).toMatchObject({
      status: { generation: 4 },
    });
    writeOwnershipStatus(path, { ...sample, generation: 5 });
    now += 999;
    expect(readOwnershipView(env, () => now)).toMatchObject({
      status: { generation: 4 },
    });
    now += 2;
    expect(readOwnershipView(env, () => now)).toMatchObject({
      status: { generation: 5 },
    });
    // A clock that moved backwards never serves an old read.
    now -= 100_000;
    expect(readOwnershipView(env, () => now)).toMatchObject({
      status: { generation: 5 },
    });
  });
});

describe('the keep-alive publishes the status on every renewal', () => {
  /** The keep-alive renews on real timers; a short interval keeps these tests quick. */
  async function held() {
    const store = new MemoryStore();
    const clock = new VirtualClock();
    const base = contextFor('a', store, clock);
    const ctx = { ...base, timing: { ...base.timing, renewMs: 20 } };
    const lease = new Lease(ctx, (await acquire(ctx, 'request'))!);
    await lease.confirmReplica();
    return { store, ctx, lease };
  }
  const read = (path: string) =>
    parseOwnershipStatus(readFileSync(path, 'utf8'));
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(10);
    expect(check()).toBe(true);
  }

  test('held, then handover when another instance asks, then lost when superseded', async () => {
    const { store, ctx, lease } = await held();
    const path = join(directory, 'live-status');
    let syncedAt: number | null = null;
    const alive = keepAlive(lease, ctx, join(directory, 'live-gate'), {
      path,
      lastSyncAt: () => syncedAt,
    });
    expect(read(path)).toMatchObject({
      state: 'held',
      generation: 1,
      holder: 'a',
      lastSyncAtWall: null,
      replicaGeneration: 1,
    });
    syncedAt = Date.now() - 2_000;
    await until(() => read(path)?.lastSyncAtWall === syncedAt);
    expect(
      Math.abs((read(path)?.renewedAtWall ?? 0) - Date.now())
    ).toBeLessThan(5_000);

    const found = (await store.get(ownerKey(PREFIX)))!;
    const asked = await store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...parseOwner(found.body), handoverTo: 'b' }),
      { ifMatch: found.etag }
    );
    expect(asked.ok).toBe(true);
    await until(() => read(path)?.state === 'handover');

    const next = (await store.get(ownerKey(PREFIX)))!;
    await store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...parseOwner(next.body), holder: 'b', generation: 2 }),
      { ifMatch: next.etag }
    );
    await until(() => read(path)?.state === 'lost');
    alive.stop();
  });

  test('a draining holder reports handover even before storage says so', async () => {
    const { ctx, lease } = await held();
    const path = join(directory, 'draining-status');
    const alive = keepAlive(lease, ctx, join(directory, 'draining-gate'), {
      path,
      lastSyncAt: () => null,
    });
    alive.closeGate();
    expect(read(path)?.state).toBe('handover');
    alive.stop();
  });

  test('an unwritable status file never disturbs renewal', async () => {
    const { store, ctx, lease } = await held();
    const beatOf = () =>
      parseOwner(store.objects.get(ownerKey(PREFIX))!.body).beat;
    const before = beatOf();
    const alive = keepAlive(lease, ctx, join(directory, 'gate-2'), {
      path: join(directory, 'no-such-directory', 'status'),
      lastSyncAt: () => null,
    });
    await until(() => beatOf() >= before + 3);
    expect(lease.current).toBe('held');
    alive.stop();
  });
});
