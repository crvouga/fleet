import { expect, test } from 'bun:test';

import { desiredRevision } from '../../src/domain/desired-state';
import { HEARTBEAT_RETENTION_MS, runPrune } from '../../src/jobs/prune';
import { runOfflineSweep, type JobDeps } from '../../src/jobs/offline-notifier';
import { silent } from '../support/controller';
import { at, heartbeatBody, nodeIdOf, T0 } from '../support/fixtures';

import { countOf, eventKinds } from './support/probe';
import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode } from './support/sim-node';

const DAY = 86_400;
const WEBHOOK = 'https://hooks.example.test/fleet';

function recorder() {
  const posts: unknown[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response('ok');
  }) as unknown as typeof fetch;
  return { posts, fetchImpl };
}

const deps = (
  p: ControllerProcess,
  now: () => Date,
  fetchImpl: typeof fetch
): JobDeps => ({ store: p.store, now, fetch: fetchImpl, log: silent });

describeRig(
  'Resilience (Req 11): node disconnect, reconnect and prolonged offline',
  (rig) => {
    test('days of silence produce one notice and one webhook, then recovered once on return', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await p.h.admin('PUT', '/v1/settings/fleet', {
        alerts: { webhookUrl: WEBHOOK },
      });
      const node = simNode(1);
      await node.settle(p.h);
      const hook = recorder();
      const job = deps(p, clock.now, hook.fetchImpl);
      let announced = 0;
      for (let i = 0; i < 400; i += 1) {
        clock.advance(30 * 60); // a sweep every half hour, ~8 days
        announced += await runOfflineSweep(job);
      }
      expect(announced).toBe(1);
      expect(hook.posts).toHaveLength(1);
      const status = (await p.h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body
        .node.status;
      expect(status).toBe('offline');

      await node.settle(p.h);
      const kinds = await eventKinds(p.store, nodeIdOf(1));
      expect(countOf(kinds, 'offline')).toBe(1);
      expect(countOf(kinds, 'recovered')).toBe(1);
      expect(
        (await p.store.findNode(nodeIdOf(1)))?.offlineNotifiedAt
      ).toBeNull();
      expect(
        (await p.h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node.status
      ).toBe('online');

      // A second outage is a second notice, never a repeat of the first.
      clock.advance(DAY);
      expect(await runOfflineSweep(job)).toBe(1);
      expect(await runOfflineSweep(job)).toBe(0);
      expect(hook.posts).toHaveLength(2);
      await node.beat(p.h);
      const after = await eventKinds(p.store, nodeIdOf(1));
      expect(countOf(after, 'offline')).toBe(2);
      expect(countOf(after, 'recovered')).toBe(2);
    });

    test('the offline threshold is the node effective setting, so a longer threshold delays the notice', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await simNode(1).settle(p.h);
      await p.h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        alerts: { offlineAfterSeconds: 3600 },
      });
      const job = deps(p, clock.now, recorder().fetchImpl);
      clock.advance(3000);
      expect(await runOfflineSweep(job)).toBe(0);
      clock.advance(601);
      expect(await runOfflineSweep(job)).toBe(1);
    });

    test('a node away for days is told the full current document, recomputed from today settings', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h);
      const stale = node.applied;
      clock.advance(3 * DAY);
      await p.h.admin('PUT', '/v1/settings/fleet', {
        sync: { paused: false },
        disk: { alertPercent: 85 },
      });
      clock.advance(2 * DAY);
      await p.h.admin('PUT', '/v1/settings/role:ci', {
        runners: { cordoned: false },
        heartbeat: { intervalSeconds: 20 },
      });
      await p.h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        capacity: { slotMax: 3 },
      });
      clock.advance(DAY);
      // The node returns still holding the revision from before every change.
      const reply = await node.beat(p.h);
      expect(node.applied).not.toBe(stale);
      const desired = reply.body.desired;
      expect(desired.values).toEqual({
        sync: { paused: false },
        disk: { alertPercent: 85 },
        runners: { cordoned: false },
        heartbeat: { intervalSeconds: 20 },
        capacity: { slotMax: 3 },
      });
      expect(desired.closure).toBe('ci');
      expect(desiredRevision(desired)).toBe(desired.revision);
      const view = (await p.h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body
        .node;
      expect(view.desiredRevision).toBe(desired.revision);
      // It is current from then on, not offered the same thing again.
      expect((await node.beat(p.h)).body.desired).toBeUndefined();
    });

    test('a node that was reassigned while away converges to the new role document', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h);
      clock.advance(2 * DAY);
      await p.h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { role: 'devbox' });
      const reply = await node.beat(p.h);
      expect(reply.body.desired).toMatchObject({
        role: 'devbox',
        closure: 'devbox',
      });
      const view = (await p.h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body
        .node;
      expect(view.convergence).toBe('progressing');
    });

    test('heartbeat history pruning keeps exactly the retention window and nothing else is deleted', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      const retention = HEARTBEAT_RETENTION_MS / 1000;
      for (const ago of [
        retention + 2 * DAY,
        retention + 1,
        retention,
        retention - 1,
        60,
        0,
      ]) {
        clock.set(at(10 * DAY - ago));
        await node.beat(p.h);
      }
      clock.set(at(10 * DAY));
      const kept = async () =>
        (await p.store.listHeartbeats(nodeIdOf(1), at(-30 * DAY))).length;
      expect(await kept()).toBe(6);
      expect(await runPrune(deps(p, clock.now, recorder().fetchImpl))).toBe(2);
      expect(await kept()).toBe(4);
      // Boundary: a point exactly at the cut-off is kept. Pruning again is a no-op.
      expect(await runPrune(deps(p, clock.now, recorder().fetchImpl))).toBe(0);
      expect(await kept()).toBe(4);
      // Events, settings history and the node itself are not history to prune.
      expect(await p.store.findNode(nodeIdOf(1))).not.toBeNull();
      expect(
        countOf(await eventKinds(p.store, nodeIdOf(1)), 'registered')
      ).toBe(1);
    });

    test('retention is operator-set in whole days, and an out-of-range value falls back to the default instead of clamping', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      for (const ago of [4 * DAY, 3 * DAY + 1, 3 * DAY, 3 * DAY - 1, 0]) {
        clock.set(at(40 * DAY - ago));
        await node.beat(p.h);
      }
      clock.set(at(40 * DAY));
      const kept = async () =>
        (await p.store.listHeartbeats(nodeIdOf(1), at(0))).length;
      for (const invalid of [0, 400, 2.5, -3]) {
        const job = {
          ...deps(p, clock.now, recorder().fetchImpl),
          heartbeatRetentionDays: invalid,
        };
        expect([invalid, await runPrune(job)]).toEqual([invalid, 0]); // default 30 days: nothing is old enough
      }
      expect(await kept()).toBe(5);
      const job = {
        ...deps(p, clock.now, recorder().fetchImpl),
        heartbeatRetentionDays: 3,
      };
      expect(await runPrune(job)).toBe(2);
      expect(await kept()).toBe(3);
    });

    test('a node offline longer than retention keeps its row, events and settings while its points vanish', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await p.h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        capacity: { slotMax: 2 },
      });
      await simNode(1).beat(p.h);
      clock.advance(HEARTBEAT_RETENTION_MS / 1000 + DAY);
      await runPrune(deps(p, clock.now, recorder().fetchImpl));
      expect(
        await p.store.listHeartbeats(nodeIdOf(1), at(-1 * DAY))
      ).toHaveLength(0);
      expect((await p.store.getSettings(`node:${nodeIdOf(1)}`))?.revision).toBe(
        1
      );
      expect((await p.store.findNode(nodeIdOf(1)))?.lastSeenAt).toEqual(T0);
    });

    test('a node resending its outbox after a long outage records each keyed event once', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h, { bootId: 'boot-1' });
      clock.advance(5 * DAY);
      const outbox = [
        {
          kind: 'unclean-shutdown',
          severity: 'warn' as const,
          message: 'power was lost',
          key: 'unclean:boot-1',
          at: '2026-10-15T01:02:03Z',
        },
        {
          kind: 'boot',
          severity: 'info' as const,
          message: 'node started',
          key: 'boot:boot-2',
        },
        {
          kind: 'job-interrupted',
          severity: 'warn' as const,
          message: 'job 7 interrupted',
          key: 'job:7',
          data: { slot: 'slot-1' },
        },
      ];
      // The answers were lost three times; the node resends the same outbox.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clock.advance(60);
        await node.beat(p.h, { bootId: 'boot-2', events: outbox });
      }
      const kinds = await eventKinds(p.store, nodeIdOf(1));
      expect(countOf(kinds, 'unclean-shutdown')).toBe(1);
      expect(countOf(kinds, 'job-interrupted')).toBe(1);
      // The agent's own boot event suppresses the derived one: one boot, not two.
      expect(countOf(kinds, 'boot')).toBe(1);
      const stored = await p.store.listEvents({
        nodeId: nodeIdOf(1),
        limit: 50,
      });
      const unclean = stored.find((event) => event.kind === 'unclean-shutdown');
      expect(unclean?.data).toMatchObject({
        key: 'unclean:boot-1',
        occurredAt: '2026-10-15T01:02:03Z',
      });
    });

    test('without an agent boot event the controller derives exactly one, however often the new boot id repeats', async () => {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h, { bootId: 'boot-1' });
      for (let i = 0; i < 5; i += 1) await node.beat(p.h, { bootId: 'boot-2' });
      expect(countOf(await eventKinds(p.store, nodeIdOf(1)), 'boot')).toBe(1);
    });

    test('the same key from another node is a different event', async () => {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await enrollCi(p.h, 2);
      const event = [
        {
          kind: 'unclean-shutdown',
          severity: 'warn' as const,
          message: 'x',
          key: 'shared-key',
        },
      ];
      await simNode(1).beat(p.h, { events: event });
      await simNode(2).beat(p.h, { events: event });
      expect(countOf(await eventKinds(p.store), 'unclean-shutdown')).toBe(2);
    });

    test('ten identical heartbeats at once derive each change exactly once', async () => {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h, { bootId: 'boot-1' });
      const changed = heartbeatBody(1, {
        bootId: 'boot-2',
        revision: '3'.repeat(40),
        sync: { rolledBack: true, healthFailure: 'x', paused: false },
        failedUnits: ['a.service'],
        agent: { version: '2', desiredRevision: node.applied },
      });
      await Promise.all(
        Array.from({ length: 10 }, () =>
          p.h.asNode(1, 'POST', '/v1/heartbeat', changed)
        )
      );
      const kinds = await eventKinds(p.store, nodeIdOf(1));
      for (const derived of ['boot', 'revision', 'rollback', 'units_failed']) {
        expect([derived, countOf(kinds, derived)]).toEqual([derived, 1]);
      }
    });

    // The sweep claims each outage atomically (Store.claimOfflineNotice), so
    // overlapping sweeps announce it once.
    test('overlapping offline sweeps announce one outage once', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await simNode(1).beat(p.h);
      clock.advance(400);
      const job = deps(p, clock.now, recorder().fetchImpl);
      await Promise.all([
        runOfflineSweep(job),
        runOfflineSweep(job),
        runOfflineSweep(job),
      ]);
      expect(countOf(await eventKinds(p.store, nodeIdOf(1)), 'offline')).toBe(
        1
      );
    });
  }
);
