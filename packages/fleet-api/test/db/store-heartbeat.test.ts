import { describe, expect, test } from 'bun:test';

import type { PgStore } from '../../src/db/pg-store';
import { describeStore } from '../support/describe-store';
import {
  T0,
  at,
  heartbeatBody,
  nodeIdOf,
  registerInput,
  type HeartbeatOverrides,
} from '../support/fixtures';

async function approved(store: PgStore, n = 1): Promise<void> {
  await store.registerNode(
    registerInput(n, { approval: 'approved', enrolledVia: 'role-token' })
  );
}

async function beat(
  store: PgStore,
  seconds: number,
  overrides: HeartbeatOverrides = {},
  n = 1
) {
  return store.recordHeartbeat(
    nodeIdOf(n),
    heartbeatBody(n, overrides),
    '198.51.100.9',
    at(seconds)
  );
}

async function kinds(store: PgStore): Promise<string[]> {
  return (await store.listEvents({ limit: 100 })).map((e) => e.kind).reverse();
}

describeStore('PgStore heartbeat', (ctx) => {
  describe('recordHeartbeat', () => {
    test('stores the report on the node', async () => {
      const { store } = ctx();
      await approved(store);
      const node = await beat(store, 0, {
        agent: { version: '7', configRevision: 'abc123' },
        hostname: 'ci-renamed',
      });
      expect(node).toMatchObject({
        hostname: 'ci-renamed',
        revision: '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283',
        agentVersion: '7',
        configRevision: 'abc123',
        remoteAddr: '198.51.100.9',
        approval: 'approved',
        heartbeatIntervalSeconds: 60,
      });
      expect(node?.lastSeenAt).toEqual(at(0));
      expect(node?.facts).toMatchObject({
        bootId: 'boot-1',
        hostname: 'ci-renamed',
        cpu: { cores: 16 },
        sync: { rolledBack: false },
        failedUnits: [],
        runners: { slots: 4, busy: 1 },
      });
      expect(node?.facts['events']).toBeUndefined();
    });

    test('facts keep nested json, unicode and nulls exactly', async () => {
      const { store } = ctx();
      await approved(store);
      const node = await beat(store, 0, {
        kernel: null,
        runners: null,
        cpu: { cores: null, model: 'Ryzen é中 "quoted" \\ back' },
        addresses: ['fe80::1', '10.0.0.1'],
      });
      expect(node?.facts).toMatchObject({
        kernel: null,
        runners: null,
        cpu: { cores: null, model: 'Ryzen é中 "quoted" \\ back' },
        addresses: ['fe80::1', '10.0.0.1'],
      });
    });

    test('keeps the old remote address when none is given', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      const node = await store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1),
        null,
        at(5)
      );
      expect(node?.remoteAddr).toBe('198.51.100.9');
    });

    test('returns null for an unknown node and rejects an id mismatch', async () => {
      const { store } = ctx();
      expect(
        await store.recordHeartbeat(nodeIdOf(5), heartbeatBody(5), null, T0)
      ).toBeNull();
      await approved(store);
      await expect(
        store.recordHeartbeat(nodeIdOf(1), heartbeatBody(2), null, T0)
      ).rejects.toThrow('does not match');
    });

    test('leaves rejected and retired nodes untouched', async () => {
      const { store } = ctx();
      await approved(store, 1);
      await approved(store, 2);
      await store.setApproval(nodeIdOf(1), 'rejected', 'chris');
      await store.setApproval(nodeIdOf(2), 'retired', 'chris');
      for (const n of [1, 2]) {
        const node = await beat(store, 0, {}, n);
        expect(node?.lastSeenAt).toBeNull();
        expect(await store.listHeartbeats(nodeIdOf(n), at(-60))).toHaveLength(
          0
        );
      }
    });

    test('a pending node reports too, so a person can see what they approve', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      const node = await beat(store, 0);
      expect(node?.approval).toBe('pending');
      expect(node?.lastSeenAt).toEqual(at(0));
      expect(await store.listHeartbeats(nodeIdOf(1), at(-1))).toHaveLength(1);
    });

    test('a report clears the offline notice', async () => {
      const { store } = ctx();
      await approved(store);
      await store.setOfflineNotified(nodeIdOf(1), at(-10));
      const node = await beat(store, 0);
      expect(node?.offlineNotifiedAt).toBeNull();
    });

    test('the first report after the offline notice is a recovery, once', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      await store.setOfflineNotified(nodeIdOf(1), at(400));
      await beat(store, 500);
      await beat(store, 560);
      expect(
        (await kinds(store)).filter((k) => k === 'recovered')
      ).toHaveLength(1);
    });
  });

  describe('history points', () => {
    test('computes memory, disk, runner and uptime figures', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0, {
        uptimeSeconds: 12_345_678_901,
        load1: 1.5,
        memory: { totalMiB: 1000, availableMiB: 250 },
        disk: { nixUsedPercent: 40, bootUsedPercent: 71 },
        runners: { slots: 8, busy: 3 },
      });
      const [point] = await store.listHeartbeats(nodeIdOf(1), at(-1));
      expect(point).toMatchObject({
        at: at(0),
        uptimeSeconds: 12_345_678_901,
        load1: 1.5,
        memUsedPercent: 75,
        diskPercent: 71,
        slots: 8,
        busySlots: 3,
      });
    });

    test('unknown figures are null', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0, {
        uptimeSeconds: null,
        load1: null,
        memory: { totalMiB: null, availableMiB: null },
        disk: { nixUsedPercent: null, bootUsedPercent: null },
        runners: null,
      });
      const [point] = await store.listHeartbeats(nodeIdOf(1), at(-1));
      expect(point).toMatchObject({
        uptimeSeconds: null,
        load1: null,
        memUsedPercent: null,
        diskPercent: null,
        slots: null,
        busySlots: null,
      });
    });

    test('are ordered oldest first, bounded by since, and tolerate a repeated instant', async () => {
      const { store } = ctx();
      await approved(store);
      for (const s of [30, 10, 20, 20]) await beat(store, s);
      const all = await store.listHeartbeats(nodeIdOf(1), at(0));
      expect(all.map((p) => p.at.getTime())).toEqual([
        at(10).getTime(),
        at(20).getTime(),
        at(30).getTime(),
      ]);
      const recent = await store.listHeartbeats(nodeIdOf(1), at(20));
      expect(recent).toHaveLength(2);
    });

    test('are kept per node', async () => {
      const { store } = ctx();
      await approved(store, 1);
      await approved(store, 2);
      await beat(store, 0, {}, 1);
      await beat(store, 0, {}, 2);
      await beat(store, 5, {}, 2);
      expect(await store.listHeartbeats(nodeIdOf(1), at(-1))).toHaveLength(1);
      expect(await store.listHeartbeats(nodeIdOf(2), at(-1))).toHaveLength(2);
    });

    test('concurrent reports for one node all land', async () => {
      const { store } = ctx();
      await approved(store);
      await Promise.all(Array.from({ length: 8 }, (_, i) => beat(store, i)));
      expect(await store.listHeartbeats(nodeIdOf(1), at(-1))).toHaveLength(8);
    });
  });

  describe('pruneHeartbeats', () => {
    test('deletes strictly older points, keeps the boundary, and counts them', async () => {
      const { store } = ctx();
      await approved(store);
      for (const s of [0, 10, 20, 30]) await beat(store, s);
      expect(await store.pruneHeartbeats(at(20))).toBe(2);
      const left = await store.listHeartbeats(nodeIdOf(1), at(-1));
      expect(left.map((p) => p.at.getTime())).toEqual([
        at(20).getTime(),
        at(30).getTime(),
      ]);
      expect(await store.pruneHeartbeats(at(20))).toBe(0);
    });

    test('keeps events, nodes and settings', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      await store.putSettings('fleet', { sync: { paused: true } }, 'chris');
      const events = (await store.listEvents({ limit: 100 })).length;
      await store.pruneHeartbeats(at(1_000_000));
      expect((await store.listEvents({ limit: 100 })).length).toBe(events);
      expect(await store.getSettings('fleet')).not.toBeNull();
      expect(await store.findNode(nodeIdOf(1))).not.toBeNull();
    });
  });

  describe('events the node sends', () => {
    test('are stored in order with the node label, at the report time', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0, {
        events: [
          { kind: 'boot', severity: 'info', message: 'node started' },
          { kind: 'update', severity: 'warn', message: 'second' },
          { kind: 'third', severity: 'error', message: 'third' },
        ],
      });
      const events = [...(await store.listEvents({ limit: 10 }))]
        .reverse()
        .slice(2);
      expect(events.map((e) => [e.kind, e.severity, e.message])).toEqual([
        ['boot', 'info', 'node started'],
        ['update', 'warn', 'second'],
        ['third', 'error', 'third'],
      ]);
      expect(events[0]).toMatchObject({
        nodeId: nodeIdOf(1),
        nodeLabel: `ci-${nodeIdOf(1).slice(0, 4)}`,
      });
      expect(events[0]?.at).toEqual(at(0));
    });

    test('a report that carries a bad severity is refused whole, with nothing stored', async () => {
      const { store } = ctx();
      await approved(store);
      const bad = heartbeatBody(1, {
        events: [{ kind: 'x', severity: 'fatal' as 'info', message: 'nope' }],
      });
      await expect(
        store.recordHeartbeat(nodeIdOf(1), bad, null, at(0))
      ).rejects.toThrow();
      expect((await store.findNode(nodeIdOf(1)))?.lastSeenAt).toBeNull();
      expect(await store.listHeartbeats(nodeIdOf(1), at(-1))).toHaveLength(0);
    });
  });

  describe('events the server derives', () => {
    test('the first report announces nothing about boots, revisions or disks', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      expect(await kinds(store)).toEqual(['registered', 'approved']);
    });

    test('a changed boot id is one boot event; the agent own boot event wins', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      await beat(store, 60, { bootId: 'boot-2' });
      await beat(store, 120, { bootId: 'boot-2' });
      await beat(store, 180, {
        bootId: 'boot-3',
        events: [{ kind: 'boot', severity: 'info', message: 'node started' }],
      });
      const boots = (await store.listEvents({ limit: 50 })).filter(
        (e) => e.kind === 'boot'
      );
      expect(boots.map((e) => e.message).sort()).toEqual([
        'node started',
        'started again (new boot)',
      ]);
    });

    test('a new revision is announced once', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      await beat(store, 60, {
        revision: 'abcdef0123456789abcdef0123456789abcdef01',
      });
      await beat(store, 120, {
        revision: 'abcdef0123456789abcdef0123456789abcdef01',
      });
      const revisions = (await store.listEvents({ limit: 50 })).filter(
        (e) => e.kind === 'revision'
      );
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.message).toBe('updated from 9f3c2a1 to abcdef0');
    });

    test('rollback appears once and clears once', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      const rolled = {
        sync: { rolledBack: true, healthFailure: 'sshd failed' },
      };
      await beat(store, 60, rolled);
      await beat(store, 120, rolled);
      await beat(store, 180);
      await beat(store, 240);
      const events = (await store.listEvents({ limit: 50 })).filter((e) =>
        e.kind.startsWith('rollback')
      );
      expect(events.map((e) => [e.kind, e.severity]).reverse()).toEqual([
        ['rollback', 'error'],
        ['rollback_cleared', 'info'],
      ]);
      expect(events.at(-1)?.message).toContain('sshd failed');
    });

    test('failed units: only the units that changed are named', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      await beat(store, 60, { failedUnits: ['a.service'] });
      await beat(store, 120, { failedUnits: ['a.service'] });
      await beat(store, 180, { failedUnits: ['a.service', 'b.service'] });
      await beat(store, 240, { failedUnits: ['b.service'] });
      await beat(store, 300, { failedUnits: [] });
      const units = (await store.listEvents({ limit: 50 }))
        .filter((e) => e.kind.startsWith('units_'))
        .reverse()
        .map((e) => [e.kind, e.message]);
      expect(units).toEqual([
        ['units_failed', 'failed units: a.service'],
        ['units_failed', 'failed units: b.service'],
        ['units_recovered', 'units recovered: a.service'],
        ['units_recovered', 'units recovered: b.service'],
      ]);
    });

    test('a long list of failed units is summarised', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      const many = Array.from({ length: 9 }, (_, i) => `u${i}.service`);
      await beat(store, 60, { failedUnits: many });
      const [event] = await store.listEvents({ limit: 1 });
      expect(event?.message).toBe(
        'failed units: u0.service, u1.service, u2.service, u3.service, u4.service and 4 more'
      );
    });

    test('disk over the default 90 percent alerts on the crossing, not while it stays high', async () => {
      const { store } = ctx();
      await approved(store);
      await beat(store, 0);
      await beat(store, 60, { disk: { nixUsedPercent: 91 } });
      await beat(store, 120, { disk: { nixUsedPercent: 95 } });
      await beat(store, 180, { disk: { nixUsedPercent: 60 } });
      await beat(store, 240, { disk: { nixUsedPercent: 61 } });
      const disks = (await store.listEvents({ limit: 50 }))
        .filter((e) => e.kind.startsWith('disk_'))
        .reverse();
      expect(disks.map((e) => [e.kind, e.severity, e.message])).toEqual([
        ['disk_high', 'warn', '/nix is 91% full (alert at 90%)'],
        ['disk_ok', 'info', '/nix is down to 60% full'],
      ]);
    });

    test('the alert threshold comes from the settings that apply to the node', async () => {
      const { store } = ctx();
      await approved(store);
      await store.putSettings('fleet', { disk: { alertPercent: 80 } }, 'chris');
      await store.putSettings(
        'role:ci',
        { disk: { alertPercent: 70 } },
        'chris'
      );
      await beat(store, 0);
      await beat(store, 60, { disk: { bootUsedPercent: 72 } });
      const [event] = await store.listEvents({ limit: 1 });
      expect(event).toMatchObject({
        kind: 'disk_high',
        message: '/boot is 72% full (alert at 70%)',
      });
      await store.putSettings(
        `node:${nodeIdOf(1)}`,
        { disk: { alertPercent: 99 } },
        'chris'
      );
      const before = (await store.listEvents({ limit: 100 })).length;
      await beat(store, 120, { disk: { bootUsedPercent: 98 } });
      expect(await store.listEvents({ limit: 100 })).toHaveLength(before);
      await beat(store, 180, { disk: { bootUsedPercent: 99 } });
      expect((await store.listEvents({ limit: 1 }))[0]?.message).toBe(
        '/boot is 99% full (alert at 99%)'
      );
    });

    test('a pending node produces no derived events, only what it sent', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await beat(store, 0);
      await beat(store, 60, {
        bootId: 'boot-2',
        failedUnits: ['a.service'],
        sync: { rolledBack: true },
      });
      expect(await kinds(store)).toEqual(['registered']);
    });
  });

  describe('heartbeat interval', () => {
    test('is the most specific heartbeat.intervalSeconds, else 60', async () => {
      const { store } = ctx();
      await approved(store);
      expect((await beat(store, 0))?.heartbeatIntervalSeconds).toBe(60);
      await store.putSettings(
        'fleet',
        { heartbeat: { intervalSeconds: 30 } },
        'chris'
      );
      expect((await beat(store, 1))?.heartbeatIntervalSeconds).toBe(30);
      await store.putSettings(
        'role:ci',
        { heartbeat: { intervalSeconds: 120 } },
        'chris'
      );
      expect((await beat(store, 2))?.heartbeatIntervalSeconds).toBe(120);
      await store.putSettings(
        `node:${nodeIdOf(1)}`,
        { heartbeat: { intervalSeconds: 15 } },
        'chris'
      );
      expect((await beat(store, 3))?.heartbeatIntervalSeconds).toBe(15);
    });

    test('a role document does not apply to a node of another role', async () => {
      const { store } = ctx();
      await approved(store);
      await store.putSettings(
        'role:web',
        { heartbeat: { intervalSeconds: 300 } },
        'chris'
      );
      expect((await beat(store, 0))?.heartbeatIntervalSeconds).toBe(60);
    });
  });
});
