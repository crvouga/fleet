import { afterEach, describe, expect, test } from 'bun:test';

import {
  freeLoopbackPort,
  newestReplicaTxid,
  parseLocalTxid,
  pollSyncOnce,
  startSyncMonitor,
  type SyncMonitorDeps,
} from '../../src/ownership/replica-sync';
import { recordingLogger } from '../support/recording-logger';
import { VirtualClock } from './support';

const hex = (n: number) => n.toString(16).padStart(16, '0');
const object = (n: number, level = '0000') => ({
  key: `p/generations/3/${level}/${hex(1)}-${hex(n)}.ltx`,
  lastModified: 0,
});

describe('Litestream metrics and replica listing', () => {
  test('parses the database transaction id, including exponent notation', () => {
    const text = [
      '# TYPE litestream_txid gauge',
      'litestream_db_size{db="/data/fleet.db"} 8192',
      'litestream_txid{db="/data/fleet.db"} 6',
    ].join('\n');
    expect(parseLocalTxid(text)).toBe(6);
    expect(parseLocalTxid('litestream_txid{db="x"} 1.234567e+06\n')).toBe(
      1234567
    );
    expect(parseLocalTxid('litestream_txid 0')).toBe(0);
    expect(parseLocalTxid('litestream_sync_count{db="x"} 3')).toBeNull();
    expect(parseLocalTxid('litestream_txid{db="x"} NaN')).toBeNull();
    expect(parseLocalTxid('')).toBeNull();
  });

  test('the newest replica transaction is the highest max txid of any level', () => {
    expect(newestReplicaTxid([])).toBeNull();
    expect(
      newestReplicaTxid([object(3), object(9, '0001'), object(5, '0009')])
    ).toBe(9);
    expect(
      newestReplicaTxid([
        { key: 'p/generations/3/fleet-note.txt', lastModified: 0 },
        {
          key: `p/generations/3/0000/${hex(1)}-${hex(2)}.tmp`,
          lastModified: 0,
        },
      ])
    ).toBeNull();
  });

  test('a free loopback port is a usable port number', () => {
    const port = freeLoopbackPort();
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe('replica synchronisation', () => {
  const servers: { stop(force: boolean): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  /** A fake Litestream metrics endpoint whose transaction id the test controls. */
  function metrics(initial: number | null) {
    const state = { txid: initial };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        state.txid === null
          ? new Response('down', { status: 500 })
          : new Response(`litestream_txid{db="x"} ${state.txid}\n`),
    });
    servers.push(server);
    return { state, url: `http://127.0.0.1:${server.port}/metrics` };
  }

  function rig(local: number | null, replica: number | null) {
    const endpoint = metrics(local);
    const replicaState = { txid: replica };
    const synced: number[] = [];
    let wall = 1_000;
    const clock = new VirtualClock();
    const deps: SyncMonitorDeps = {
      metricsUrl: endpoint.url,
      list: async () =>
        replicaState.txid === null ? [] : [object(replicaState.txid)],
      wall: () => wall,
      onSynced: (at) => synced.push(at),
      sleep: clock.sleep,
      log: recordingLogger(),
    };
    return {
      local: endpoint.state,
      replica: replicaState,
      synced,
      deps,
      clock,
      tick: () => (wall += 1_000),
      progress: { replicaTxid: null as number | null },
    };
  }

  test('an idle database is always in sync: the age restarts at every look', async () => {
    const t = rig(5, 5);
    for (let i = 0; i < 3; i += 1) {
      await pollSyncOnce(t.deps, t.progress);
      t.tick();
    }
    expect(t.synced).toEqual([1_000, 2_000, 3_000]);
  });

  test('a replica behind the database is not in sync unless it is advancing', async () => {
    const t = rig(10, 7);
    await pollSyncOnce(t.deps, t.progress); // First look: behind, no progress known.
    expect(t.synced).toEqual([]);
    t.tick();
    await pollSyncOnce(t.deps, t.progress); // Still 7: stuck.
    expect(t.synced).toEqual([]);
    t.tick();
    t.replica.txid = 8;
    await pollSyncOnce(t.deps, t.progress); // Advancing, though behind.
    expect(t.synced).toEqual([3_000]);
    t.tick();
    await pollSyncOnce(t.deps, t.progress); // Stuck at 8 again.
    expect(t.synced).toEqual([3_000]);
    t.tick();
    t.replica.txid = 10;
    await pollSyncOnce(t.deps, t.progress); // Caught up.
    expect(t.synced).toEqual([3_000, 5_000]);
  });

  test('no replica objects yet, or an unreadable local position, proves nothing', async () => {
    const empty = rig(3, null);
    await pollSyncOnce(empty.deps, empty.progress);
    expect(empty.synced).toEqual([]);
    const unreadable = rig(null, 3);
    await expect(
      pollSyncOnce(unreadable.deps, unreadable.progress)
    ).rejects.toThrow('transaction id');
  });

  test('the monitor polls on its interval and logs an unreachable endpoint once per outage', async () => {
    const t = rig(null, 4);
    const real = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const monitor = startSyncMonitor({ ...t.deps, sleep: real, pollMs: 15 });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 300 && !check(); i += 1) await Bun.sleep(10);
      expect(check()).toBe(true);
    };
    const lines = (t.deps.log as ReturnType<typeof recordingLogger>).lines;
    const failures = () =>
      lines.filter((l) => l.includes('replica.sync_check_failed')).length;
    await until(() => failures() === 1);
    await Bun.sleep(100); // Several more polls: still one warning.
    expect(failures()).toBe(1);
    expect(t.synced).toEqual([]);
    t.local.txid = 4;
    await until(() => t.synced.length > 0);
    t.local.txid = null;
    await until(() => failures() === 2);
    monitor.stop();
    await Bun.sleep(50);
    const count = t.synced.length;
    t.local.txid = 4;
    await Bun.sleep(100);
    expect(t.synced).toHaveLength(count);
  });
});
