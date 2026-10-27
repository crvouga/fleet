import { expect, test } from 'bun:test';

import { HEARTBEAT_RETENTION_MS, runPrune } from '../../src/jobs/prune';
import { startJobs, DEFAULT_TIMINGS } from '../../src/jobs/scheduler';
import type { JobDeps } from '../../src/jobs/offline-notifier';
import type { Store } from '../../src/store';
import { Clock, silent } from '../support/api';
import { describeStore } from '../support/describe-store';
import { recordingLogger } from '../support/recording-logger';
import {
  T0,
  heartbeatBody,
  nodeIdOf,
  registerInput,
} from '../support/fixtures';

const DAY = 24 * 3600;
const noFetch = (async () => new Response('ok')) as unknown as typeof fetch;

async function waitFor(
  check: () => Promise<boolean> | boolean,
  ms = 3000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error('condition was not met in time');
}

describeStore('prune job', (ctx) => {
  test('keeps seven days, deletes older, and says how many', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    const deps: JobDeps = {
      store,
      now: clock.now,
      fetch: noFetch,
      log: silent,
    };
    await store.registerNode(
      registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
    );
    const beat = (seconds: number) =>
      store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1),
        null,
        new Date(T0.getTime() + seconds * 1000)
      );
    await beat(-8 * DAY);
    await beat(-7 * DAY - 1);
    await beat(-7 * DAY);
    await beat(-DAY);
    await beat(0);
    expect(HEARTBEAT_RETENTION_MS).toBe(7 * DAY * 1000);
    expect(await runPrune(deps)).toBe(2);
    const left = await store.listHeartbeats(
      nodeIdOf(1),
      new Date(T0.getTime() - 30 * DAY * 1000)
    );
    expect(left).toHaveLength(3);
    expect(left[0]?.at.getTime()).toBe(T0.getTime() - 7 * DAY * 1000);
    expect(await runPrune(deps)).toBe(0);
  });

  test('leaves events and settings history alone', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    await store.putSettings('fleet', { sync: { paused: true } }, 'chris');
    await store.addEvent({
      nodeId: null,
      nodeLabel: null,
      kind: 'old',
      severity: 'info',
      message: 'm',
    });
    clock.advance(400 * DAY);
    await runPrune({ store, now: clock.now, fetch: noFetch, log: silent });
    expect(await store.listEvents({ limit: 10 })).toHaveLength(1);
    expect(await store.settingsHistory('fleet', 10)).toHaveLength(1);
  });
});

describeStore('job scheduler', (ctx) => {
  test('runs the sweep on its interval once the grace period has passed', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    await store.registerNode(
      registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
    );
    await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, T0);
    clock.advance(1000);
    const jobs = startJobs(
      { store, now: clock.now, fetch: noFetch, log: silent },
      { sweepEveryMs: 20, pruneEveryMs: 60_000, graceMs: 5000 }
    );
    try {
      await Bun.sleep(120);
      expect(
        (await store.listEvents({ limit: 50 })).filter(
          (e) => e.kind === 'offline'
        )
      ).toHaveLength(0);
      clock.advance(5000);
      await waitFor(async () =>
        (await store.listEvents({ limit: 50 })).some(
          (e) => e.kind === 'offline'
        )
      );
      await Bun.sleep(100);
      expect(
        (await store.listEvents({ limit: 50 })).filter(
          (e) => e.kind === 'offline'
        )
      ).toHaveLength(1);
    } finally {
      jobs.stop();
    }
  });

  test('prunes as soon as it starts', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    await store.registerNode(
      registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
    );
    await store.recordHeartbeat(
      nodeIdOf(1),
      heartbeatBody(1),
      null,
      new Date(T0.getTime() - 9 * DAY * 1000)
    );
    const jobs = startJobs(
      { store, now: clock.now, fetch: noFetch, log: silent },
      { sweepEveryMs: 60_000, pruneEveryMs: 60_000, graceMs: 0 }
    );
    try {
      await waitFor(
        async () =>
          (await store.listHeartbeats(nodeIdOf(1), new Date(0))).length === 0
      );
    } finally {
      jobs.stop();
    }
  });

  test('stop() ends both timers', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    let sweeps = 0;
    const counting = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'listSettings') {
          return async () => {
            sweeps += 1;
            return target.listSettings();
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const jobs = startJobs(
      { store: counting, now: clock.now, fetch: noFetch, log: silent },
      { sweepEveryMs: 10, pruneEveryMs: 60_000, graceMs: 0 }
    );
    await waitFor(() => sweeps >= 2);
    jobs.stop();
    await Bun.sleep(50);
    const settled = sweeps;
    await Bun.sleep(100);
    expect(sweeps).toBe(settled);
  });

  test('a sweep that is still running is not started again', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    let running = 0;
    let overlapped = false;
    let finished = 0;
    const slow = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'listSettings') {
          return async () => {
            running += 1;
            overlapped ||= running > 1;
            await Bun.sleep(60);
            running -= 1;
            finished += 1;
            return target.listSettings();
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const jobs = startJobs(
      { store: slow, now: clock.now, fetch: noFetch, log: silent },
      { sweepEveryMs: 10, pruneEveryMs: 60_000, graceMs: 0 }
    );
    await waitFor(() => finished >= 2);
    jobs.stop();
    expect(overlapped).toBe(false);
  });

  test('a job that throws is logged and the next tick still runs', async () => {
    const { store } = ctx();
    const clock = new Clock(T0);
    const log = recordingLogger();
    let calls = 0;
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'listSettings') {
          return async () => {
            calls += 1;
            if (calls === 1) throw new Error('database went away');
            return target.listSettings();
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Store;
    const jobs = startJobs(
      { store: failing, now: clock.now, fetch: noFetch, log },
      { sweepEveryMs: 10, pruneEveryMs: 60_000, graceMs: 0 }
    );
    await waitFor(() => calls >= 3);
    jobs.stop();
    expect(
      log.lines.some(
        (line) =>
          line.includes('background job failed') &&
          line.includes('offline-notifier')
      )
    ).toBe(true);
  });

  test('defaults: sweep every 30 s, prune every hour, two minutes of grace', () => {
    expect(DEFAULT_TIMINGS).toEqual({
      sweepEveryMs: 30_000,
      pruneEveryMs: 3_600_000,
      graceMs: 120_000,
    });
  });
});
