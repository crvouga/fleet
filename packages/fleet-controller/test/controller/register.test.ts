import { describe, expect, test } from 'bun:test';

import {
  CI_ENROLLMENT_TOKEN,
  PLAIN_ENROLLMENT_TOKEN,
} from '../support/controller';
import { describeController } from '../support/describe-controller';
import { nodeIdOf, secretOf, sha256, heartbeatBody } from '../support/fixtures';

describeController('POST /v1/nodes/register', (ctx) => {
  test('a first hello creates a pending node and answers 201', async () => {
    const { h, store, db } = ctx();
    const reply = await h.register(1);
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({
      status: 'pending',
      heartbeatIntervalSeconds: 60,
      role: null,
    });
    expect(await store.findNode(nodeIdOf(1))).toMatchObject({
      approval: 'pending',
      enrolledVia: 'hello',
      role: null,
      hostname: `ci-${nodeIdOf(1).slice(0, 4)}`,
    });
    const stored = await db.sql`select secret_hash from nodes`;
    expect(stored[0]?.['secret_hash']).toBe(sha256(secretOf(1)));
  });

  test('the secret itself is stored nowhere, not in nodes, events or the response', async () => {
    const { h, db } = ctx();
    const reply = await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    expect(reply.text).not.toContain(secretOf(1));
    const dump = JSON.stringify({
      nodes: await db.sql`select * from nodes`,
      events: await db.sql`select * from events`,
    });
    expect(dump).not.toContain(secretOf(1));
    expect(dump).not.toContain(CI_ENROLLMENT_TOKEN);
  });

  test('an enrollment token approves immediately and assigns its role', async () => {
    const { h, store } = ctx();
    const reply = await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ status: 'approved', role: 'ci' });
    expect(await store.findNode(nodeIdOf(1))).toMatchObject({
      approval: 'approved',
      role: 'ci',
      enrolledVia: 'enrollment-token',
      approvedBy: 'enrollment-token',
    });
    const assigned = (await store.listEvents({ limit: 10 })).find(
      (event) => event.kind === 'role_assigned'
    );
    expect(assigned?.data).toMatchObject({
      role: 'ci',
      previous: null,
      actor: 'enrollment-token',
    });
  });

  test('a token without a role approves and leaves the node unassigned', async () => {
    const { h, store } = ctx();
    const reply = await h.register(1, {
      enrollmentToken: PLAIN_ENROLLMENT_TOKEN,
    });
    expect(reply.body).toMatchObject({ status: 'approved', role: null });
    expect((await store.findNode(nodeIdOf(1)))?.role).toBeNull();
  });

  test('a token assigns its role only when the node has none', async () => {
    const { h, store } = ctx();
    await h.register(1);
    await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { role: 'devbox' });
    const reply = await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    expect(reply.body).toMatchObject({ status: 'approved', role: 'devbox' });
    expect((await store.findNode(nodeIdOf(1)))?.role).toBe('devbox');
    const unassigned = await h.register(2, {
      enrollmentToken: PLAIN_ENROLLMENT_TOKEN,
    });
    expect(unassigned.body.role).toBeNull();
    const filled = await h.register(2, {
      enrollmentToken: CI_ENROLLMENT_TOKEN,
    });
    expect(filled.body.role).toBe('ci');
  });

  test('re-registering without a token never clears the assigned role', async () => {
    const { h, store } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const again = await h.register(1);
    expect(again.body).toMatchObject({ status: 'pending', role: 'ci' });
    expect((await store.findNode(nodeIdOf(1)))?.role).toBe('ci');
  });

  test('a wrong enrollment token is not an error: the node just waits for a person', async () => {
    const { h, store } = ctx();
    const reply = await h.register(1, { enrollmentToken: 'not-the-token' });
    expect(reply.status).toBe(201);
    expect(reply.body.status).toBe('pending');
    expect((await store.findNode(nodeIdOf(1)))?.enrolledVia).toBe('hello');
  });

  test('a claimed role and an old role token are ignored, never stored', async () => {
    const { h, store, db } = ctx();
    const reply = await h.register(1, {
      role: 'devbox',
      roleToken: 'legacy-role-token-value',
    });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ status: 'pending', role: null });
    expect((await store.findNode(nodeIdOf(1)))?.role).toBeNull();
    const dump = JSON.stringify(await db.sql`select * from nodes`);
    expect(dump).not.toContain('legacy-role-token-value');
    expect(dump).not.toContain('devbox');
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
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const again = await h.register(1);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('pending');
    expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('pending');
  });

  test('a rejected node stays rejected and is told so', async () => {
    const { h } = ctx();
    await h.register(1);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/reject`);
    const again = await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
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
      (await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN })).body
        .status
    ).toBe('approved');
  });

  test('reports the heartbeat interval that applies', async () => {
    const { h } = ctx();
    await h.admin('PUT', '/v1/settings/fleet', {
      heartbeat: { intervalSeconds: 30 },
    });
    expect((await h.register(1)).body.heartbeatIntervalSeconds).toBe(30);
    await h.admin('PUT', '/v1/settings/role:ci', {
      heartbeat: { intervalSeconds: 120 },
    });
    // The claimed role does not choose settings; the assigned role does.
    expect(
      (await h.register(2, { role: 'ci' })).body.heartbeatIntervalSeconds
    ).toBe(30);
    const assigned = await h.register(3, {
      enrollmentToken: CI_ENROLLMENT_TOKEN,
    });
    expect(assigned.body.heartbeatIntervalSeconds).toBe(120);
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

    test('hostname', async () => {
      await reject({ hostname: 'has space' }, 'hostname');
      await reject({ hostname: '' }, 'hostname');
    });
    test('secret', async () => {
      await reject({ secret: 'short' }, 'secret');
      await reject({ secret: secretOf(1).toUpperCase() }, 'secret');
      await reject({ secret: undefined }, 'secret');
    });
    test('enrollment token', async () => {
      await reject({ enrollmentToken: 5 }, 'enrollmentToken');
      await reject({ enrollmentToken: 'x'.repeat(513) }, 'enrollmentToken');
      await reject({ enrollmentToken: 'short' }, 'enrollmentToken');
      await reject({ enrollmentToken: 'with spaces ok' }, 'enrollmentToken');
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
        controller: { registerLimit: { limit: 2, windowMs: 60_000 } },
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
        controller: { registerLimit: { limit: 2, windowMs: 60_000 } },
      });
      await h.register(1, { secret: 'bad' });
      await h.register(1, { secret: 'bad' });
      expect((await h.register(1)).status).toBe(429);
    });

    test('keys on cf-connecting-ip, then the first x-forwarded-for entry', async () => {
      const { harness } = ctx();
      const h = harness({
        controller: { registerLimit: { limit: 1, windowMs: 60_000 } },
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
      headers: { 'x-forwarded-for': "'; drop table nodes; --" },
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
