import { expect, test } from 'bun:test';

import { desiredRevision } from '../../src/domain/desired-state';
import { CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import {
  heartbeatBody,
  nodeIdOf,
  type HeartbeatOverrides,
} from '../support/fixtures';

const recipient = (c: string) => `age1${c.repeat(58)}`;

describeController('desired state', (ctx) => {
  const beat = (n = 1, overrides: HeartbeatOverrides = {}) =>
    ctx().h.asNode(n, 'POST', '/v1/heartbeat', heartbeatBody(n, overrides));
  const patchRole = (role: string | null, n = 1) =>
    ctx().h.admin('PATCH', `/v1/nodes/${nodeIdOf(n)}`, { role });

  test('a v1 heartbeat is refused as an unsupported version and stores nothing', async () => {
    const { h, store } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const reply = await h.asNode(1, 'POST', '/v1/heartbeat', {
      ...heartbeatBody(1),
      v: 1,
      agent: { version: '1', configRevision: null },
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe('unsupported_version');
    expect((await store.findNode(nodeIdOf(1)))?.lastSeenAt).toBeNull();
  });

  test('a heartbeat never changes the assigned role; it records what the node runs', async () => {
    const { h, store } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const reply = await beat(1, {
      role: 'devbox',
      closure: 'devbox',
      hardware: { capabilities: ['gpu'] },
      ageRecipient: recipient('q'),
      reconcile: { phase: 'progressing', issues: [] },
    });
    expect(reply.body.desired).toMatchObject({ role: 'ci', closure: 'ci-gpu' });
    expect(await store.findNode(nodeIdOf(1))).toMatchObject({
      role: 'ci',
      observedRole: 'devbox',
      observedClosure: 'devbox',
      hardware: { capabilities: ['gpu'] },
      ageRecipient: recipient('q'),
      reconcile: { phase: 'progressing', issues: [] },
    });
    await beat(1, { role: 'base', closure: 'base' });
    expect((await store.findNode(nodeIdOf(1)))?.role).toBe('ci');
  });

  test('pending: role and closure null; approved without a role: base', async () => {
    const { h } = ctx();
    await h.register(1, { role: 'ci' });
    expect((await beat(1)).body.desired).toMatchObject({
      role: null,
      closure: null,
    });
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`);
    const approved = (await beat(1)).body.desired;
    expect(approved).toMatchObject({ role: null, closure: 'base', values: {} });
    expect(approved.revision).toBe(
      desiredRevision({ role: null, closure: 'base', values: {} })
    );
  });

  test('settings follow the assigned role, not the reported one', async () => {
    const { h } = ctx();
    await h.register(1);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`);
    await h.admin('PUT', '/v1/settings/role:ci', { sync: { paused: true } });
    expect((await beat(1, { role: 'ci' })).body.desired.values).toEqual({});
    await patchRole('ci');
    expect((await beat(1, { role: 'base' })).body.desired.values).toEqual({
      sync: { paused: true },
    });
  });

  test('secrets.rotateAgeKeyAfter reaches the node from any scope, the node scope winning', async () => {
    const { h } = ctx();
    await h.register(1);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, { role: 'ci' });
    await h.admin('PUT', '/v1/settings/fleet', {
      secrets: { rotateAgeKeyAfter: 1_700_000_000 },
    });
    expect((await beat(1)).body.desired.values).toEqual({
      secrets: { rotateAgeKeyAfter: 1_700_000_000 },
    });
    await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
      secrets: { rotateAgeKeyAfter: 1_800_000_000 },
    });
    expect((await beat(1)).body.desired.values).toEqual({
      secrets: { rotateAgeKeyAfter: 1_800_000_000 },
    });
    const refused = await h.admin('PUT', '/v1/settings/role:ci', {
      secrets: { rotateAgeKeyAfter: -1 },
    });
    expect(refused.status).toBe(400);
  });

  test('the revision changes when the role or the closure changes, and desired is omitted once acknowledged', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const first = (await beat(1)).body.desired;
    expect(first.closure).toBe('ci');
    const ack = { agent: { version: '2', desiredRevision: first.revision } };
    expect('desired' in (await beat(1, ack)).body).toBe(false);
    const gpu = (await beat(1, { ...ack, hardware: { capabilities: ['gpu'] } }))
      .body.desired;
    expect(gpu.closure).toBe('ci-gpu');
    expect(gpu.revision).not.toBe(first.revision);
    await patchRole('devbox');
    const devbox = (
      await beat(1, {
        agent: { version: '2', desiredRevision: gpu.revision },
        hardware: { capabilities: ['gpu'] },
      })
    ).body.desired;
    expect(devbox).toMatchObject({ role: 'devbox', closure: 'devbox' });
    expect(devbox.revision).not.toBe(gpu.revision);
  });

  test('derived events: role_converged and reconcile_blocked, once per change', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat(1, { role: 'base', closure: 'base' });
    const blocked = {
      role: 'base',
      closure: 'base',
      reconcile: {
        phase: 'blocked',
        issues: ['FLEET_SECRETS_RECIPIENT_MISSING: x'],
      },
    } as const;
    await beat(1, blocked);
    await beat(1, blocked);
    await beat(1, { role: 'ci', closure: 'ci' });
    await beat(1, { role: 'ci', closure: 'ci' });
    const kinds = (await h.admin('GET', '/v1/events?limit=200')).body.events
      .map((e: { kind: string }) => e.kind)
      .filter(
        (k: string) => k === 'role_converged' || k === 'reconcile_blocked'
      );
    expect(kinds).toEqual(['role_converged', 'reconcile_blocked']);
  });
});

describeController('assigning roles', (ctx) => {
  test('PATCH role assigns, changes and unassigns, recording role_assigned with the actor', async () => {
    const { h, store } = ctx();
    await h.register(1);
    const assigned = await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, {
      role: 'ci',
      note: 'rack 2',
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.node).toMatchObject({ role: 'ci', note: 'rack 2' });
    await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { role: 'devbox' });
    await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { role: 'devbox' });
    await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { role: null });
    expect((await store.findNode(nodeIdOf(1)))?.role).toBeNull();
    const events = (await h.admin('GET', '/v1/events?limit=200')).body.events
      .filter((e: { kind: string }) => e.kind === 'role_assigned')
      .reverse();
    expect(events.map((e: { data: unknown }) => e.data)).toEqual([
      { role: 'ci', previous: null, actor: 'admin-token' },
      { role: 'devbox', previous: 'ci', actor: 'admin-token' },
      { role: null, previous: 'devbox', actor: 'admin-token' },
    ]);
  });

  test('PATCH role on an unknown node is 404', async () => {
    const reply = await ctx().h.admin('PATCH', `/v1/nodes/${nodeIdOf(9)}`, {
      role: 'ci',
    });
    expect(reply.status).toBe(404);
  });

  test('approve accepts an optional { role } and refuses anything else', async () => {
    const { h, store } = ctx();
    await h.register(1);
    await h.register(2);
    const bad = await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, {
      role: 'web',
    });
    expect(bad.status).toBe(400);
    expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('pending');
    const other = await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, {
      approval: 'x',
    });
    expect(other.status).toBe(400);
    const ok = await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, {
      role: 'devbox',
    });
    expect(ok.body.node).toMatchObject({
      approval: 'approved',
      role: 'devbox',
      desiredClosure: 'devbox',
      convergence: 'unknown',
    });
    const plain = await h.admin('POST', `/v1/nodes/${nodeIdOf(2)}/approve`);
    expect(plain.body.node).toMatchObject({ approval: 'approved', role: null });
  });

  test('the node view shows desired against observed and convergence', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const first = await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));
    const revision = first.body.desired.revision;
    await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, {
        agent: { version: '2', desiredRevision: revision },
        reconcile: { phase: 'converged', issues: [] },
      })
    );
    const view = (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node;
    expect(view).toMatchObject({
      role: 'ci',
      observedRole: 'ci',
      observedClosure: 'ci',
      desiredClosure: 'ci',
      desiredRevision: revision,
      appliedRevision: revision,
      convergence: 'converged',
      reconcileIssues: [],
      hardwareCapabilities: [],
    });
    const metrics = (await h.admin('GET', '/metrics')).text;
    expect(metrics).toContain(
      `fleet_node_converged{node="ci-${nodeIdOf(1).slice(0, 4)}",role="ci"} 1`
    );
    await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { role: 'devbox' });
    const moved = (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node;
    expect(moved).toMatchObject({
      desiredClosure: 'devbox',
      convergence: 'progressing',
    });
  });
});

describeController('GET /v1/recipients', (ctx) => {
  test('lists reported recipients of approved, assigned nodes by role, sorted', async () => {
    const { h } = ctx();
    const report = (n: number, c: string) =>
      h.asNode(
        n,
        'POST',
        '/v1/heartbeat',
        heartbeatBody(n, {
          hostname: `host-${n}`,
          ageRecipient: recipient(c),
          // Node 2 is rotating: it reports the next recipient too.
          ...(n === 2 ? { ageRecipientNext: recipient('x') } : {}),
        })
      );
    for (const n of [1, 2, 3, 4, 5]) await h.register(n);
    const keys: Record<number, string> = { 1: 'p', 2: 'z', 3: 'r', 4: 'y' };
    for (const n of [1, 2, 3, 4]) await report(n, keys[n] ?? 'q');
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, { role: 'ci' });
    await h.admin('POST', `/v1/nodes/${nodeIdOf(2)}/approve`, { role: 'ci' });
    await h.admin('POST', `/v1/nodes/${nodeIdOf(3)}/approve`);
    await h.admin('PATCH', `/v1/nodes/${nodeIdOf(4)}`, { role: 'devbox' });
    await h.admin('POST', `/v1/nodes/${nodeIdOf(5)}/approve`, {
      role: 'devbox',
    });
    const reply = await h.admin('GET', '/v1/recipients');
    expect(reply.status).toBe(200);
    const node2 = (await h.admin('GET', `/v1/nodes/${nodeIdOf(2)}`)).body.node;
    expect(node2.ageRecipientNext).toBe(recipient('x'));
    expect(reply.body).toEqual({
      roles: {
        ci: [
          {
            nodeId: nodeIdOf(1),
            hostname: 'host-1',
            recipient: recipient('p'),
            next: null,
          },
          {
            nodeId: nodeIdOf(2),
            hostname: 'host-2',
            recipient: recipient('z'),
            next: recipient('x'),
          },
        ],
        devbox: [],
      },
    });
  });

  test('needs an administrator', async () => {
    expect((await ctx().h.call('GET', '/v1/recipients')).status).toBe(401);
  });
});
