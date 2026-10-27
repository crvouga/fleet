import { describe, expect, test } from 'bun:test';

import { ADMIN_TOKEN, CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';
import { at, heartbeatBody, nodeIdOf, secretOf, T0 } from '../support/fixtures';

describeApi('admin node endpoints', (ctx) => {
  const enroll = (n: number, role: 'ci' | 'web' = 'ci') =>
    ctx().h.register(n, {
      roleToken: role === 'ci' ? CI_ROLE_TOKEN : undefined,
      role,
      hostname: `${role}-${nodeIdOf(n).slice(0, 4)}`,
    });
  const beat = (n: number, overrides = {}) =>
    ctx().h.asNode(n, 'POST', '/v1/heartbeat', heartbeatBody(n, overrides));

  describe('GET /v1/nodes', () => {
    test('is empty to begin with', async () => {
      const reply = await ctx().h.admin('GET', '/v1/nodes');
      expect(reply).toMatchObject({ status: 200, body: { nodes: [] } });
    });

    test('lists every node as a view, newest report first', async () => {
      const { h } = ctx();
      await enroll(1);
      await enroll(2);
      await h.register(3);
      h.clock.set(at(0));
      await beat(1);
      h.clock.set(at(30));
      await beat(2);
      h.clock.set(at(40));
      const nodes = (await h.admin('GET', '/v1/nodes')).body.nodes;
      expect(nodes.map((n: { id: string }) => n.id).slice(0, 2)).toEqual([
        nodeIdOf(2),
        nodeIdOf(1),
      ]);
      expect(nodes[0]).toMatchObject({
        id: nodeIdOf(2),
        status: 'online',
        approval: 'approved',
        shortId: nodeIdOf(2).slice(0, 4),
        label: `ci-${nodeIdOf(2).slice(0, 4)}`,
        ageSeconds: 10,
        role: 'ci',
        labels: [],
      });
      expect(nodes[2]).toMatchObject({
        approval: 'pending',
        status: 'pending',
        lastSeenAt: null,
        ageSeconds: null,
      });
    });

    test('the label is the display name once a person sets one', async () => {
      const { h } = ctx();
      await enroll(1);
      await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, {
        displayName: 'Rack 1',
      });
      expect((await h.admin('GET', '/v1/nodes')).body.nodes[0].label).toBe(
        'Rack 1'
      );
    });

    test('never contains a secret hash, a secret or a token', async () => {
      const { h, db } = ctx();
      await enroll(1);
      await beat(1);
      const hashes = await db.sql`select secret_hash from fleet.nodes`;
      const reply = await h.admin('GET', '/v1/nodes');
      expect(reply.text).not.toContain(hashes[0].secret_hash);
      expect(reply.text).not.toContain(secretOf(1));
      expect(reply.text).not.toContain(CI_ROLE_TOKEN);
      expect(reply.text).not.toContain('secret');
    });

    test('judges each node by the offline threshold that applies to it', async () => {
      const { h } = ctx();
      await h.admin('PUT', '/v1/settings/fleet', {
        alerts: { offlineAfterSeconds: 600 },
      });
      await enroll(1);
      await beat(1);
      h.clock.advance(400);
      const view = (await h.admin('GET', '/v1/nodes')).body.nodes[0];
      expect(view.status).toBe('stale');
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        alerts: { offlineAfterSeconds: 120 },
      });
      expect((await h.admin('GET', '/v1/nodes')).body.nodes[0].status).toBe(
        'offline'
      );
    });
  });

  describe('GET /v1/nodes/:id', () => {
    test('has the node, the last 24 hours of history and the resolved config', async () => {
      const { h, store } = ctx();
      await enroll(1);
      await h.admin('PUT', '/v1/settings/fleet', {
        alerts: { offlineAfterSeconds: 200 },
        sync: { paused: true },
      });
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        sync: { paused: false },
      });
      await store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1),
        null,
        at(-25 * 3600, T0)
      );
      await store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1),
        null,
        at(-23 * 3600, T0)
      );
      h.clock.set(T0);
      await beat(1);
      const reply = await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`);
      expect(reply.status).toBe(200);
      expect(reply.body.node).toMatchObject({
        id: nodeIdOf(1),
        shortId: nodeIdOf(1).slice(0, 4),
      });
      expect(reply.body.heartbeats).toHaveLength(2);
      expect(reply.body.heartbeats[0].at).toBe(
        at(-23 * 3600, T0).toISOString()
      );
      expect(reply.body.config).toEqual({
        alerts: { offlineAfterSeconds: 200 },
        sync: { paused: false },
      });
    });

    test('404 for an unknown or malformed id', async () => {
      const { h } = ctx();
      for (const id of [
        nodeIdOf(9),
        'nope',
        nodeIdOf(1).toUpperCase(),
        `${nodeIdOf(1)}x`,
      ]) {
        const reply = await h.admin('GET', `/v1/nodes/${id}`);
        expect(reply.status).toBe(404);
        expect(reply.body.error).toBe('not_found');
      }
    });
  });

  describe('PATCH /v1/nodes/:id', () => {
    const patch = (json: unknown, id = nodeIdOf(1)) =>
      ctx().h.admin('PATCH', `/v1/nodes/${id}`, json);

    test('changes the fields given and leaves the rest', async () => {
      await enroll(1);
      const first = await patch({
        displayName: '  Rack 1  ',
        note: 'top shelf',
        labels: ['gpu', 'a:b'],
      });
      expect(first.status).toBe(200);
      expect(first.body.node).toMatchObject({
        displayName: 'Rack 1',
        note: 'top shelf',
        labels: ['gpu', 'a:b'],
        label: 'Rack 1',
      });
      const second = await patch({ note: 'moved' });
      expect(second.body.node).toMatchObject({
        displayName: 'Rack 1',
        note: 'moved',
        labels: ['gpu', 'a:b'],
      });
    });

    test('null or blank clears a text field, an empty list clears labels', async () => {
      await enroll(1);
      await patch({ displayName: 'x', note: 'y', labels: ['z'] });
      const cleared = await patch({
        displayName: null,
        note: '   ',
        labels: [],
      });
      expect(cleared.body.node).toMatchObject({
        displayName: null,
        note: null,
        labels: [],
        label: `ci-${nodeIdOf(1).slice(0, 4)}`,
      });
    });

    test('refuses what it should', async () => {
      await enroll(1);
      const bad: [unknown, string][] = [
        [{}, 'at least one'],
        [{ role: 'web' }, 'role cannot be changed'],
        [{ approval: 'approved' }, 'approval cannot be changed'],
        [{ displayName: 'x'.repeat(81) }, 'displayName'],
        [{ displayName: 5 }, 'displayName'],
        [{ note: 'x'.repeat(1001) }, 'note'],
        [{ labels: 'gpu' }, 'labels'],
        [{ labels: ['a', 'a'] }, 'labels'],
        [{ labels: ['has space'] }, 'labels'],
        [{ labels: Array.from({ length: 17 }, (_, i) => `l${i}`) }, 'labels'],
        [{ labels: [1] }, 'labels'],
        [[], 'JSON object'],
        ['text', 'JSON object'],
      ];
      for (const [json, fragment] of bad) {
        const reply = await patch(json);
        expect(reply.status).toBe(400);
        expect(reply.body.message).toContain(fragment);
      }
    });

    test('404 for an unknown node, 400 for malformed json', async () => {
      const { h } = ctx();
      expect((await patch({ note: 'x' }, nodeIdOf(9))).status).toBe(404);
      await enroll(1);
      const reply = await h.call('PATCH', `/v1/nodes/${nodeIdOf(1)}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: '{',
      });
      expect(reply.status).toBe(400);
    });
  });

  describe('approve, reject, retire', () => {
    const act = (verb: string, id = nodeIdOf(1)) =>
      ctx().h.admin('POST', `/v1/nodes/${id}/${verb}`);

    test('approve moves pending to approved and names the actor', async () => {
      const { h, store } = ctx();
      await h.register(1);
      const reply = await act('approve');
      expect(reply.status).toBe(200);
      expect(reply.body.node).toMatchObject({
        approval: 'approved',
        status: 'offline',
        approvedBy: 'admin-token',
      });
      expect((await store.findNode(nodeIdOf(1)))?.approvedAt).not.toBeNull();
    });

    test('reject and retire set their state', async () => {
      await enroll(1);
      expect((await act('reject')).body.node.approval).toBe('rejected');
      expect((await act('retire')).body.node.approval).toBe('retired');
      expect((await act('approve')).body.node).toMatchObject({
        approval: 'approved',
        retiredAt: null,
      });
    });

    test('doing it twice changes nothing and logs once', async () => {
      const { h } = ctx();
      await h.register(1);
      await act('approve');
      await act('approve');
      const approvals = (
        await h.admin('GET', '/v1/events?limit=200')
      ).body.events.filter((e: { kind: string }) => e.kind === 'approved');
      expect(approvals).toHaveLength(1);
    });

    test('404 for an unknown node', async () => {
      for (const verb of ['approve', 'reject', 'retire']) {
        expect((await act(verb, nodeIdOf(9))).status).toBe(404);
      }
    });

    test('an approved node starts receiving its full config', async () => {
      const { h } = ctx();
      await h.register(1);
      await h.admin('PUT', '/v1/settings/fleet', { sync: { paused: true } });
      await act('approve');
      expect((await beat(1)).body.config.values).toEqual({
        sync: { paused: true },
      });
    });
  });

  describe('DELETE /v1/nodes/:id', () => {
    test('forgets the node and its history; events stay and keep the label', async () => {
      const { h } = ctx();
      await enroll(1);
      await enroll(2);
      await beat(1);
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        sync: { paused: true },
      });
      const gone = await h.admin('DELETE', `/v1/nodes/${nodeIdOf(1)}`);
      expect(gone).toMatchObject({ status: 200, body: { ok: true } });
      expect((await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).status).toBe(
        404
      );
      expect((await h.admin('GET', '/v1/nodes')).body.nodes).toHaveLength(1);
      const settings = (await h.admin('GET', '/v1/settings')).body.settings;
      expect(settings.map((s: { scope: string }) => s.scope)).not.toContain(
        `node:${nodeIdOf(1)}`
      );
      const events = (await h.admin('GET', '/v1/events?limit=200')).body.events;
      const label = `ci-${nodeIdOf(1).slice(0, 4)}`;
      expect(
        events.filter((e: { nodeLabel: string }) => e.nodeLabel === label)
          .length
      ).toBeGreaterThan(1);
      expect(
        events.find((e: { kind: string }) => e.kind === 'node_deleted')
      ).toMatchObject({ severity: 'warn', nodeId: null });
    });

    test('404 the second time', async () => {
      const { h } = ctx();
      await enroll(1);
      await h.admin('DELETE', `/v1/nodes/${nodeIdOf(1)}`);
      expect((await h.admin('DELETE', `/v1/nodes/${nodeIdOf(1)}`)).status).toBe(
        404
      );
    });
  });

  test('every node route is closed to node credentials', async () => {
    const { h } = ctx();
    await enroll(1);
    for (const [method, path] of [
      ['GET', '/v1/nodes'],
      ['GET', `/v1/nodes/${nodeIdOf(1)}`],
      ['PATCH', `/v1/nodes/${nodeIdOf(1)}`],
      ['POST', `/v1/nodes/${nodeIdOf(1)}/approve`],
      ['DELETE', `/v1/nodes/${nodeIdOf(1)}`],
    ] as const) {
      const reply = await h.asNode(
        1,
        method,
        path,
        method === 'PATCH' ? { note: 'x' } : undefined
      );
      expect(reply.status).toBe(401);
    }
  });
});
