import { describe, expect, test } from 'bun:test';

import { acquire, type Claim } from '../../src/ownership/acquire';
import { Lease } from '../../src/ownership/lease';
import {
  OwnerRecordError,
  generationPrefix,
  ownerKey,
  parseOwner,
  verifyConditionalWrites,
} from '../../src/ownership/record';
import {
  MemoryStore,
  PREFIX,
  VirtualClock,
  contextFor,
  flush,
} from './support';

function setup() {
  const store = new MemoryStore();
  const clock = new VirtualClock();
  const ctx = (id: string, stop?: { stopped: boolean }) =>
    contextFor(id, store, clock, stop);
  const record = () => parseOwner(store.objects.get(ownerKey(PREFIX))!.body);
  /** Claims, restores (implicitly) and publishes the replica, as the supervisor does. */
  const own = async (id: string) => {
    const lease = new Lease(ctx(id), (await acquire(ctx(id), 'request'))!);
    expect(await lease.confirmReplica()).toBe(true);
    return lease;
  };
  return { store, clock, ctx, record, own };
}

/** Starts acquiring without awaiting, so a test can interleave other instances. */
function pending(promise: Promise<Claim | null>) {
  let result: Claim | null | undefined;
  void promise.then((value) => (result = value));
  return { result: () => result };
}

describe('writer ownership', () => {
  test('an empty prefix gives generation 1, restoring any pre-ownership replica', async () => {
    const { ctx, record } = setup();
    expect(await acquire(ctx('a'), 'request')).toMatchObject({
      generation: 1,
      restoreFrom: 0,
    });
    expect(record()).toMatchObject({ holder: 'a', generation: 1 });
    expect(generationPrefix(PREFIX, 0)).toBe(PREFIX);
    expect(generationPrefix(PREFIX, 3)).toBe(`${PREFIX}/generations/3`);
  });

  test('released ownership is taken at once, restoring the previous generation', async () => {
    const { ctx, record, own } = setup();
    const a = await own('a');
    await a.release();
    expect(record().holder).toBeNull();
    expect(await acquire(ctx('b'), 'request')).toMatchObject({
      generation: 2,
      restoreFrom: 1,
    });
  });

  test('rolling deploy: a new instance asks for hand-over and receives the next generation', async () => {
    const { ctx, clock, record, own } = setup();
    const a = await own('a');
    const b = pending(acquire(ctx('b'), 'request'));
    await clock.advance(0);
    expect(record().handoverTo).toBe('b');
    expect(await a.renew()).toBe('handover');
    expect(b.result()).toBeUndefined();
    // The holder keeps renewing while it drains, so the waiter never sees it expire.
    for (let i = 0; i < 10; i += 1) {
      await clock.advance(5_000);
      expect(await a.renew()).toBe('handover');
    }
    expect(b.result()).toBeUndefined();
    await a.release();
    await clock.advance(2_000);
    expect(b.result()).toMatchObject({ generation: 2, restoreFrom: 1 });
    expect(record()).toMatchObject({ holder: 'b', handoverTo: null });
  });

  test('the instance that handed over cannot reclaim a release reserved for the requester', async () => {
    const { ctx, clock, record, own } = setup();
    const a = await own('a');
    const b = pending(acquire(ctx('b'), 'request'));
    await clock.advance(0);
    expect(await a.renew()).toBe('handover');
    await a.release();
    // The old instance is now a standby polling alongside the requester.
    const again = pending(acquire(ctx('a'), 'standby'));
    const other = pending(acquire(ctx('c'), 'request'));
    await clock.advance(0);
    expect(again.result()).toBeUndefined();
    expect(other.result()).toBeUndefined();
    expect(record().handoverTo).toBe('b');
    await clock.advance(2_000);
    expect(b.result()).toMatchObject({ generation: 2 });
    expect(again.result()).toBeUndefined();
  });

  test('a reservation for a requester that disappeared expires', async () => {
    const { ctx, clock, record, store, own } = setup();
    const a = await own('a');
    // The requester asked, then crashed without withdrawing.
    const found = store.objects.get(ownerKey(PREFIX))!;
    await store.put(
      ownerKey(PREFIX),
      JSON.stringify({ ...record(), handoverTo: 'b' }),
      { ifMatch: found.etag }
    );
    expect(await a.renew()).toBe('handover');
    await a.release();
    const c = pending(acquire(ctx('c'), 'standby'));
    await clock.advance(29_000);
    expect(c.result()).toBeUndefined();
    await clock.advance(4_000);
    expect(c.result()).toMatchObject({ generation: 2, restoreFrom: 1 });
    expect(record().holder).toBe('c');
  });

  test('a claimant that fails before publishing its replica never strands the data', async () => {
    const { ctx, clock, record, own } = setup();
    const a = await own('a');
    await a.release();
    // b claims generation 2, then dies during restore without publishing a replica.
    const b = new Lease(ctx('b'), (await acquire(ctx('b'), 'request'))!);
    expect(b.claim).toMatchObject({ generation: 2, restoreFrom: 1 });
    await b.release();
    expect(record()).toMatchObject({ generation: 2, replica: 1 });
    const c = await acquire(ctx('c'), 'request');
    expect(c).toMatchObject({ generation: 3, restoreFrom: 1 });
    // A holder that crashes before publishing is also skipped after expiry.
    const d = pending(acquire(ctx('d'), 'request'));
    await clock.advance(33_000);
    expect(d.result()).toMatchObject({ generation: 4, restoreFrom: 1 });
  });

  test('a crashed holder is taken over only after the expiry, measured by the waiter', async () => {
    const { ctx, clock, own } = setup();
    await own('a');
    const b = pending(acquire(ctx('b'), 'request'));
    await clock.advance(29_000);
    expect(b.result()).toBeUndefined();
    await clock.advance(4_000);
    expect(b.result()).toMatchObject({ generation: 2, restoreFrom: 1 });
  });

  test('a holder that cannot renew fences itself before any waiter may take over', async () => {
    const { ctx, clock, store, own } = setup();
    const a = await own('a');
    store.down = true;
    await clock.advance(19_000);
    expect(await a.renew()).toBe('held');
    expect(a.writableUntil()).toBeGreaterThan(clock.now());
    await clock.advance(1_000);
    expect(await a.renew()).toBe('lost');
    expect(a.writableUntil()).toBe(0);
    // Fencing (20 s) precedes the earliest possible takeover (30 s).
    expect(ctx('a').timing.fenceMs).toBeLessThan(ctx('a').timing.expireMs);
  });

  test('a paused holder that resumes after a takeover is fenced and never renews again', async () => {
    const { ctx, clock, record, own } = setup();
    const a = await own('a');
    const b = pending(acquire(ctx('b'), 'standby'));
    await clock.advance(35_000);
    expect(b.result()).toMatchObject({ generation: 2 });
    expect(await a.renew()).toBe('lost');
    await a.release();
    expect(record()).toMatchObject({ holder: 'b', generation: 2 });
  });

  test('a standby never requests hand-over, so instances cannot trade ownership back and forth', async () => {
    const { ctx, clock, record, own } = setup();
    const b = await own('b');
    const a = pending(acquire(ctx('a'), 'standby'));
    for (let i = 0; i < 20; i += 1) {
      await clock.advance(5_000);
      expect(await b.renew()).toBe('held');
    }
    expect(record().handoverTo).toBeNull();
    expect(a.result()).toBeUndefined();
    await b.release();
    await clock.advance(2_000);
    expect(a.result()).toMatchObject({ generation: 2, restoreFrom: 1 });
  });

  test('simultaneous starts on an empty prefix: exactly one claims generation 1', async () => {
    const { ctx, clock } = setup();
    const starts = ['a', 'b', 'c', 'd'].map((id) =>
      pending(acquire(ctx(id), 'request'))
    );
    await clock.advance(0);
    const claimed = starts.filter((start) => start.result());
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.result()).toMatchObject({ generation: 1 });
  });

  test('storage outages never grant ownership', async () => {
    const { ctx, clock, store, own } = setup();
    const a = await own('a');
    store.down = true;
    const b = pending(acquire(ctx('b'), 'request'));
    await clock.advance(120_000);
    expect(b.result()).toBeUndefined();
    expect(await a.renew()).toBe('lost');
  });

  test('a requester that stops withdraws its hand-over request', async () => {
    const { ctx, clock, record, own } = setup();
    const a = await own('a');
    const stop = { stopped: false };
    const b = pending(acquire(ctx('b', stop), 'request'));
    await clock.advance(0);
    expect(record().handoverTo).toBe('b');
    stop.stopped = true;
    await clock.advance(2_000);
    expect(b.result()).toBeNull();
    expect(record().handoverTo).toBeNull();
    expect(await a.renew()).toBe('held');
  });

  test('stopping while waiting returns without claiming', async () => {
    const { ctx, clock } = setup();
    await acquire(ctx('a'), 'request');
    const stop = { stopped: false };
    const b = pending(acquire(ctx('b', stop), 'request'));
    await clock.advance(4_000);
    stop.stopped = true;
    await clock.advance(2_000);
    expect(b.result()).toBeNull();
  });

  test('an unreadable owner record refuses ownership instead of guessing', async () => {
    const { ctx, store } = setup();
    store.objects.set(ownerKey(PREFIX), { body: '{"version":9}', etag: '"x"' });
    await expect(acquire(ctx('a'), 'request')).rejects.toBeInstanceOf(
      OwnerRecordError
    );
  });

  test('providers that ignore conditional writes are detected', async () => {
    const { store } = setup();
    expect(await verifyConditionalWrites(store, PREFIX, 'a')).toBe(true);
    expect([...store.objects.keys()]).toEqual([]);
    store.ignoreConditions = true;
    expect(await verifyConditionalWrites(store, PREFIX, 'b')).toBe(false);
  });

  test('randomized interleavings never produce two claims of one generation', async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const { ctx, clock, store } = setup();
      let state = seed;
      const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
      const claims: Claim[] = [];
      const leases: Lease[] = [];
      const published = new Set<number>([0]);
      const waiting = new Set<string>();
      const start = (id: string, mode: 'request' | 'standby') => {
        waiting.add(id);
        void acquire(ctx(id), mode).then((claim) => {
          waiting.delete(id);
          if (!claim) return;
          claims.push(claim);
          const lease = new Lease(ctx(id), claim);
          leases.push(lease);
          if (random() < 0.7)
            void lease.confirmReplica().then((ok) => {
              if (ok) published.add(claim.generation);
            });
        });
      };
      const act = async (step: number) => {
        const roll = random();
        if (roll < 0.15)
          return start(`i${step}`, random() < 0.5 ? 'request' : 'standby');
        if (roll < 0.25) return void (store.down = !store.down);
        const last = leases[leases.length - 1];
        if (roll < 0.35 && last && !store.down) return last.release();
        for (const lease of leases) await lease.renew();
      };
      for (let step = 0; step < 60; step += 1) {
        await act(step);
        await clock.advance(Math.floor(random() * 8_000));
        await flush();
        const writable = leases.filter(
          (lease) => lease.writableUntil() > clock.now()
        );
        expect(writable.length).toBeLessThanOrEqual(1);
      }
      const generations = claims.map((claim) => claim.generation);
      expect(new Set(generations).size).toBe(generations.length);
      expect(generations).toEqual([...generations].sort((a, b) => a - b));
      for (const claim of claims) {
        expect(claim.restoreFrom).toBeLessThan(claim.generation);
        expect(published.has(claim.restoreFrom)).toBe(true);
      }
      const sources = claims.map((claim) => claim.restoreFrom);
      expect(sources).toEqual([...sources].sort((a, b) => a - b));
      expect(claims.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
