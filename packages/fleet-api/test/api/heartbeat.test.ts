import { describe, expect, test } from 'bun:test';

import { configRevision } from '../../src/config/schema';
import { CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';
import { heartbeatBody, nodeIdOf, secretOf, T0 } from '../support/fixtures';

const EMPTY_REVISION = configRevision({});

describeApi('POST /v1/heartbeat', (ctx) => {
  const enroll = async (n = 1) =>
    ctx().h.register(n, { roleToken: CI_ROLE_TOKEN });
  const beat = (n = 1, overrides = {}) =>
    ctx().h.asNode(n, 'POST', '/v1/heartbeat', heartbeatBody(n, overrides));

  describe('credentials', () => {
    test('401 without a credential, with a malformed one, for an unknown node and for a wrong secret', async () => {
      const { h } = ctx();
      await enroll();
      const body = heartbeatBody(1);
      const attempts = [
        {},
        { Authorization: 'Bearer nonsense' },
        { Authorization: `Basic ${nodeIdOf(1)}.${secretOf(1)}` },
        { Authorization: `Bearer ${nodeIdOf(9)}.${secretOf(1)}` },
        { Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(2)}` },
      ];
      for (const headers of attempts) {
        const reply = await h.call('POST', '/v1/heartbeat', {
          headers,
          json: body,
        });
        expect(reply.status).toBe(401);
        expect(reply.body.error).toBe('unauthorized');
        expect(typeof reply.body.message).toBe('string');
      }
    });

    test('the admin token is not a node credential', async () => {
      const { h } = ctx();
      await enroll();
      const reply = await h.admin('POST', '/v1/heartbeat', heartbeatBody(1));
      expect(reply.status).toBe(401);
    });

    test('the credential is checked before the body is read', async () => {
      const { h } = ctx();
      const reply = await h.call('POST', '/v1/heartbeat', {
        body: '{not json',
      });
      expect(reply.status).toBe(401);
    });

    test('a rejected node holding its secret is told 403 rejected; without the secret it is just 401', async () => {
      const { h } = ctx();
      await enroll();
      await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/reject`);
      const known = await beat();
      expect(known.status).toBe(403);
      expect(known.body.error).toBe('rejected');
      const stranger = await h.call('POST', '/v1/heartbeat', {
        headers: { Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(2)}` },
        json: heartbeatBody(1),
      });
      expect(stranger.status).toBe(401);
    });

    test('a retired node holding its secret is told 403 retired', async () => {
      const { h } = ctx();
      await enroll();
      await h.asNode(1, 'POST', '/v1/retire');
      const reply = await beat();
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe('retired');
    });

    test('after the server forgets a node, 401 then register again then heartbeat works', async () => {
      const { h } = ctx();
      await enroll();
      expect((await beat()).status).toBe(200);
      await h.admin('DELETE', `/v1/nodes/${nodeIdOf(1)}`);
      expect((await beat()).status).toBe(401);
      expect((await h.register(1)).status).toBe(201);
      const reply = await beat();
      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe('pending');
    });
  });

  describe('the response', () => {
    test('has ok, status, the server time and the current config the first time', async () => {
      const { h } = ctx();
      await enroll();
      h.clock.set(new Date('2026-10-14T12:00:00.000Z'));
      const reply = await beat();
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        ok: true,
        status: 'approved',
        serverTime: '2026-10-14T12:00:00.000Z',
        config: { revision: EMPTY_REVISION, values: {} },
      });
    });

    test('config is left out once the node reports the revision it has', async () => {
      await enroll();
      const reply = await beat(1, {
        agent: { version: '1', configRevision: EMPTY_REVISION },
      });
      expect(reply.status).toBe(200);
      expect('config' in reply.body).toBe(false);
    });

    test('a changed setting brings the config back with a new revision', async () => {
      const { h } = ctx();
      await enroll();
      const had = { agent: { version: '1', configRevision: EMPTY_REVISION } };
      expect('config' in (await beat(1, had)).body).toBe(false);
      await h.admin('PUT', '/v1/settings/fleet', { sync: { paused: true } });
      const changed = await beat(1, had);
      expect(changed.body.config.values).toEqual({ sync: { paused: true } });
      expect(changed.body.config.revision).not.toBe(EMPTY_REVISION);
      const echoed = await beat(1, {
        agent: { version: '1', configRevision: changed.body.config.revision },
      });
      expect('config' in echoed.body).toBe(false);
    });

    test('config merges fleet, then role, then node, and the node revision follows content', async () => {
      const { h } = ctx();
      await enroll();
      await h.admin('PUT', '/v1/settings/fleet', {
        sync: { paused: false },
        disk: { alertPercent: 80 },
        runners: { extraLabels: ['a'] },
      });
      await h.admin('PUT', '/v1/settings/role:ci', {
        disk: { alertPercent: 70 },
        runners: { extraLabels: ['b'] },
      });
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        sync: { paused: true },
      });
      const reply = await beat();
      expect(reply.body.config.values).toEqual({
        sync: { paused: true },
        disk: { alertPercent: 70 },
        runners: { extraLabels: ['b'] },
      });
      await h.admin('PUT', '/v1/settings/role:web', { sync: { paused: true } });
      const same = await beat(1, {
        agent: { version: '1', configRevision: reply.body.config.revision },
      });
      expect('config' in same.body).toBe(false);
    });

    test('the server-only alerts section never reaches a node', async () => {
      const { h } = ctx();
      await enroll();
      await h.admin('PUT', '/v1/settings/fleet', {
        alerts: {
          offlineAfterSeconds: 120,
          webhookUrl: 'https://hooks.example/secret-path',
        },
        sync: { paused: true },
      });
      const reply = await beat();
      expect(reply.body.config.values).toEqual({ sync: { paused: true } });
      expect(reply.text).not.toContain('hooks.example');
      expect(reply.text).not.toContain('alerts');
    });

    test('a pending node learns only how often to report', async () => {
      const { h } = ctx();
      await h.register(1);
      await h.admin('PUT', '/v1/settings/fleet', {
        sync: { paused: true },
        heartbeat: { intervalSeconds: 30 },
        disk: { alertPercent: 80 },
      });
      const reply = await beat();
      expect(reply.body.status).toBe('pending');
      expect(reply.body.config.values).toEqual({
        heartbeat: { intervalSeconds: 30 },
      });
    });

    test('a pending node with no interval configured is told the default', async () => {
      await ctx().h.register(1);
      expect((await beat()).body.config.values).toEqual({
        heartbeat: { intervalSeconds: 60 },
      });
    });

    test('once approved, the next report returns the full config', async () => {
      const { h } = ctx();
      await h.register(1);
      await h.admin('PUT', '/v1/settings/fleet', { sync: { paused: true } });
      const pending = await beat();
      const echo = {
        agent: { version: '1', configRevision: pending.body.config.revision },
      };
      expect('config' in (await beat(1, echo)).body).toBe(false);
      await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`);
      const approved = await beat(1, echo);
      expect(approved.body.status).toBe('approved');
      expect(approved.body.config.values).toEqual({ sync: { paused: true } });
    });
  });

  describe('what the server stores', () => {
    test('facts, status and the history point', async () => {
      const { h, store } = ctx();
      await enroll();
      h.clock.set(T0);
      await beat(1, { load1: 2.5, hostname: 'ci-renamed' });
      const node = await store.findNode(nodeIdOf(1));
      expect(node).toMatchObject({
        hostname: 'ci-renamed',
        lastSeenAt: T0,
        revision: '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283',
      });
      expect(
        (await store.listHeartbeats(nodeIdOf(1), new Date(0)))[0]
      ).toMatchObject({ at: T0, load1: 2.5 });
    });

    test('the body cannot approve a node or set labels', async () => {
      const { h, store } = ctx();
      await h.register(1);
      const reply = await h.asNode(1, 'POST', '/v1/heartbeat', {
        ...heartbeatBody(1),
        approval: 'approved',
        status: 'approved',
        labels: ['trusted'],
        displayName: 'root',
        enrolledVia: 'role-token',
      });
      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe('pending');
      expect(await store.findNode(nodeIdOf(1))).toMatchObject({
        approval: 'pending',
        labels: [],
        displayName: null,
        enrolledVia: 'hello',
      });
    });

    test('the node events appear in the log with the node label', async () => {
      const { h } = ctx();
      await enroll();
      await beat(1, {
        events: [{ kind: 'boot', severity: 'warn', message: 'node started' }],
      });
      const events = (await h.admin('GET', '/v1/events?severity=warn')).body
        .events;
      expect(events[0]).toMatchObject({
        kind: 'boot',
        message: 'node started',
        nodeId: nodeIdOf(1),
        nodeLabel: `ci-${nodeIdOf(1).slice(0, 4)}`,
      });
    });

    test('the caller address comes from the proxy headers', async () => {
      const { h, store } = ctx();
      await enroll();
      await h.call('POST', '/v1/heartbeat', {
        headers: {
          Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(1)}`,
          'cf-connecting-ip': '192.0.2.77',
        },
        json: heartbeatBody(1),
      });
      expect((await store.findNode(nodeIdOf(1)))?.remoteAddr).toBe(
        '192.0.2.77'
      );
    });

    test('a steady node produces no new events, a changed one produces one', async () => {
      const { h } = ctx();
      await enroll();
      await beat();
      await beat();
      await beat();
      const before = (await h.admin('GET', '/v1/events?limit=200')).body.events
        .length;
      await beat(1, { failedUnits: ['sshd.service'] });
      await beat(1, { failedUnits: ['sshd.service'] });
      const after = (await h.admin('GET', '/v1/events?limit=200')).body.events;
      expect(after.length).toBe(before + 1);
      expect(after[0]).toMatchObject({
        kind: 'units_failed',
        severity: 'warn',
      });
    });
  });

  describe('validation', () => {
    test('the body nodeId must match the credential', async () => {
      const { h } = ctx();
      await enroll();
      await enroll(2);
      const reply = await h.asNode(
        1,
        'POST',
        '/v1/heartbeat',
        heartbeatBody(2)
      );
      expect(reply.status).toBe(400);
      expect(reply.body.message).toContain('nodeId');
    });

    test('lists every problem', async () => {
      const { h } = ctx();
      await enroll();
      const reply = await h.asNode(1, 'POST', '/v1/heartbeat', {
        ...heartbeatBody(1),
        load1: 'x',
        v: 3,
      });
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe('invalid_request');
      expect(reply.body.errors).toEqual(
        expect.arrayContaining(['v must be 1', 'load1 must be a number'])
      );
    });

    test('at most 20 events, each message at most 500 characters', async () => {
      const event = { kind: 'k', severity: 'info', message: 'm' };
      await enroll();
      expect((await beat(1, { events: Array(20).fill(event) })).status).toBe(
        200
      );
      expect((await beat(1, { events: Array(21).fill(event) })).status).toBe(
        400
      );
      expect(
        (await beat(1, { events: [{ ...event, message: 'x'.repeat(500) }] }))
          .status
      ).toBe(200);
      expect(
        (await beat(1, { events: [{ ...event, message: 'x'.repeat(501) }] }))
          .status
      ).toBe(400);
    });

    test('malformed JSON is a 400, not a crash', async () => {
      const { h } = ctx();
      await enroll();
      const reply = await h.call('POST', '/v1/heartbeat', {
        headers: { Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(1)}` },
        body: '{"v": 1,',
      });
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe('invalid_request');
    });

    test('a rejected report stores nothing', async () => {
      const { h, store } = ctx();
      await enroll();
      await h.asNode(1, 'POST', '/v1/heartbeat', {
        ...heartbeatBody(1),
        load1: 'x',
      });
      expect((await store.findNode(nodeIdOf(1)))?.lastSeenAt).toBeNull();
      expect(await store.listHeartbeats(nodeIdOf(1), new Date(0))).toEqual([]);
    });
  });

  test('status moves online, stale, offline as the node falls silent', async () => {
    const { h } = ctx();
    await enroll();
    await beat();
    const status = async () =>
      (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node.status;
    expect(await status()).toBe('online');
    h.clock.advance(100);
    expect(await status()).toBe('online');
    h.clock.advance(60);
    expect(await status()).toBe('stale');
    h.clock.advance(120);
    expect(await status()).toBe('stale');
    h.clock.advance(30);
    expect(await status()).toBe('offline');
    await beat();
    expect(await status()).toBe('online');
  });
});

describeApi('POST /v1/retire', (ctx) => {
  const enroll = async (n = 1) =>
    ctx().h.register(n, { roleToken: CI_ROLE_TOKEN });

  test('marks the node retired, records an event and answers ok', async () => {
    const { h, store } = ctx();
    await enroll();
    const reply = await h.asNode(1, 'POST', '/v1/retire');
    expect(reply).toMatchObject({ status: 200, body: { ok: true } });
    expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('retired');
    const events = (await h.admin('GET', '/v1/events')).body.events;
    expect(events[0]).toMatchObject({ kind: 'retired', nodeId: nodeIdOf(1) });
  });

  test('a pending node can retire itself too', async () => {
    const { h, store } = ctx();
    await h.register(1);
    expect((await h.asNode(1, 'POST', '/v1/retire')).status).toBe(200);
    expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('retired');
  });

  test('is idempotent', async () => {
    const { h } = ctx();
    await enroll();
    await h.asNode(1, 'POST', '/v1/retire');
    const again = await h.asNode(1, 'POST', '/v1/retire');
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
    const retired = (
      await h.admin('GET', '/v1/events?limit=200')
    ).body.events.filter((e: { kind: string }) => e.kind === 'retired');
    expect(retired).toHaveLength(1);
  });

  test('needs the node secret', async () => {
    const { h } = ctx();
    await enroll();
    expect((await h.call('POST', '/v1/retire')).status).toBe(401);
    expect((await h.admin('POST', '/v1/retire')).status).toBe(401);
    expect(
      (
        await h.call('POST', '/v1/retire', {
          headers: { Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(2)}` },
        })
      ).status
    ).toBe(401);
  });

  test('a rejected node is told 403', async () => {
    const { h } = ctx();
    await enroll();
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/reject`);
    const reply = await h.asNode(1, 'POST', '/v1/retire');
    expect(reply.status).toBe(403);
  });

  test('a retired node stops being announced offline', async () => {
    const { h, store } = ctx();
    await enroll();
    await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));
    await h.asNode(1, 'POST', '/v1/retire');
    h.clock.advance(100_000);
    expect(await store.nodesDueOfflineNotice(h.clock.now(), 300)).toEqual([]);
  });
});
