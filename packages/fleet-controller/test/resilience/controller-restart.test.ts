import { expect, test } from 'bun:test';

import { runOfflineSweep, type JobDeps } from '../../src/jobs/offline-notifier';
import { startJobs } from '../../src/jobs/scheduler';
import { desiredRevision } from '../../src/domain/desired-state';
import { adminConfirmed } from '../support/confirm';
import { silent } from '../support/controller';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

import { countOf, eventKinds, snapshot } from './support/probe';
import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode } from './support/sim-node';

const noNetwork = (async () => {
  throw new Error('no network in this test');
}) as unknown as typeof fetch;

const jobDeps = (p: ControllerProcess, clock: { now(): Date }): JobDeps => ({
  store: p.store,
  now: clock.now,
  fetch: noNetwork,
  log: silent,
});

const waitFor = async (condition: () => Promise<boolean>): Promise<boolean> => {
  for (let i = 0; i < 100; i += 1) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeRig('Resilience (Req 11): controller restart and outage', (rig) => {
  test('a crash loses nothing and a reopened controller records no duplicate events', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    await first.h.register(2); // stays pending
    const a = simNode(1);
    await a.settle(first.h);
    clock.advance(60);
    const rebooted = { revision: '1'.repeat(40), bootId: 'boot-2' };
    await a.beat(first.h, rebooted);
    await first.h.admin('PUT', '/v1/settings/fleet', {
      disk: { alertPercent: 80 },
    });
    await first.h.admin('PATCH', `/v1/nodes/${nodeIdOf(2)}`, {
      note: 'rack 4',
    });
    const before = await snapshot(first.store);
    await first.crash();

    const second = await rig().boot();
    expect(await snapshot(second.store)).toEqual(before);
    // Credentials survive: no re-registration, and the pending node still is.
    const reply = await a.beat(second.h, rebooted);
    expect(reply.status).toBe(200);
    expect((await second.store.findNode(nodeIdOf(2)))?.approval).toBe(
      'pending'
    );
    const kinds = await eventKinds(second.store, nodeIdOf(1));
    expect(countOf(kinds, 'registered')).toBe(1);
    expect(countOf(kinds, 'approved')).toBe(1);
    expect(countOf(kinds, 'boot')).toBe(1);
    expect(countOf(kinds, 'revision')).toBe(1);
  });

  test('settings written before a crash are served from the database, byte for byte, to a node after it', async () => {
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    await first.h.admin('PUT', '/v1/settings/fleet', {
      sync: { paused: false },
      heartbeat: { intervalSeconds: 30 },
    });
    await first.h.admin('PUT', '/v1/settings/role:ci', {
      runners: { cordoned: false },
    });
    const wanted = (
      await first.h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1))
    ).body.desired;
    await first.crash();
    const second = await rig().boot();
    const again = await second.h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1)
    );
    expect(again.body.desired).toEqual(wanted);
    expect(desiredRevision(again.body.desired)).toBe(wanted.revision);
  });

  test('a drain survives a restart: it is re-delivered as desired state and completes from observation', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    const node = simNode(1);
    await node.settle(first.h);
    const started = await first.h.admin(
      'POST',
      `/v1/nodes/${nodeIdOf(1)}/drain`,
      { reason: 'rack move' }
    );
    expect(started.status).toBe(202);
    const id: string = started.body.operation.id;
    await first.crash();

    // Controller is down: the node's heartbeat fails, and it keeps its last config.
    expect((await node.beat(first.h)).status).toBe(500);
    clock.advance(300);

    const second = await rig().boot();
    expect(
      (await second.h.admin('GET', `/v1/operations/${id}`)).body.operation
        .status
    ).toBe('pending');
    // The next heartbeat gets the cordon (level-triggered), not a delta.
    const delivered = await node.beat(second.h, {
      runners: { slots: 4, busy: 2 },
    });
    expect(delivered.body.desired.values.runners.cordoned).toBe(true);
    await node.beat(second.h, { runners: { slots: 4, busy: 2 } });
    expect(
      (await second.h.admin('GET', `/v1/operations/${id}`)).body.operation
        .status
    ).toBe('in_progress');
    await node.beat(second.h, { runners: { slots: 4, busy: 0 } });
    expect(
      (await second.h.admin('GET', `/v1/operations/${id}`)).body.operation
        .status
    ).toBe('succeeded');
    const events = await eventKinds(second.store, nodeIdOf(1));
    expect(countOf(events, 'operation_succeeded')).toBe(1);
    expect(countOf(events, 'operation_started')).toBe(1);
  });

  test('a restart operation spanning a controller outage completes only on the new boot id', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    const node = simNode(1);
    await node.settle(first.h, { bootId: 'boot-0', uptimeSeconds: 90_000 });
    clock.advance(60);
    const started = await adminConfirmed(
      first.h,
      'POST',
      `/v1/nodes/${nodeIdOf(1)}/restart`,
      1
    );
    expect(started.status).toBe(202);
    const id: string = started.body.operation.id;
    await first.crash();
    clock.advance(240);

    const second = await rig().boot();
    await node.settle(second.h, { bootId: 'boot-0', uptimeSeconds: 90_300 });
    expect(
      (await second.h.admin('GET', `/v1/operations/${id}`)).body.operation
        .status
    ).toBe('in_progress');
    clock.advance(120);
    await node.settle(second.h, { bootId: 'boot-1', uptimeSeconds: 30 });
    expect(
      (await second.h.admin('GET', `/v1/operations/${id}`)).body.operation
        .status
    ).toBe('succeeded');
  });

  test('a heartbeat in flight when the controller dies is either stored once or not at all, and the next one converges', async () => {
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    const node = simNode(1);
    await node.settle(first.h, { bootId: 'boot-1' });
    const inFlight = node.beat(first.h, {
      bootId: 'boot-2',
      revision: '2'.repeat(40),
    });
    const dying = first.crash();
    const reply = await inFlight;
    await dying;
    expect([200, 500]).toContain(reply.status);

    const second = await rig().boot();
    await second.h.admin('PUT', '/v1/settings/fleet', {
      sync: { paused: true },
    });
    // Whether or not the interrupted report landed, resending it converges.
    node.applied = null;
    const resent = await node.settle(second.h, {
      bootId: 'boot-2',
      revision: '2'.repeat(40),
    });
    expect(resent.status).toBe(200);
    const stored = await second.store.findNode(nodeIdOf(1));
    expect(stored?.facts['bootId']).toBe('boot-2');
    const kinds = await eventKinds(second.store, nodeIdOf(1));
    expect(countOf(kinds, 'boot')).toBe(1);
    expect(countOf(kinds, 'revision')).toBe(1);
    const wanted = (await second.h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`))
      .body.node;
    expect(wanted.appliedRevision).toBe(wanted.desiredRevision);
  });

  test('one outage is one notice, even when the controller restarts in the middle of it', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    await simNode(1).settle(first.h);
    clock.advance(400);
    expect(await runOfflineSweep(jobDeps(first, clock))).toBe(1);
    expect(await runOfflineSweep(jobDeps(first, clock))).toBe(0);
    await first.crash();

    clock.advance(3600);
    const second = await rig().boot();
    expect(await runOfflineSweep(jobDeps(second, clock))).toBe(0);
    expect(
      countOf(await eventKinds(second.store, nodeIdOf(1)), 'offline')
    ).toBe(1);
    // It comes back: recovered exactly once.
    await simNode(1).settle(second.h);
    const kinds = await eventKinds(second.store, nodeIdOf(1));
    expect(countOf(kinds, 'recovered')).toBe(1);
    expect(countOf(kinds, 'offline')).toBe(1);
  });

  test('no offline notice for the first two minutes after the process starts, then the sweep resumes', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    await simNode(1).settle(first.h);
    await first.crash();
    clock.advance(900); // the controller was away for a quarter of an hour

    const second = await rig().boot();
    const jobs = startJobs(jobDeps(second, clock), {
      sweepEveryMs: 2,
      pruneEveryMs: 3_600_000,
      graceMs: 120_000,
    });
    try {
      await pause(40);
      clock.advance(119);
      await pause(40);
      expect(countOf(await eventKinds(second.store), 'offline')).toBe(0);
      clock.advance(2);
      const announced = await waitFor(
        async () => countOf(await eventKinds(second.store), 'offline') === 1
      );
      expect(announced).toBe(true);
      await pause(30);
      expect(countOf(await eventKinds(second.store), 'offline')).toBe(1);
    } finally {
      jobs.stop();
    }
  });

  test('a node that reports during the grace window is never announced', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    const node = simNode(1);
    await node.settle(first.h);
    await first.crash();
    clock.advance(900);
    const second = await rig().boot();
    const jobs = startJobs(jobDeps(second, clock), {
      sweepEveryMs: 2,
      pruneEveryMs: 3_600_000,
      graceMs: 120_000,
    });
    try {
      await node.beat(second.h);
      clock.advance(200);
      await pause(40);
      const kinds = await eventKinds(second.store, nodeIdOf(1));
      expect(countOf(kinds, 'offline')).toBe(0);
      expect(countOf(kinds, 'recovered')).toBe(0);
    } finally {
      jobs.stop();
    }
  });

  test('an operation whose whole timeout elapsed during the outage fails once the sweep resumes, not before the grace ends', async () => {
    const { clock } = rig();
    const first = await rig().boot();
    await enrollCi(first.h, 1);
    await simNode(1).settle(first.h);
    const started = await first.h.admin(
      'POST',
      `/v1/nodes/${nodeIdOf(1)}/drain`,
      { timeoutSeconds: 600 }
    );
    const id: string = started.body.operation.id;
    await first.crash();
    clock.advance(3600);

    const second = await rig().boot();
    const jobs = startJobs(jobDeps(second, clock), {
      sweepEveryMs: 2,
      pruneEveryMs: 3_600_000,
      graceMs: 120_000,
    });
    try {
      await pause(40);
      const status = async () =>
        (await second.h.admin('GET', `/v1/operations/${id}`)).body.operation
          .status;
      expect(await status()).toBe('pending'); // inside the grace window nothing is decided
      clock.advance(121);
      expect(await waitFor(async () => (await status()) === 'failed')).toBe(
        true
      );
      const kinds = await eventKinds(second.store, nodeIdOf(1));
      expect(countOf(kinds, 'operation_failed')).toBe(1);
    } finally {
      jobs.stop();
    }
  });
});
