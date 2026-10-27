import { describe, expect, test } from 'bun:test';

import { createDb } from '../../src/db/client';
import { PgStore } from '../../src/db/pg-store';
import type { Store } from '../../src/store';
import {
  ADMIN_TOKEN,
  CI_ROLE_TOKEN,
  createHarness,
  silent,
} from '../support/api';
import { startCluster } from '../support/cluster';
import { databaseAvailable } from '../support/database';
import { describeApi } from '../support/describe-api';
import { recordingLogger } from '../support/recording-logger';
import { heartbeatBody, nodeIdOf, secretOf } from '../support/fixtures';
import { findTooling } from '../support/tooling';

const KIB = 1024;

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 16 * KIB)
        controller.enqueue(bytes.slice(i, i + 16 * KIB));
      controller.close();
    },
  });
}

describeApi('request size', (ctx) => {
  const withPadding = (bytes: number) =>
    JSON.stringify({ ...heartbeatBody(1), junk: 'x'.repeat(bytes) });

  test('a body of exactly 64 KiB is accepted', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const base = withPadding(0).length;
    const body = withPadding(64 * KIB - base);
    expect(new TextEncoder().encode(body).length).toBe(64 * KIB);
    const reply = await h.call('POST', '/v1/heartbeat', {
      headers: {
        Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(1)}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    expect(reply.status).toBe(200);
  });

  test('one byte more is a 413 with the standard error shape', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const body = withPadding(64 * KIB - withPadding(0).length + 1);
    const reply = await h.call('POST', '/v1/heartbeat', {
      headers: {
        Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(1)}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    expect(reply.status).toBe(413);
    expect(reply.body).toEqual({
      error: 'payload_too_large',
      message: 'The body may be at most 64 KiB.',
    });
  });

  test('is enforced on every body-taking route, with or without a Content-Length', async () => {
    const { h } = ctx();
    const huge = JSON.stringify({ filler: 'y'.repeat(70 * KIB) });
    const routes: [string, string][] = [
      ['POST', '/v1/nodes/register'],
      ['POST', '/v1/heartbeat'],
      ['POST', '/v1/retire'],
      ['PUT', '/v1/settings/fleet'],
      ['PATCH', `/v1/nodes/${nodeIdOf(1)}`],
    ];
    for (const [method, path] of routes) {
      const headers = {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      };
      const sized = await h.call(method, path, { headers, body: huge });
      expect(sized.status).toBe(413);
      const res = await h.app.request(path, {
        method,
        headers,
        body: streamOf(huge),
        duplex: 'half',
      } as RequestInit);
      expect(res.status).toBe(413);
    }
  });

  test('is checked before authentication, so an anonymous flood costs nothing', async () => {
    const reply = await ctx().h.call('PUT', '/v1/settings/fleet', {
      body: 'x'.repeat(70 * KIB),
    });
    expect(reply.status).toBe(413);
  });

  test('does not apply to reads', async () => {
    expect((await ctx().h.admin('GET', '/v1/nodes')).status).toBe(200);
  });
});

describeApi('malformed bodies', (ctx) => {
  test('every route that reads JSON answers 400 rather than failing', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const node = { Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(1)}` };
    const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const cases: [string, string, Record<string, string>][] = [
      ['POST', '/v1/nodes/register', {}],
      ['POST', '/v1/heartbeat', node],
      ['PATCH', `/v1/nodes/${nodeIdOf(1)}`, admin],
      ['PUT', '/v1/settings/fleet', admin],
    ];
    for (const [method, path, headers] of cases) {
      for (const body of [
        '{',
        '',
        'null',
        '"text"',
        '[1',
        '{"a":}',
        'undefined',
        '\u0000',
      ]) {
        const reply = await h.call(method, path, { headers, body });
        expect(reply.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(
          400
        );
        expect(reply.body.error).toMatch(/^invalid_/);
      }
    }
  });

  test('deeply nested json is only data', async () => {
    const { h } = ctx();
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    const reply = await h.call('PUT', '/v1/settings/fleet', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: deep,
    });
    expect(reply.status).toBe(400);
  });

  test('prototype-pollution shaped keys are refused or ignored', async () => {
    const { h } = ctx();
    const reply = await h.call('PUT', '/v1/settings/fleet', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: '{"__proto__":{"polluted":true},"constructor":{"x":1}}',
    });
    expect(reply.status).toBe(400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describeApi('failures inside the server', (ctx) => {
  test('an unexpected error is a 500 in the standard shape that leaks nothing', async () => {
    const { store } = ctx();
    const log = recordingLogger();
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'listNodes')
          return async () =>
            Promise.reject(
              new Error('relation "secret_table" exploded: password=hunter2')
            );
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Store;
    const h = createHarness(broken, { api: { log } });
    const reply = await h.admin('GET', '/v1/nodes');
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      error: 'internal',
      message: 'Something went wrong on the server.',
    });
    expect(reply.text).not.toContain('hunter2');
    expect(log.lines.some((line) => line.includes('unhandled error'))).toBe(
      true
    );
  });
});

describeApi('logging', (ctx) => {
  test('never records request bodies, tokens, secrets or cookies', async () => {
    const { store } = ctx();
    const log = recordingLogger();
    const h = createHarness(store, { api: { log } });
    const marker = 'BODY-MARKER-4f1c9';
    await h.register(1, {
      roleToken: CI_ROLE_TOKEN,
      hostname: 'ci-1234',
      note: marker,
    });
    await h.register(2, { roleToken: 'wrong-role-token-value' });
    await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, {
        events: [{ kind: 'k', severity: 'info', message: marker }],
      })
    );
    await h.asNode(1, 'POST', '/v1/heartbeat', {
      ...heartbeatBody(1),
      load1: 'bad',
      marker,
    });
    await h.call('PUT', '/v1/settings/fleet', {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        Cookie: 'fleet_session=cookie-marker',
      },
      json: { alerts: { webhookUrl: 'https://hooks.example/path-marker' } },
    });
    await h.call('GET', '/v1/nodes', {
      headers: { Authorization: 'Bearer wrong-admin-guess' },
    });
    await h.call('POST', '/v1/heartbeat', { body: marker });
    const logged = log.lines.join('\n');
    expect(logged.length).toBeGreaterThan(100);
    for (const secret of [
      secretOf(1),
      secretOf(2),
      CI_ROLE_TOKEN,
      'wrong-role-token-value',
      ADMIN_TOKEN,
      'wrong-admin-guess',
      'cookie-marker',
      marker,
      'path-marker',
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('"method":"POST"');
    expect(logged).toContain('"route":"/v1/heartbeat"');
    expect(logged).toContain('"requestId":');
  });
});

describe('health', () => {
  const quiet = { log: silent };
  const failing = (health: () => Promise<void>): Store =>
    ({ health }) as unknown as Store;

  test('200 { ok: true } with no credentials when the database answers', async () => {
    const h = createHarness(
      failing(async () => undefined),
      { api: quiet }
    );
    const reply = await h.call('GET', '/health');
    expect(reply).toMatchObject({ status: 200, body: { ok: true } });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect((await h.call('HEAD', '/health')).status).toBe(200);
  });

  test('503 when the database refuses', async () => {
    const h = createHarness(
      failing(async () => Promise.reject(new Error('connection refused'))),
      { api: quiet }
    );
    const reply = await h.call('GET', '/health');
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ ok: false, error: 'database_unavailable' });
    expect(reply.text).not.toContain('refused');
  });

  test('503 when the database does not answer in time', async () => {
    const h = createHarness(
      failing(() => new Promise<void>(() => undefined)),
      { api: { ...quiet, healthTimeoutMs: 80 } }
    );
    const started = Date.now();
    const reply = await h.call('GET', '/health');
    expect(reply.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test.skipIf(!databaseAvailable)(
    'a real database that is stopped gives 503, and 200 again once it is back',
    async () => {
      const tooling = findTooling();
      if (tooling === null) return;
      const cluster = await startCluster(tooling);
      const db = createDb({ url: cluster.url(await cluster.createDatabase()) });
      try {
        const h = createHarness(new PgStore(db), {
          api: { ...quiet, healthTimeoutMs: 2500 },
        });
        expect((await h.call('GET', '/health')).status).toBe(200);
        cluster.stop();
        expect((await h.call('GET', '/health')).status).toBe(503);
        const register = await h.register(1);
        expect(register.status).toBe(500);
        expect(register.body.error).toBe('internal');
        cluster.start();
        let status = 0;
        const deadline = Date.now() + 15_000;
        while (status !== 200 && Date.now() < deadline) {
          status = (await h.call('GET', '/health')).status;
          if (status !== 200) await Bun.sleep(250);
        }
        expect(status).toBe(200);
        expect((await h.register(1)).status).toBe(201);
      } finally {
        await db.close().catch(() => undefined);
        cluster.destroy();
      }
    },
    60_000
  );
});
