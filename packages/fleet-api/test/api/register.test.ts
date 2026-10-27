import { describe, expect, test } from 'bun:test';

import { CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';
import { nodeIdOf, secretOf, sha256, heartbeatBody } from '../support/fixtures';

describeApi('POST /v1/nodes/register', (ctx) => {
  test('a first hello creates a pending node and answers 201', async () => {
    const { h, store, db } = ctx();
    const reply = await h.register(1);
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({
      status: 'pending',
      heartbeatIntervalSeconds: 60,
    });
    expect(await store.findNode(nodeIdOf(1))).toMatchObject({
      approval: 'pending',
      enrolledVia: 'hello',
      role: 'ci',
      hostname: `ci-${nodeIdOf(1).slice(0, 4)}`,
    });
    const stored = await db.sql`select secret_hash from fleet.nodes`;
    expect(stored[0].secret_hash).toBe(sha256(secretOf(1)));
  });

  test('the secret itself is stored nowhere, not in nodes, events or the response', async () => {
    const { h, db } = ctx();
    const reply = await h.register(1, { roleToken: CI_ROLE_TOKEN });
    expect(reply.text).not.toContain(secretOf(1));
    const dump = await db.sql`
      select (select coalesce(string_agg(n::text, ' '), '') from fleet.nodes n) ||
             (select coalesce(string_agg(e::text, ' '), '') from fleet.events e) as everything`;
    expect(dump[0].everything).not.toContain(secretOf(1));
    expect(dump[0].everything).not.toContain(CI_ROLE_TOKEN);
  });

  test('the role token approves immediately', async () => {
    const { h, store } = ctx();
    const reply = await h.register(1, { roleToken: CI_ROLE_TOKEN });
    expect(reply.status).toBe(201);
    expect(reply.body.status).toBe('approved');
    expect(await store.findNode(nodeIdOf(1))).toMatchObject({
      approval: 'approved',
      enrolledVia: 'role-token',
      approvedBy: 'role-token',
    });
  });

  test('a wrong role token is not an error: the node just waits for a person', async () => {
    const { h, store } = ctx();
    const reply = await h.register(1, { roleToken: 'not-the-token' });
    expect(reply.status).toBe(201);
    expect(reply.body.status).toBe('pending');
    expect((await store.findNode(nodeIdOf(1)))?.enrolledVia).toBe('hello');
  });

  test('the token of one role does not approve another role', async () => {
    const { h } = ctx();
    const reply = await h.register(1, {
      role: 'devbox',
      hostname: 'devbox-1234',
      roleToken: CI_ROLE_TOKEN,
    });
    expect(reply.body.status).toBe('pending');
  });

  test('registering again is a 200 that replaces the secret', async () => {
    const { h } = ctx();
    await h.register(1);
    const again = await h.call('POST', '/v1/nodes/register', {
      json: {
        nodeId: nodeIdOf(1),
        role: 'ci',
        hostname: 'ci-new',
        secret: secretOf(2),
      },
    });
    expect(again.status).toBe(200);
    expect(
      (await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1))).status
    ).toBe(401);
    const fresh = await h.call('POST', '/v1/heartbeat', {
      headers: { Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(2)}` },
      json: heartbeatBody(1, { hostname: 'ci-new' }),
    });
    expect(fresh.status).toBe(200);
  });

  test('an approved node registering without the token must be approved again', async () => {
    const { h, store } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const again = await h.register(1);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('pending');
    expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('pending');
  });

  test('a rejected node stays rejected and is told so', async () => {
    const { h } = ctx();
    await h.register(1);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/reject`);
    const again = await h.register(1, { roleToken: CI_ROLE_TOKEN });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('rejected');
  });

  test('a retired node becomes pending, or approved with the token', async () => {
    const { h } = ctx();
    await h.register(1);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/retire`);
    expect((await h.register(1)).body.status).toBe('pending');
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/retire`);
    expect(
      (await h.register(1, { roleToken: CI_ROLE_TOKEN })).body.status
    ).toBe('approved');
  });

  test('reports the heartbeat interval that applies', async () => {
    const { h } = ctx();
    await h.admin('PUT', '/v1/settings/fleet', {
      heartbeat: { intervalSeconds: 30 },
    });
    expect((await h.register(1)).body.heartbeatIntervalSeconds).toBe(30);
    await h.admin('PUT', '/v1/settings/role:devbox', {
      heartbeat: { intervalSeconds: 120 },
    });
    const devbox = await h.register(2, {
      role: 'devbox',
      hostname: 'devbox-1234',
    });
    expect(devbox.body.heartbeatIntervalSeconds).toBe(120);
  });

  describe('validation', () => {
    const reject = async (body: Record<string, unknown>, fragment: string) => {
      const reply = await ctx().h.register(1, body);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe('invalid_request');
      expect(reply.body.message).toContain(fragment);
      expect(reply.body.errors.join(' ')).toContain(fragment);
      expect(await ctx().store.findNode(nodeIdOf(1))).toBeNull();
    };

    test('node id', async () => {
      await reject({ nodeId: 'ABC' }, 'nodeId');
      await reject({ nodeId: nodeIdOf(1).toUpperCase() }, 'nodeId');
      await reject({ nodeId: 12 }, 'nodeId');
    });
    test('role', async () => {
      await reject({ role: 'gpu' }, 'role');
      await reject({ role: undefined }, 'role');
      // Retired in packages/fleet/roles.json: rows stay, enrollment stops.
      await reject({ role: 'web' }, 'role must be one of: ci, devbox');
    });
    test('hostname', async () => {
      await reject({ hostname: 'has space' }, 'hostname');
      await reject({ hostname: '' }, 'hostname');
    });
    test('secret', async () => {
      await reject({ secret: 'short' }, 'secret');
      await reject({ secret: secretOf(1).toUpperCase() }, 'secret');
      await reject({ secret: undefined }, 'secret');
    });
    test('role token', async () => {
      await reject({ roleToken: 5 }, 'roleToken');
      await reject({ roleToken: 'x'.repeat(513) }, 'roleToken');
    });

    test('the body must be a JSON object', async () => {
      const { h } = ctx();
      for (const json of [[], 'text', 4, null]) {
        const reply = await h.call('POST', '/v1/nodes/register', { json });
        expect(reply.status).toBe(400);
      }
    });

    test('malformed JSON is a 400 with the standard error shape', async () => {
      const { h } = ctx();
      const reply = await h.call('POST', '/v1/nodes/register', {
        headers: { 'Content-Type': 'application/json' },
        body: '{"nodeId": ',
      });
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({
        error: 'invalid_request',
        message: 'The body must be valid JSON.',
      });
    });

    test('an empty body is a 400', async () => {
      const reply = await ctx().h.call('POST', '/v1/nodes/register', {
        body: '',
      });
      expect(reply.status).toBe(400);
    });
  });

  describe('rate limiting', () => {
    test('429 with Retry-After once an address passes its limit; others are unaffected', async () => {
      const { h } = ctx();
      const from = (ip: string, n: number) =>
        h.call('POST', '/v1/nodes/register', {
          headers: { 'cf-connecting-ip': ip },
          json: {
            nodeId: nodeIdOf(n),
            role: 'ci',
            hostname: 'ci-1',
            secret: secretOf(n),
          },
        });
      const limit = 20;
      for (let i = 0; i < limit; i += 1)
        expect((await from('203.0.113.1', i + 1)).status).toBe(201);
      const refused = await from('203.0.113.1', 99);
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe('rate_limited');
      expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(refused.body.retryAfterSeconds).toBe(
        Number(refused.headers.get('Retry-After'))
      );
      expect((await from('203.0.113.2', 99)).status).toBe(201);
    });

    test('the window reopens with the clock', async () => {
      const { harness } = ctx();
      const h = harness({
        api: { registerLimit: { limit: 2, windowMs: 60_000 } },
      });
      expect((await h.register(1)).status).toBe(201);
      expect((await h.register(2)).status).toBe(201);
      expect((await h.register(3)).status).toBe(429);
      h.clock.advance(59);
      expect((await h.register(3)).status).toBe(429);
      h.clock.advance(1);
      expect((await h.register(3)).status).toBe(201);
    });

    test('invalid requests count too, so guessing is limited', async () => {
      const { harness } = ctx();
      const h = harness({
        api: { registerLimit: { limit: 2, windowMs: 60_000 } },
      });
      await h.register(1, { secret: 'bad' });
      await h.register(1, { secret: 'bad' });
      expect((await h.register(1)).status).toBe(429);
    });

    test('keys on cf-connecting-ip, then the first x-forwarded-for entry', async () => {
      const { harness } = ctx();
      const h = harness({
        api: { registerLimit: { limit: 1, windowMs: 60_000 } },
      });
      const post = (headers: Record<string, string>, n: number) =>
        h.call('POST', '/v1/nodes/register', {
          headers,
          json: {
            nodeId: nodeIdOf(n),
            role: 'ci',
            hostname: 'ci-1',
            secret: secretOf(n),
          },
        });
      expect(
        (await post({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }, 1)).status
      ).toBe(201);
      expect(
        (await post({ 'x-forwarded-for': '198.51.100.1, 10.9.9.9' }, 2)).status
      ).toBe(429);
      expect(
        (await post({ 'x-forwarded-for': '198.51.100.2' }, 3)).status
      ).toBe(201);
      expect(
        (
          await post(
            {
              'x-forwarded-for': '198.51.100.1',
              'cf-connecting-ip': '192.0.2.5',
            },
            4
          )
        ).status
      ).toBe(201);
    });
  });

  test('the caller address is recorded from the proxy headers', async () => {
    const { h, store } = ctx();
    await h.call('POST', '/v1/nodes/register', {
      headers: {
        'cf-connecting-ip': '192.0.2.44',
        'x-forwarded-for': '10.0.0.9',
      },
      json: {
        nodeId: nodeIdOf(1),
        role: 'ci',
        hostname: 'ci-1',
        secret: secretOf(1),
      },
    });
    expect((await store.findNode(nodeIdOf(1)))?.remoteAddr).toBe('192.0.2.44');
  });

  test('an address header that is not an address is ignored', async () => {
    const { h, store } = ctx();
    await h.call('POST', '/v1/nodes/register', {
      headers: { 'x-forwarded-for': "'; drop table fleet.nodes; --" },
      json: {
        nodeId: nodeIdOf(1),
        role: 'ci',
        hostname: 'ci-1',
        secret: secretOf(1),
      },
    });
    expect((await store.findNode(nodeIdOf(1)))?.remoteAddr).toBeNull();
  });

  test('needs no credential, and other methods are not routes', async () => {
    const { h } = ctx();
    expect((await h.call('GET', '/v1/nodes/register')).status).toBe(401);
    expect(
      (await h.call('PUT', '/v1/nodes/register', { json: {} })).status
    ).toBe(404);
  });
});
