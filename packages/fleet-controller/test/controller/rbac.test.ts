import { beforeEach, expect, test } from 'bun:test';

import { ADMIN_TOKEN, CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { nodeIdOf } from '../support/fixtures';
import { signInAs } from '../support/session';
import { adminConfirmed } from '../support/confirm';

const WRITES: readonly (readonly [string, string, unknown?])[] = [
  ['PATCH', `/v1/nodes/${nodeIdOf(1)}`, { note: 'x' }],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/approve`],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/reject`],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/retire`],
  ['DELETE', `/v1/nodes/${nodeIdOf(1)}`],
  ['PUT', '/v1/settings/fleet', {}],
  ['POST', '/v1/settings/fleet/restore', { historyId: 1 }],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/rotate-credential`],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/revoke-credential`],
];
const READS = [
  '/v1/nodes',
  `/v1/nodes/${nodeIdOf(1)}`,
  '/v1/summary',
  '/v1/events',
  '/v1/settings',
  '/v1/settings/fleet',
  '/v1/settings/fleet/history',
  `/v1/nodes/${nodeIdOf(1)}/credential`,
  `/v1/nodes/${nodeIdOf(1)}/desired-history`,
];

describeController('role-based access (viewer and admin)', (ctx) => {
  beforeEach(async () => {
    await ctx().db.sql.unsafe('delete from audit_log');
  });
  test('a viewer reads every GET but every write is 403 forbidden and audited as denied', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const viewer = await signInAs(ctx(), 'viewer@example.test', 'viewer');
    for (const path of READS) {
      const reply = await viewer.h.call('GET', path, {
        headers: viewer.headers,
      });
      expect([path, reply.status]).toEqual([path, 200]);
    }
    for (const [method, path, json] of WRITES) {
      const reply = await viewer.h.call(method, path, {
        headers: viewer.headers,
        ...(json === undefined ? {} : { json }),
      });
      expect([method, path, reply.status]).toEqual([method, path, 403]);
      expect(reply.body.error).toBe('forbidden');
      expect(reply.body.message).toContain('viewer');
    }
    const audit = await ctx().store.listAudit({
      actor: 'viewer@example.test',
      limit: WRITES.length,
    });
    expect(audit).toHaveLength(WRITES.length);
    expect(
      audit.every(
        (row) => row.outcome === 'denied' && row.actorRole === 'viewer'
      )
    ).toBe(true);
    // Nothing changed.
    expect((await ctx().store.findNode(nodeIdOf(1)))?.approval).toBe(
      'approved'
    );
  });

  test('an admin session writes, and the admin Bearer token is an admin', async () => {
    const { h } = ctx();
    await h.register(1);
    const admin = await signInAs(ctx(), 'admin@example.test', 'admin');
    const ok = await admin.h.call('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, {
      headers: admin.headers,
    });
    expect(ok.status).toBe(200);
    expect(
      (await adminConfirmed(h, 'POST', `/v1/nodes/${nodeIdOf(1)}/retire`, 1))
        .status
    ).toBe(200);
  });

  test('a viewer cookie cannot be used cross-site and a viewer token header does not exist', async () => {
    const viewer = await signInAs(ctx(), 'v@example.test', 'viewer');
    const reply = await viewer.h.call('PUT', '/v1/settings/fleet', {
      headers: { Cookie: viewer.cookie, Origin: 'https://evil.example' },
      json: {},
    });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe('cross_origin');
  });

  test('demoting an admin applies to the live session at once, and the last admin is protected', async () => {
    const owner = await signInAs(ctx(), 'owner@example.test', 'admin', 'o');
    const second = await signInAs(ctx(), 'second@example.test', 'admin', 't');
    const write = () =>
      second.h.call('PUT', '/v1/settings/fleet', {
        headers: second.headers,
        json: {},
      });
    expect((await write()).status).toBe(200);
    expect(
      await owner.access.setRole(
        'second@example.test',
        'viewer',
        'owner@example.test'
      )
    ).toBe('changed');
    expect((await write()).status).toBe(403);
    // owner is now the only admin
    expect(
      await owner.access.setRole(
        'owner@example.test',
        'viewer',
        'owner@example.test'
      )
    ).toBe('last_admin');
    expect(await owner.access.revoke('owner@example.test', 'x')).toBe(false);
    expect(
      await owner.access.revoke('second@example.test', 'owner@example.test')
    ).toBe(true);
    expect(
      await owner.access.setRole('nobody@example.test', 'admin', 'x')
    ).toBe('missing');
    const entries = await owner.access.entries();
    expect(entries.map((entry) => [entry.email, entry.role])).toEqual([
      ['owner@example.test', 'admin'],
    ]);
  });

  test('role changes are audited with who, whom and from/to', async () => {
    const owner = await signInAs(ctx(), 'owner@example.test', 'admin', 'o');
    await owner.access.allow('v@example.test', 'owner@example.test', 'viewer');
    await owner.access.setRole('v@example.test', 'admin', 'owner@example.test');
    const rows = await ctx().store.listAudit({
      targetKind: 'access',
      targetId: 'v@example.test',
      limit: 2,
    });
    expect(rows.map((row) => row.action)).toEqual([
      'access.role',
      'access.allow',
    ]);
    expect(rows.map((row) => row.actor)).toEqual([
      'owner@example.test',
      'owner@example.test',
    ]);
    expect(rows[0]?.detail).toEqual({ from: 'viewer', to: 'admin' });
  });

  test('a viewer sees the alert webhook URL masked', async () => {
    const { h } = ctx();
    const url = 'https://hooks.example/services/T000/B000/secrettoken';
    expect(
      (
        await h.admin('PUT', '/v1/settings/fleet', {
          alerts: { webhookUrl: url },
        })
      ).status
    ).toBe(200);
    const viewer = await signInAs(ctx(), 'v@example.test', 'viewer');
    const seen = await viewer.h.call('GET', '/v1/settings/fleet', {
      headers: viewer.headers,
    });
    expect(JSON.stringify(seen.body)).not.toContain('secrettoken');
    expect(seen.body.value.alerts.webhookUrl).toBe('https://hooks.example/…');
    const admin = await h.admin('GET', '/v1/settings/fleet');
    expect(admin.body.value.alerts.webhookUrl).toBe(url);
  });

  test('the next admin token is accepted alongside the current one', async () => {
    const next = 'the-next-admin-token-for-rotation-0123456789';
    const h = ctx().harness({ env: { adminTokenNext: next } });
    for (const token of [ADMIN_TOKEN, next]) {
      expect(
        (
          await h.call('GET', '/v1/nodes', {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status
      ).toBe(200);
    }
    expect(
      (
        await h.call('GET', '/v1/nodes', {
          headers: { Authorization: `Bearer ${next}x` },
        })
      ).status
    ).toBe(401);
    // Without NEXT configured the next value is just a wrong token.
    expect(
      (
        await ctx().h.call('GET', '/v1/nodes', {
          headers: { Authorization: `Bearer ${next}` },
        })
      ).status
    ).toBe(401);
  });
});
