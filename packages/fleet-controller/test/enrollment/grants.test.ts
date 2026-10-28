import { beforeEach, describe, expect, test } from 'bun:test';

import { sha256Hex } from '../../src/auth/hash';
import {
  parseBinding,
  signBinding,
  verifyBinding,
} from '../../src/enrollment/binding';
import { hashGrantToken, validTtl } from '../../src/enrollment/grants';
import { MemoryGrants } from '../../src/enrollment/memory-grants';
import { ADMIN_TOKEN, CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { nodeIdOf } from '../support/fixtures';
import { signInAs } from '../support/session';

const ORIGIN = 'https://fleet.example.org';
const HEADERS = { Authorization: `Bearer ${ADMIN_TOKEN}`, Origin: ORIGIN };

describeController('single-use enrollment grants', (ctx) => {
  beforeEach(async () => {
    const { sql } = ctx().db;
    await sql.unsafe('delete from audit_log');
    await sql.unsafe('delete from enrollment_grants');
  });

  async function issue(json: Record<string, unknown> = {}) {
    const reply = await ctx().h.call('POST', '/v1/enrollment/grants', {
      headers: HEADERS,
      json,
    });
    expect(reply.status).toBe(201);
    return reply.body as {
      grant: { id: string; state: string; role: string | null };
      binding: { grant: string; origin: string; sig: string } & Record<
        string,
        string
      >;
      file: string;
    };
  }

  const check = (json: unknown) =>
    ctx().h.call('POST', '/v1/enrollment/check', { json });

  test('creates a grant: only the hash is stored and the audit never holds the token', async () => {
    const { grant, binding, file } = await issue({
      label: 'Rack 3 spare',
      role: 'ci',
    });
    expect(file).toBe('fleet-bind.json');
    expect(binding.origin).toBe(ORIGIN);
    expect(binding.grant).toMatch(/^fgr_[A-Za-z0-9_-]{43}$/);
    expect(grant.state).toBe('pending');
    const rows = await ctx().db.sql.unsafe(
      'select token_hash, role, label, created_by from enrollment_grants'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['token_hash']).toBe(sha256Hex(binding.grant));
    expect(JSON.stringify(rows)).not.toContain(binding.grant);
    const audit = await ctx().store.listAudit({ limit: 10 });
    expect(audit.map((a) => a.action)).toEqual(['enrollment.grant_create']);
    expect(JSON.stringify(audit)).not.toContain(binding.grant);
    const list = await ctx().h.call('GET', '/v1/enrollment/grants', {
      headers: HEADERS,
    });
    expect(list.text).not.toContain(binding.grant);
    expect(list.text).not.toContain(sha256Hex(binding.grant));
  });

  test('validates the request and refuses viewers', async () => {
    for (const bad of [
      { ttlSeconds: 10 },
      { ttlSeconds: 8 * 24 * 3600 },
      { ttlSeconds: 1.5 },
      { role: 'web' },
      { label: 'x'.repeat(81) },
      { label: 'tab\tinside' },
    ]) {
      const reply = await ctx().h.call('POST', '/v1/enrollment/grants', {
        headers: HEADERS,
        json: bad,
      });
      expect([JSON.stringify(bad), reply.status]).toEqual([
        JSON.stringify(bad),
        400,
      ]);
    }
    const viewer = await signInAs(ctx(), 'viewer@example.test', 'viewer');
    const denied = await viewer.h.call('POST', '/v1/enrollment/grants', {
      headers: { ...viewer.headers, Origin: ORIGIN },
      json: {},
    });
    expect(denied.status).toBe(403);
    const read = await viewer.h.call('GET', '/v1/enrollment/grants', {
      headers: viewer.headers,
    });
    expect(read.status).toBe(200);
    expect(
      await ctx().db.sql.unsafe('select 1 from enrollment_grants')
    ).toHaveLength(0);
  });

  test('check validates without consuming and verifies the signed binding', async () => {
    const { binding } = await issue({ role: 'ci' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await check({
        enrollmentToken: binding.grant,
        binding,
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        ok: true,
        kind: 'grant',
        role: 'ci',
        state: 'pending',
        approval: 'automatic',
      });
      expect(reply.text).not.toContain(binding.grant);
    }
    expect(await ctx().store.listNodes()).toEqual([]);
    const row = await ctx().db.sql.unsafe(
      'select used_at from enrollment_grants'
    );
    expect(row[0]?.['used_at']).toBeNull();
    const tampered = await check({
      enrollmentToken: binding.grant,
      binding: { ...binding, origin: 'https://evil.example.org' },
    });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error).toBe('enrollment_binding_invalid');
    const wrongController = signBinding(
      { keyId: 'abcdef012345', secret: 'another-controllers-secret' },
      {
        origin: ORIGIN,
        grant: binding.grant,
        grantId: binding['grantId'] ?? '',
        issuedAt: binding['issuedAt'] ?? '',
        expiresAt: binding['expiresAt'] ?? '',
      }
    );
    expect(
      (
        await check({
          enrollmentToken: binding.grant,
          binding: wrongController,
        })
      ).status
    ).toBe(401);
    expect(
      (await check({ enrollmentToken: binding.grant, binding: { v: 1 } })).body
        .error
    ).toBe('enrollment_binding_invalid');
  });

  test('a role-less grant is not an automatic approval', async () => {
    const { binding } = await issue();
    const reply = await check({ enrollmentToken: binding.grant });
    expect(reply.body.approval).toBe('manual');
    expect(reply.body.role).toBeNull();
  });

  test('expiry and revocation are enforced by check and register', async () => {
    const expiring = await issue({ ttlSeconds: 600, role: 'ci' });
    const revoked = await issue({ role: 'ci' });
    const revoke = await ctx().h.call(
      'POST',
      `/v1/enrollment/grants/${revoked.grant.id}/revoke`,
      { headers: HEADERS }
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.grant.state).toBe('revoked');
    expect(
      (
        await ctx().h.call(
          'POST',
          `/v1/enrollment/grants/${revoked.grant.id}/revoke`,
          { headers: HEADERS }
        )
      ).status
    ).toBe(200);
    expect(
      (
        await ctx().h.call('POST', '/v1/enrollment/grants/nope/revoke', {
          headers: HEADERS,
        })
      ).status
    ).toBe(404);
    const revokeAudits = (await ctx().store.listAudit({ limit: 50 })).filter(
      (a) => a.action === 'enrollment.grant_revoke'
    );
    expect(revokeAudits).toHaveLength(1);
    expect(
      (await check({ enrollmentToken: revoked.binding.grant })).body.error
    ).toBe('enrollment_grant_revoked');
    const refused = await ctx().h.register(1, {
      enrollmentToken: revoked.binding.grant,
    });
    expect(refused.body).toMatchObject({ status: 'pending', role: null });
    ctx().h.clock.advance(601);
    expect(
      (await check({ enrollmentToken: expiring.binding.grant })).body.error
    ).toBe('enrollment_grant_expired');
    const late = await ctx().h.register(2, {
      enrollmentToken: expiring.binding.grant,
    });
    expect(late.body).toMatchObject({ status: 'pending', role: null });
    const denied = (await ctx().store.listAudit({ limit: 50 })).filter(
      (a) => a.action === 'enrollment.grant_refused'
    );
    expect(denied.map((a) => a.outcome)).toEqual(['denied', 'denied']);
    const list = await ctx().h.call('GET', '/v1/enrollment/grants', {
      headers: HEADERS,
    });
    const states = Object.fromEntries(
      list.body.grants.map((g: { id: string; state: string }) => [
        g.id,
        g.state,
      ])
    );
    expect(states[revoked.grant.id]).toBe('revoked');
    expect(states[expiring.grant.id]).toBe('expired');
  });

  test('a grant with a role approves one node and assigns the role', async () => {
    const { binding, grant } = await issue({ role: 'devbox', label: 'desk' });
    const reply = await ctx().h.register(1, { enrollmentToken: binding.grant });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ status: 'approved', role: 'devbox' });
    const node = await ctx().store.findNode(nodeIdOf(1));
    expect(node?.enrolledVia).toBe('enrollment-token');
    const row = await ctx().store.grants.find(grant.id);
    expect(row?.usedByNode).toBe(nodeIdOf(1));
    expect(row?.usedAt).not.toBeNull();
    const events = await ctx().store.listEvents({ limit: 20 });
    expect(events.map((e) => e.kind)).toContain('enrollment_grant_redeemed');
    const audit = await ctx().store.listAudit({ limit: 20 });
    expect(audit.map((a) => a.action)).toContain('enrollment.grant_redeem');
    expect(JSON.stringify([events, audit])).not.toContain(binding.grant);
  });

  test('a role-less grant leaves the node pending but bound', async () => {
    const { binding, grant } = await issue();
    const reply = await ctx().h.register(1, { enrollmentToken: binding.grant });
    expect(reply.body).toMatchObject({ status: 'pending', role: null });
    expect((await ctx().store.grants.find(grant.id))?.usedByNode).toBe(
      nodeIdOf(1)
    );
  });

  test('a cloned installer cannot enroll a second node: it is pending and flagged', async () => {
    const { binding } = await issue({ role: 'ci' });
    const first = await ctx().h.register(1, { enrollmentToken: binding.grant });
    const clone = await ctx().h.register(2, { enrollmentToken: binding.grant });
    expect(first.body.status).toBe('approved');
    expect(clone.body).toMatchObject({ status: 'pending', role: null });
    const events = await ctx().store.listEvents({ limit: 20 });
    const reused = events.filter((e) => e.kind === 'enrollment_grant_reused');
    expect(reused.map((e) => e.nodeId).sort()).toEqual(
      [nodeIdOf(1), nodeIdOf(2)].sort()
    );
    expect(reused.every((e) => e.severity === 'warn')).toBe(true);
    const audit = (await ctx().store.listAudit({ limit: 20 })).find(
      (a) => a.action === 'enrollment.grant_reused'
    );
    expect(audit?.outcome).toBe('denied');
    expect((await ctx().store.findNode(nodeIdOf(1)))?.approval).toBe(
      'approved'
    );
    const check2 = await check({ enrollmentToken: binding.grant });
    expect(check2.body.state).toBe('used');
    expect(check2.body.approval).toBe('manual');
  });

  test('concurrent redemptions: exactly one node wins', async () => {
    const { binding, grant } = await issue({ role: 'ci' });
    const replies = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
        ctx().h.register(n, { enrollmentToken: binding.grant })
      )
    );
    const approved = replies.filter((r) => r.body.status === 'approved');
    expect(approved).toHaveLength(1);
    expect(replies.filter((r) => r.body.status === 'pending')).toHaveLength(7);
    const winner = (await ctx().store.grants.find(grant.id))?.usedByNode;
    const nodes = await ctx().store.listNodes();
    expect(
      nodes.filter((n) => n.approval === 'approved').map((n) => n.id)
    ).toEqual([winner ?? '']);
    expect(nodes.filter((n) => n.role !== null)).toHaveLength(1);
    const events = await ctx().store.listEvents({ limit: 100 });
    expect(
      events.filter((e) => e.kind === 'enrollment_grant_redeemed')
    ).toHaveLength(1);
  });

  test('the bound node may retry with the same grant (an interrupted install)', async () => {
    const { binding } = await issue({ role: 'ci' });
    await ctx().h.register(1, { enrollmentToken: binding.grant });
    const again = await ctx().h.register(1, { enrollmentToken: binding.grant });
    expect(again.body).toMatchObject({ status: 'approved', role: 'ci' });
    const actions = (await ctx().store.listAudit({ limit: 20 })).map(
      (a) => a.action
    );
    expect(actions).toContain('enrollment.grant_resume');
    const events = await ctx().store.listEvents({ limit: 50 });
    expect(events.map((e) => e.kind)).not.toContain('enrollment_grant_reused');
  });

  test('an unknown grant-shaped token is just pending and creates no grant record', async () => {
    const reply = await ctx().h.register(1, {
      enrollmentToken: `fgr_${'A'.repeat(43)}`,
    });
    expect(reply.body.status).toBe('pending');
    expect(
      (await ctx().store.listAudit({ limit: 20 })).filter((a) =>
        a.action.startsWith('enrollment.grant')
      )
    ).toEqual([]);
  });

  test('static enrollment tokens still approve and are never treated as grants', async () => {
    const reply = await ctx().h.register(1, {
      enrollmentToken: CI_ENROLLMENT_TOKEN,
    });
    expect(reply.body).toMatchObject({ status: 'approved', role: 'ci' });
    expect(
      (await ctx().store.listAudit({ limit: 20 })).filter((a) =>
        a.action.startsWith('enrollment.grant')
      )
    ).toEqual([]);
  });

  test('a failed registration releases the grant instead of burning it', async () => {
    const { binding, grant } = await issue({ role: 'ci' });
    const real = ctx().store;
    const failing = new Proxy(real, {
      get(target, property) {
        if (property === 'registerNode')
          return async () => {
            throw new Error('database unavailable');
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const broken = ctx().harness();
    Object.assign(broken.deps, { store: failing });
    const reply = await broken.register(1, { enrollmentToken: binding.grant });
    expect(reply.status).toBe(500);
    const row = await real.grants.find(grant.id);
    expect(row?.usedAt).toBeNull();
    const retry = await ctx().h.register(2, { enrollmentToken: binding.grant });
    expect(retry.body.status).toBe('approved');
  });
});

describe('binding and grant primitives', () => {
  const key = { keyId: 'k1', secret: 's'.repeat(64) };
  const fields = {
    origin: 'https://fleet.example.org',
    grant: `fgr_${'a'.repeat(43)}`,
    grantId: 'g1',
    issuedAt: '2026-10-14T12:00:00.000Z',
    expiresAt: '2026-10-15T12:00:00.000Z',
  };

  test('a signature covers every field and the key', () => {
    const binding = signBinding(key, fields);
    expect(verifyBinding(key, binding)).toBe(true);
    expect(parseBinding(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
    for (const change of [
      { origin: 'https://other.example.org' },
      { grant: `fgr_${'b'.repeat(43)}` },
      { grantId: 'g2' },
      { issuedAt: '2026-10-14T12:00:01.000Z' },
      { expiresAt: '2026-10-30T12:00:00.000Z' },
    ])
      expect(verifyBinding(key, { ...binding, ...change })).toBe(false);
    expect(verifyBinding({ ...key, secret: 'x'.repeat(64) }, binding)).toBe(
      false
    );
    expect(verifyBinding({ ...key, keyId: 'k2' }, binding)).toBe(false);
  });

  test('parse rejects malformed documents', () => {
    const binding = signBinding(key, fields);
    for (const bad of [
      null,
      [],
      'x',
      { ...binding, v: 2 },
      { ...binding, sig: 'zz' },
      { ...binding, origin: 5 },
      { ...binding, grant: 'has space' },
    ])
      expect(parseBinding(bad)).toBeNull();
  });

  test('ttl bounds', () => {
    expect(validTtl(299)).toBeNull();
    expect(validTtl(300)).toBe(300);
    expect(validTtl(7 * 86400)).toBe(7 * 86400);
    expect(validTtl(7 * 86400 + 1)).toBeNull();
    expect(validTtl('3600')).toBeNull();
  });

  test('the in-memory store has the same single-use semantics', async () => {
    const grants = new MemoryGrants();
    const now = new Date('2026-10-14T12:00:00.000Z');
    await grants.create({
      id: 'g',
      tokenHash: hashGrantToken('fgr_x'),
      role: null,
      label: null,
      createdBy: 'a',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1000),
    });
    const hash = hashGrantToken('fgr_x');
    expect((await grants.redeem(hash, 'n1', now)).outcome).toBe('redeemed');
    expect((await grants.redeem(hash, 'n1', now)).outcome).toBe('resumed');
    expect((await grants.redeem(hash, 'n2', now)).outcome).toBe('reused');
    expect(
      (await grants.redeem(hash, 'n1', new Date(now.getTime() + 2000))).outcome
    ).toBe('expired');
    expect((await grants.redeem('0'.repeat(64), 'n1', now)).outcome).toBe(
      'unknown'
    );
    const first = await grants.bindingKey();
    expect(await grants.bindingKey()).toEqual(first);
  });
});

describeController('binding key', (ctx) => {
  test('is generated randomly once and then stable across store instances', async () => {
    await ctx().db.sql.unsafe('delete from controller_secrets');
    const [a, b] = await Promise.all([
      ctx().store.grants.bindingKey(),
      ctx().store.grants.bindingKey(),
    ]);
    expect(a).toEqual(b);
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    const other = await ctx().db.newStore();
    expect(await other.store.grants.bindingKey()).toEqual(a);
    await other.close();
  });
});
