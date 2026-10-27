import { describe, expect, test } from 'bun:test';

import { describeStore } from '../support/describe-store';
import { nodeIdOf, registerInput } from '../support/fixtures';

describeStore('PgStore events and settings', (ctx) => {
  describe('events', () => {
    test('addEvent round-trips every field, including json data', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.addEvent({
        nodeId: nodeIdOf(1),
        nodeLabel: 'Rack 1',
        kind: 'custom',
        severity: 'warn',
        message: 'hello é "quoted"',
        data: {
          n: 1,
          nested: { list: [1, 'two', null] },
          text: '{"looks":"like json"}',
        },
      });
      const [event] = await store.listEvents({ limit: 1 });
      expect(event).toMatchObject({
        nodeId: nodeIdOf(1),
        nodeLabel: 'Rack 1',
        kind: 'custom',
        severity: 'warn',
        message: 'hello é "quoted"',
        data: {
          n: 1,
          nested: { list: [1, 'two', null] },
          text: '{"looks":"like json"}',
        },
      });
      expect(event?.at).toBeInstanceOf(Date);
      expect(typeof event?.id).toBe('number');
    });

    test('an event without a node or data is allowed', async () => {
      const { store } = ctx();
      await store.addEvent({
        nodeId: null,
        nodeLabel: null,
        kind: 'note',
        severity: 'info',
        message: 'm',
      });
      expect((await store.listEvents({ limit: 1 }))[0]).toMatchObject({
        nodeId: null,
        nodeLabel: null,
        data: {},
      });
    });

    test('an unknown node id or severity is refused', async () => {
      const { store } = ctx();
      await expect(
        store.addEvent({
          nodeId: nodeIdOf(9),
          nodeLabel: null,
          kind: 'k',
          severity: 'info',
          message: 'm',
        })
      ).rejects.toThrow();
      await expect(
        store.addEvent({
          nodeId: null,
          nodeLabel: null,
          kind: 'k',
          severity: 'fatal' as 'info',
          message: 'm',
        })
      ).rejects.toThrow();
    });

    test('newest first, paged by beforeId and limit', async () => {
      const { store } = ctx();
      for (let i = 1; i <= 7; i += 1) {
        await store.addEvent({
          nodeId: null,
          nodeLabel: null,
          kind: `k${i}`,
          severity: 'info',
          message: String(i),
        });
      }
      const first = await store.listEvents({ limit: 3 });
      expect(first.map((e) => e.message)).toEqual(['7', '6', '5']);
      const second = await store.listEvents({
        limit: 3,
        beforeId: first.at(-1)?.id ?? 0,
      });
      expect(second.map((e) => e.message)).toEqual(['4', '3', '2']);
      const last = await store.listEvents({
        limit: 3,
        beforeId: second.at(-1)?.id ?? 0,
      });
      expect(last.map((e) => e.message)).toEqual(['1']);
      expect(
        await store.listEvents({ limit: 3, beforeId: last.at(-1)?.id ?? 0 })
      ).toEqual([]);
    });

    test('filters by node', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.registerNode(registerInput(2));
      await store.setApproval(nodeIdOf(2), 'approved', 'chris');
      const only = await store.listEvents({ limit: 50, nodeId: nodeIdOf(2) });
      expect(only.length).toBeGreaterThan(0);
      expect(only.every((e) => e.nodeId === nodeIdOf(2))).toBe(true);
    });

    test('severity warn means warn and error; error means only error', async () => {
      const { store } = ctx();
      for (const severity of ['info', 'warn', 'error'] as const) {
        await store.addEvent({
          nodeId: null,
          nodeLabel: null,
          kind: severity,
          severity,
          message: severity,
        });
      }
      expect(
        (await store.listEvents({ limit: 10, severity: 'warn' })).map(
          (e) => e.kind
        )
      ).toEqual(['error', 'warn']);
      expect(
        (await store.listEvents({ limit: 10, severity: 'error' })).map(
          (e) => e.kind
        )
      ).toEqual(['error']);
      expect(await store.listEvents({ limit: 10 })).toHaveLength(3);
    });

    test('combined filters apply together', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.addEvent({
        nodeId: nodeIdOf(1),
        nodeLabel: 'a',
        kind: 'x',
        severity: 'error',
        message: '1',
      });
      await store.addEvent({
        nodeId: nodeIdOf(1),
        nodeLabel: 'a',
        kind: 'y',
        severity: 'info',
        message: '2',
      });
      await store.addEvent({
        nodeId: null,
        nodeLabel: null,
        kind: 'z',
        severity: 'error',
        message: '3',
      });
      const found = await store.listEvents({
        limit: 10,
        nodeId: nodeIdOf(1),
        severity: 'warn',
      });
      expect(found.map((e) => e.kind)).toEqual(['x']);
    });
  });

  describe('settings', () => {
    test('getSettings is null until a document is written', async () => {
      expect(await ctx().store.getSettings('fleet')).toBeNull();
      expect(await ctx().store.listSettings()).toEqual([]);
    });

    test('putSettings stores, returns and attributes the document', async () => {
      const { store } = ctx();
      const row = await store.putSettings(
        'fleet',
        { sync: { paused: true }, runners: { extraLabels: ['a,b', 'c'] } },
        'chris'
      );
      expect(row).toMatchObject({
        scope: 'fleet',
        value: {
          sync: { paused: true },
          runners: { extraLabels: ['a,b', 'c'] },
        },
        updatedBy: 'chris',
      });
      expect(row.updatedAt).toBeInstanceOf(Date);
      expect(await store.getSettings('fleet')).toEqual(row);
    });

    test('replaces the whole document rather than merging', async () => {
      const { store } = ctx();
      await store.putSettings(
        'fleet',
        { sync: { paused: true }, disk: { alertPercent: 80 } },
        'a'
      );
      const row = await store.putSettings(
        'fleet',
        { disk: { alertPercent: 85 } },
        'b'
      );
      expect(row.value).toEqual({ disk: { alertPercent: 85 } });
      expect(row.updatedBy).toBe('b');
      expect(await store.listSettings()).toHaveLength(1);
    });

    test('a null value (webhook cleared) and an empty document survive', async () => {
      const { store } = ctx();
      expect(
        (
          await store.putSettings(
            'fleet',
            { alerts: { webhookUrl: null } },
            'a'
          )
        ).value
      ).toEqual({
        alerts: { webhookUrl: null },
      });
      expect((await store.putSettings('fleet', {}, 'a')).value).toEqual({});
    });

    test('scopes are independent and listed by name', async () => {
      const { store } = ctx();
      await store.putSettings('role:web', { sync: { paused: true } }, 'a');
      await store.putSettings('fleet', { sync: { paused: false } }, 'a');
      await store.putSettings(
        `node:${nodeIdOf(1)}`,
        { reboot: { enabled: true } },
        'a'
      );
      expect((await store.listSettings()).map((s) => s.scope)).toEqual([
        'fleet',
        `node:${nodeIdOf(1)}`,
        'role:web',
      ]);
      expect((await store.getSettings('role:web'))?.value).toEqual({
        sync: { paused: true },
      });
    });

    test('history appends one entry per write, newest first, bounded by limit', async () => {
      const { store } = ctx();
      await store.putSettings('fleet', { disk: { alertPercent: 80 } }, 'a');
      await store.putSettings('fleet', { disk: { alertPercent: 81 } }, 'b');
      await store.putSettings('fleet', { disk: { alertPercent: 82 } }, 'c');
      await store.putSettings('role:ci', { disk: { alertPercent: 70 } }, 'd');
      const history = await store.settingsHistory('fleet', 10);
      expect(
        history.map((h) => [
          h.changedBy,
          (h.value as { disk: { alertPercent: number } }).disk.alertPercent,
        ])
      ).toEqual([
        ['c', 82],
        ['b', 81],
        ['a', 80],
      ]);
      expect(history[0]?.changedAt).toBeInstanceOf(Date);
      expect(typeof history[0]?.id).toBe('number');
      expect(await store.settingsHistory('fleet', 2)).toHaveLength(2);
      expect(await store.settingsHistory('role:ci', 10)).toHaveLength(1);
      expect(await store.settingsHistory('role:web', 10)).toEqual([]);
    });

    test('history survives deleting the node whose scope it describes', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.putSettings(
        `node:${nodeIdOf(1)}`,
        { sync: { paused: true } },
        'chris'
      );
      await store.deleteNode(nodeIdOf(1), 'chris');
      expect(
        await store.settingsHistory(`node:${nodeIdOf(1)}`, 10)
      ).toHaveLength(1);
    });
  });

  describe('timestamps', () => {
    test('round-trip to the millisecond', async () => {
      const { store } = ctx();
      await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      const stamp = new Date('2026-03-04T05:06:07.891Z');
      await store.setOfflineNotified(nodeIdOf(1), stamp);
      expect(
        (await store.findNode(nodeIdOf(1)))?.offlineNotifiedAt?.getTime()
      ).toBe(stamp.getTime());
    });
  });
});
