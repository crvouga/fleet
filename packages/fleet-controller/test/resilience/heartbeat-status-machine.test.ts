import { expect, test } from 'bun:test';

import { runOfflineSweep, type JobDeps } from '../../src/jobs/offline-notifier';
import { silent } from '../support/controller';
import { adminConfirmed } from '../support/confirm';
import { nodeIdOf } from '../support/fixtures';

import { prng } from './support/prng';
import { countOf, eventKinds } from './support/probe';
import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode, type SimNode } from './support/sim-node';

const ID = nodeIdOf(1);
const noNetwork = (async () => new Response('ok')) as unknown as typeof fetch;

const statusOf = async (p: ControllerProcess, n = 1): Promise<string> =>
  (await p.h.admin('GET', `/v1/nodes/${nodeIdOf(n)}`)).body.node.status;

describeRig(
  'Resilience (Req 11): heartbeat loss and recovery state machine',
  (rig) => {
    const sweep = (p: ControllerProcess) =>
      runOfflineSweep({
        store: p.store,
        now: rig().clock.now,
        fetch: noNetwork,
        log: silent,
      } satisfies JobDeps);

    /** Reports once and returns the process, so the clock then moves relative to that report. */
    async function reported(
      settings?: Record<string, unknown>,
      scope = 'fleet'
    ) {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      if (settings !== undefined)
        await p.h.admin('PUT', `/v1/settings/${scope}`, settings);
      await simNode(1).beat(p.h);
      return p;
    }

    /** The age (seconds since the report) at which each status begins, scanning second by second. */
    async function boundaries(p: ControllerProcess, limit: number) {
      const seen: [number, string][] = [];
      const { clock } = rig();
      for (let age = 0; age <= limit; age += 1) {
        const status = await statusOf(p);
        if (seen.at(-1)?.[1] !== status) seen.push([age, status]);
        clock.advance(1);
      }
      return seen;
    }

    test('default interval: online until 150 s, stale until 300 s, offline after', async () => {
      const p = await reported();
      expect(await boundaries(p, 320)).toEqual([
        [0, 'online'],
        [151, 'stale'],
        [301, 'offline'],
      ]);
    });

    test('a short interval keeps the 90 s floor; a long one is capped by the offline threshold', async () => {
      const short = await reported({ heartbeat: { intervalSeconds: 15 } });
      expect(await boundaries(short, 120)).toEqual([
        [0, 'online'],
        [91, 'stale'],
      ]);
    });

    test('a long interval is online until the offline threshold, with no stale window', async () => {
      const p = await reported({ heartbeat: { intervalSeconds: 600 } });
      expect(await boundaries(p, 310)).toEqual([
        [0, 'online'],
        [301, 'offline'],
      ]);
    });

    test('the minimum offline threshold collapses online and stale into the same boundary', async () => {
      const p = await reported({ alerts: { offlineAfterSeconds: 60 } });
      expect(await boundaries(p, 70)).toEqual([
        [0, 'online'],
        [61, 'offline'],
      ]);
    });

    test('an interval change reaches the status rule only when the node next reports it', async () => {
      const { clock } = rig();
      const p = await reported();
      await p.h.admin('PUT', '/v1/settings/fleet', {
        heartbeat: { intervalSeconds: 600 },
      });
      // The node has not reported since the change: the stored interval is still 60.
      clock.advance(200);
      expect(await statusOf(p)).toBe('stale');
      await simNode(1).beat(p.h);
      expect(
        (await p.h.admin('GET', `/v1/nodes/${ID}`)).body.node
          .heartbeatIntervalSeconds
      ).toBe(600);
      clock.advance(200);
      expect(await statusOf(p)).toBe('online');
    });

    test('status never contradicts approval: pending, rejected and retired nodes keep their approval as status at any age', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      for (const n of [1, 2, 3]) await p.h.register(n);
      await simNode(1).beat(p.h);
      await adminConfirmed(p.h, 'POST', `/v1/nodes/${nodeIdOf(2)}/reject`, 2);
      await p.h.admin('POST', `/v1/nodes/${nodeIdOf(3)}/approve`);
      await adminConfirmed(p.h, 'POST', `/v1/nodes/${nodeIdOf(3)}/retire`, 3);
      for (const days of [0, 1, 40]) {
        clock.advance(days * 86_400);
        expect(await statusOf(p, 1)).toBe('pending');
        expect(await statusOf(p, 2)).toBe('rejected');
        expect(await statusOf(p, 3)).toBe('retired');
      }
      // None of them is ever announced offline.
      expect(await sweep(p)).toBe(0);
    });

    test('an approved node that never reported is offline at once but announced only after the threshold since approval', async () => {
      const { clock } = rig();
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      // approved_at comes from the database clock, not the injected one: measure from it.
      const approvedAt = (await p.store.findNode(ID))?.approvedAt;
      expect(approvedAt).toBeInstanceOf(Date);
      clock.set(new Date((approvedAt as Date).getTime() + 5000));
      expect(await statusOf(p)).toBe('offline');
      clock.set(new Date((approvedAt as Date).getTime() + 300_000));
      expect(await sweep(p)).toBe(0);
      clock.set(new Date((approvedAt as Date).getTime() + 301_000));
      expect(await sweep(p)).toBe(1);
      expect(await sweep(p)).toBe(0);
    });

    test('a retired or rejected node that was already announced offline is not announced again, and a retire clears the notice', async () => {
      const { clock } = rig();
      const p = await reported();
      clock.advance(400);
      expect(await sweep(p)).toBe(1);
      await adminConfirmed(p.h, 'POST', `/v1/nodes/${ID}/retire`, 1);
      expect((await p.store.findNode(ID))?.offlineNotifiedAt).toBeNull();
      clock.advance(86_400);
      expect(await sweep(p)).toBe(0);
      expect(countOf(await eventKinds(p.store, ID), 'offline')).toBe(1);
    });

    /** One simulated node: what the model believes about its outages. */
    interface Model {
      lastSeen: number;
      notified: boolean;
      offline: number;
      recovered: number;
    }

    /** The node reports (or not); a report after a notice is a recovery. */
    async function maybeReport(
      p: ControllerProcess,
      sim: SimNode,
      model: Model,
      report: boolean
    ): Promise<void> {
      if (!report) return;
      await sim.beat(p.h);
      model.lastSeen = rig().clock.now().getTime();
      if (!model.notified) return;
      model.recovered += 1;
      model.notified = false;
    }

    /** After a sweep: silence beyond the threshold is announced exactly once, and status agrees. */
    async function settle(
      p: ControllerProcess,
      n: number,
      model: Model,
      step: number
    ): Promise<void> {
      const silentFor = (rig().clock.now().getTime() - model.lastSeen) / 1000;
      if (silentFor > 300 && !model.notified) {
        model.notified = true;
        model.offline += 1;
      }
      const status = await statusOf(p, n);
      expect([step, n, status === 'offline']).toEqual([
        step,
        n,
        silentFor > 300,
      ]);
    }

    for (const seed of [3, 11, 77, 1234, 99999]) {
      test(`seed ${seed}: notices and recoveries match the outages a model of the clock predicts`, async () => {
        const rng = prng(seed);
        const p = await rig().boot();
        const start = rig().clock.now().getTime();
        const nodes = [1, 2];
        const sims = new Map(nodes.map((n) => [n, simNode(n)]));
        const models = new Map<number, Model>();
        for (const n of nodes) {
          await enrollCi(p.h, n);
          await sims.get(n)?.beat(p.h);
          models.set(n, {
            lastSeen: start,
            notified: false,
            offline: 0,
            recovered: 0,
          });
        }
        for (let step = 0; step < 120; step += 1) {
          rig().clock.advance(1 + rng.int(rng.chance(0.2) ? 900 : 60));
          for (const n of nodes)
            await maybeReport(
              p,
              sims.get(n) as SimNode,
              models.get(n) as Model,
              rng.chance(0.6)
            );
          await sweep(p);
          for (const n of nodes)
            await settle(p, n, models.get(n) as Model, step);
        }
        for (const n of nodes) {
          const model = models.get(n) as Model;
          const kinds = await eventKinds(p.store, nodeIdOf(n));
          expect(countOf(kinds, 'offline')).toBe(model.offline);
          expect(countOf(kinds, 'recovered')).toBe(model.recovered);
          expect(model.offline - model.recovered).toBe(model.notified ? 1 : 0);
        }
      });
    }
  }
);
