import { describe, expect, test } from 'bun:test';

import type { PgStore } from '../../src/db/pg-store';
import { runOfflineSweep, type JobDeps } from '../../src/jobs/offline-notifier';
import { postWebhook } from '../../src/jobs/webhook';
import { Clock, silent } from '../support/api';
import { describeStore } from '../support/describe-store';
import {
  T0,
  heartbeatBody,
  nodeIdOf,
  registerInput,
} from '../support/fixtures';
import { recordingLogger } from '../support/recording-logger';

interface Post {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly redirect: string | undefined;
}

type Reply = 'ok' | 'error' | 'throw' | 'redirect';

function webhookRecorder(reply: () => Reply = () => 'ok') {
  const posts: Post[] = [];
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    posts.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: { ...(init?.headers as Record<string, string>) },
      redirect: init?.redirect,
    });
    const mode = reply();
    if (mode === 'throw') throw new Error('connection refused');
    if (mode === 'error') return new Response('no', { status: 500 });
    if (mode === 'redirect')
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/' },
      });
    return new Response('ok');
  }) as unknown as typeof fetch;
  return { posts, fetch: fakeFetch };
}

async function enroll(
  store: PgStore,
  n: number,
  role: 'ci' | 'web' = 'ci'
): Promise<void> {
  await store.registerNode(
    registerInput(n, { role, approval: 'approved', enrolledVia: 'role-token' })
  );
}

describeStore('offline notifier', (ctx) => {
  function setup(reply?: () => Reply, log = silent) {
    const clock = new Clock(T0);
    const recorder = webhookRecorder(reply);
    const deps: JobDeps = {
      store: ctx().store,
      now: clock.now,
      fetch: recorder.fetch,
      log,
    };
    return { clock, deps, posts: recorder.posts };
  }

  async function report(store: PgStore, clock: Clock, n = 1): Promise<void> {
    const role = (await store.findNode(nodeIdOf(n)))?.role ?? 'ci';
    await store.recordHeartbeat(
      nodeIdOf(n),
      heartbeatBody(n, { role }),
      null,
      clock.now()
    );
  }

  async function offlineEvents(store: PgStore) {
    return (await store.listEvents({ limit: 100 })).filter(
      (e) => e.kind === 'offline'
    );
  }

  test('announces a node once it has been silent for more than five minutes', async () => {
    const { store } = ctx();
    const { clock, deps } = setup();
    await enroll(store, 1);
    await report(store, clock);
    clock.advance(300);
    expect(await runOfflineSweep(deps)).toBe(0);
    clock.advance(1);
    expect(await runOfflineSweep(deps)).toBe(1);
    const [event] = await offlineEvents(store);
    expect(event).toMatchObject({
      severity: 'error',
      nodeId: nodeIdOf(1),
      nodeLabel: `ci-${nodeIdOf(1).slice(0, 4)}`,
    });
    expect(event?.message).toBe(
      `ci-${nodeIdOf(1).slice(0, 4)} has not reported for 301 seconds`
    );
    expect(event?.data).toMatchObject({ silentSeconds: 301 });
    expect((await store.findNode(nodeIdOf(1)))?.offlineNotifiedAt).toEqual(
      clock.now()
    );
  });

  test('one outage is one notice, however many sweeps see it', async () => {
    const { store } = ctx();
    const { clock, deps, posts } = setup();
    await store.putSettings(
      'fleet',
      { alerts: { webhookUrl: 'https://hooks.example/fleet' } },
      'chris'
    );
    await enroll(store, 1);
    await report(store, clock);
    clock.advance(400);
    const counts: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      counts.push(await runOfflineSweep(deps));
      clock.advance(30);
    }
    expect(counts).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await offlineEvents(store)).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  test('a report ends the outage with a recovered event, and a second outage is a second notice', async () => {
    const { store } = ctx();
    const { clock, deps } = setup();
    await enroll(store, 1);
    await report(store, clock);
    clock.advance(400);
    await runOfflineSweep(deps);
    clock.advance(100);
    await report(store, clock);
    expect((await store.findNode(nodeIdOf(1)))?.offlineNotifiedAt).toBeNull();
    expect(await runOfflineSweep(deps)).toBe(0);
    clock.advance(400);
    expect(await runOfflineSweep(deps)).toBe(1);
    const kinds = (await store.listEvents({ limit: 100 }))
      .map((e) => e.kind)
      .reverse()
      .filter((k) => k === 'offline' || k === 'recovered');
    expect(kinds).toEqual(['offline', 'recovered', 'offline']);
  });

  test('only approved nodes are announced', async () => {
    const { store } = ctx();
    const { clock, deps } = setup();
    await store.registerNode(registerInput(1));
    await enroll(store, 2);
    await enroll(store, 3);
    await enroll(store, 4);
    await enroll(store, 5);
    for (const n of [2, 3, 4, 5]) await report(store, clock, n);
    await store.setApproval(nodeIdOf(3), 'rejected', 'x');
    await store.setApproval(nodeIdOf(4), 'retired', 'x');
    clock.advance(10_000);
    expect(await runOfflineSweep(deps)).toBe(2);
    const labelled = (await offlineEvents(store)).map((e) => e.nodeId).sort();
    expect(labelled).toEqual([nodeIdOf(2), nodeIdOf(5)].sort());
  });

  test('a node that retired itself stops being announced', async () => {
    const { store } = ctx();
    const { clock, deps } = setup();
    await enroll(store, 1);
    await report(store, clock);
    await store.setApproval(nodeIdOf(1), 'retired', 'node:1234');
    clock.advance(10_000);
    expect(await runOfflineSweep(deps)).toBe(0);
  });

  test('alerts.offlineAfterSeconds is honoured at fleet, role and node scope', async () => {
    const { store } = ctx();
    const { clock, deps } = setup();
    await store.putSettings(
      'fleet',
      { alerts: { offlineAfterSeconds: 120 } },
      'a'
    );
    await store.putSettings(
      'role:web',
      { alerts: { offlineAfterSeconds: 600 } },
      'a'
    );
    await store.putSettings(
      `node:${nodeIdOf(3)}`,
      { alerts: { offlineAfterSeconds: 3600 } },
      'a'
    );
    await enroll(store, 1, 'ci');
    await enroll(store, 2, 'web');
    await enroll(store, 3, 'ci');
    for (const n of [1, 2, 3]) await report(store, clock, n);
    clock.advance(130);
    expect(await runOfflineSweep(deps)).toBe(1);
    clock.advance(500);
    expect(await runOfflineSweep(deps)).toBe(1);
    clock.advance(3000);
    expect(await runOfflineSweep(deps)).toBe(1);
    expect((await offlineEvents(store)).map((e) => e.nodeId).reverse()).toEqual(
      [nodeIdOf(1), nodeIdOf(2), nodeIdOf(3)]
    );
  });

  describe('webhook', () => {
    test('posts a json notice to the https url from the settings', async () => {
      const { store } = ctx();
      const { clock, deps, posts } = setup();
      await store.putSettings(
        'fleet',
        { alerts: { webhookUrl: 'https://hooks.example/fleet' } },
        'a'
      );
      await enroll(store, 1);
      await report(store, clock);
      clock.advance(400);
      await runOfflineSweep(deps);
      expect(posts).toHaveLength(1);
      const [post] = posts;
      expect(post?.url).toBe('https://hooks.example/fleet');
      expect(post?.redirect).toBe('manual');
      expect(post?.headers['Content-Type']).toBe('application/json');
      expect(post?.body).toMatchObject({
        kind: 'offline',
        node: {
          id: nodeIdOf(1),
          role: 'ci',
          hostname: `ci-${nodeIdOf(1).slice(0, 4)}`,
        },
        lastSeenAt: T0.toISOString(),
        at: clock.now().toISOString(),
      });
      expect(String(post?.body['text'])).toContain('is offline');
      expect(JSON.stringify(post)).not.toContain('secret');
    });

    test('a node or role document can change the url or switch it off', async () => {
      const { store } = ctx();
      const { clock, deps, posts } = setup();
      await store.putSettings(
        'fleet',
        { alerts: { webhookUrl: 'https://hooks.example/fleet' } },
        'a'
      );
      await store.putSettings(
        'role:web',
        { alerts: { webhookUrl: 'https://hooks.example/web' } },
        'a'
      );
      await store.putSettings(
        `node:${nodeIdOf(3)}`,
        { alerts: { webhookUrl: null } },
        'a'
      );
      await enroll(store, 1, 'ci');
      await enroll(store, 2, 'web');
      await enroll(store, 3, 'ci');
      for (const n of [1, 2, 3]) await report(store, clock, n);
      clock.advance(400);
      expect(await runOfflineSweep(deps)).toBe(3);
      expect(posts.map((p) => p.url).sort()).toEqual([
        'https://hooks.example/fleet',
        'https://hooks.example/web',
      ]);
    });

    test('no webhook configured means no request', async () => {
      const { store } = ctx();
      const { clock, deps, posts } = setup();
      await enroll(store, 1);
      await report(store, clock);
      clock.advance(400);
      await runOfflineSweep(deps);
      expect(posts).toEqual([]);
    });

    test('a failing webhook never crashes the sweep and still counts as one notice', async () => {
      for (const reply of ['throw', 'error', 'redirect'] as const) {
        await ctx().db.reset();
        const { store } = ctx();
        const log = recordingLogger();
        const { clock, deps, posts } = setup(() => reply, log);
        await store.putSettings(
          'fleet',
          { alerts: { webhookUrl: 'https://hooks.example/fleet' } },
          'a'
        );
        await enroll(store, 1);
        await report(store, clock);
        clock.advance(400);
        expect(await runOfflineSweep(deps)).toBe(1);
        clock.advance(60);
        expect(await runOfflineSweep(deps)).toBe(0);
        expect(posts).toHaveLength(1);
        expect(await offlineEvents(store)).toHaveLength(1);
        expect(log.lines.some((line) => line.includes('webhook'))).toBe(true);
      }
    });

    test('a webhook that is not https is never contacted', async () => {
      const { store } = ctx();
      const { clock, deps, posts } = setup();
      await store.putSettings(
        'fleet',
        { alerts: { webhookUrl: 'http://hooks.example/plain' } },
        'a'
      );
      await enroll(store, 1);
      await report(store, clock);
      clock.advance(400);
      expect(await runOfflineSweep(deps)).toBe(1);
      expect(posts).toEqual([]);
    });
  });

  test('one node failing to be announced does not stop the others', async () => {
    const { store } = ctx();
    const { clock, deps } = setup();
    await enroll(store, 1);
    await enroll(store, 2);
    for (const n of [1, 2]) await report(store, clock, n);
    clock.advance(400);
    const log = recordingLogger();
    const flaky = {
      ...deps,
      log,
      store: new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'addEvent') {
            return async (event: { nodeId: string | null }) => {
              if (event.nodeId === nodeIdOf(1))
                throw new Error('database hiccup');
              return target.addEvent(event as never);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    };
    expect(await runOfflineSweep(flaky)).toBe(1);
    expect((await offlineEvents(store)).map((e) => e.nodeId)).toEqual([
      nodeIdOf(2),
    ]);
    expect(
      log.lines.some((line) => line.includes('offline notice failed'))
    ).toBe(true);
  });
});

describe('postWebhook', () => {
  test('refuses non-https urls without making a request', async () => {
    const recorder = webhookRecorder();
    for (const url of [
      'http://x.example/',
      'ftp://x.example/',
      'not a url',
      '',
      'javascript:alert(1)',
    ]) {
      expect(
        await postWebhook({ fetch: recorder.fetch, log: silent }, url, {})
      ).toBe(false);
    }
    expect(recorder.posts).toEqual([]);
  });

  test('gives up on an endpoint that never answers', async () => {
    const hang = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(
      await postWebhook(
        { fetch: hang, log: silent, timeoutMs: 100 },
        'https://slow.example/',
        {}
      )
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('true only for a 2xx answer', async () => {
    expect(
      await postWebhook(
        { fetch: webhookRecorder(() => 'ok').fetch, log: silent },
        'https://x.example/',
        {}
      )
    ).toBe(true);
    expect(
      await postWebhook(
        { fetch: webhookRecorder(() => 'error').fetch, log: silent },
        'https://x.example/',
        {}
      )
    ).toBe(false);
  });
});
