import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { FleetAdminAuth } from '../../src/auth/admin-auth';
import { FleetBrowserAuth } from '../../src/auth/browser-auth';
import { sha256Hex } from '../../src/auth/hash';
import type { AccessRole } from '../../src/auth/roles';
import { SqliteAccessStore } from '../../src/db/access-store';
import { mountUi } from '../../src/routes/ui';
import { SqliteStore } from '../../src/db/sqlite-store';
import { createTestDeps } from '../../src/testing/test-deps';
import { useDatabase } from '../support/database';

const config = {
  origin: 'https://fleet.example.test',
  issuer: 'https://auth.example.test/realms/projects',
  clientId: 'fleet-test',
};
const nothing = {
  async authorize(): Promise<string> {
    throw new Error('unused');
  },
  async exchange(): Promise<Record<string, unknown>> {
    throw new Error('unused');
  },
};

describe('roles on the access page', () => {
  const database = useDatabase();

  async function world(people: [string, AccessRole][]) {
    await database().reset();
    await database().sql.unsafe('delete from audit_log');
    const access = new SqliteAccessStore(database().sql);
    const store = new SqliteStore(database().sql);
    const browser = new FleetBrowserAuth(
      access,
      config,
      nothing,
      () => new Date()
    );
    const context = sha256Hex(
      JSON.stringify([config.issuer, config.clientId, config.origin])
    );
    const cookies = new Map<string, string>();
    for (const [email, role] of people) {
      await access.allow(email, 'owner', role);
      const token = sha256Hex(email).slice(0, 43);
      await access.createSession(
        sha256Hex(token),
        { issuer: config.issuer, subject: `s-${email}`, email },
        new Date(Date.now() + 3600_000),
        context
      );
      cookies.set(
        email,
        `fleet_${sha256Hex(config.origin).slice(0, 16)}_session=${token}`
      );
    }
    const deps = createTestDeps();
    const app = new Hono();
    mountUi(app, {
      ...deps,
      store,
      browserAuth: browser,
      auth: new FleetAdminAuth({
        env: deps.env,
        browser,
        publicOrigin: config.origin,
      }),
    });
    const request = (
      email: string,
      method: string,
      body?: Record<string, string>,
      accept?: string
    ) =>
      app.request(`${config.origin}/access`, {
        method,
        headers: {
          Cookie: cookies.get(email) ?? '',
          Origin: config.origin,
          'content-type': 'application/x-www-form-urlencoded',
          ...(accept ? { accept } : {}),
        },
        ...(body ? { body: new URLSearchParams(body) } : {}),
      });
    return { access, store, request };
  }

  test('an admin adds a viewer, promotes and removes; each step is audited', async () => {
    const w = await world([['admin@example.test', 'admin']]);
    expect(
      (
        await w.request('admin@example.test', 'POST', {
          email: 'vera@example.test',
          role: 'viewer',
        })
      ).status
    ).toBe(303);
    expect((await w.access.entries()).map((e) => [e.email, e.role])).toEqual([
      ['admin@example.test', 'admin'],
      ['vera@example.test', 'viewer'],
    ]);
    const page = await (await w.request('admin@example.test', 'GET')).text();
    expect(page).toContain('vera@example.test');
    expect(page).toContain('Change role');
    expect(
      (
        await w.request('admin@example.test', 'POST', {
          email: 'vera@example.test',
          action: 'role',
          role: 'admin',
        })
      ).status
    ).toBe(303);
    expect(
      (
        await w.request('admin@example.test', 'POST', {
          email: 'vera@example.test',
          action: 'revoke',
        })
      ).status
    ).toBe(303);
    const audit = await w.store.listAudit({
      targetKind: 'access',
      targetId: 'vera@example.test',
      limit: 10,
    });
    expect(audit.map((row) => row.action)).toEqual([
      'access.revoke',
      'access.role',
      'access.allow',
    ]);
    expect(audit.every((row) => row.actor === 'admin@example.test')).toBe(true);
  });

  test('the last admin cannot be demoted or removed, even by themselves; the answer says why', async () => {
    const w = await world([
      ['admin@example.test', 'admin'],
      ['vera@example.test', 'viewer'],
    ]);
    const demote = await w.request('admin@example.test', 'POST', {
      email: 'admin@example.test',
      action: 'role',
      role: 'viewer',
    });
    expect(demote.status).toBe(409);
    expect(await demote.text()).toContain('last administrator');
    const remove = await w.request('admin@example.test', 'POST', {
      email: 'admin@example.test',
      action: 'revoke',
    });
    expect(remove.status).toBe(409);
    expect(
      (await w.access.entries()).find((e) => e.email === 'admin@example.test')
        ?.role
    ).toBe('admin');
    const failed = await w.store.listAudit({
      targetKind: 'access',
      targetId: 'admin@example.test',
      limit: 5,
    });
    expect(failed.filter((row) => row.outcome === 'failed')).toHaveLength(2);
  });

  test('a viewer reads the list but every change is 403 and audited as denied', async () => {
    const w = await world([
      ['admin@example.test', 'admin'],
      ['vera@example.test', 'viewer'],
    ]);
    const page = await (await w.request('vera@example.test', 'GET')).text();
    expect(page).toContain('admin@example.test');
    expect(page).toContain('read only');
    expect(page).not.toContain('Change role');
    for (const body of [
      { email: 'vera@example.test', action: 'role', role: 'admin' },
      { email: 'x@example.test', role: 'admin' },
      { email: 'admin@example.test', action: 'revoke' },
    ]) {
      const reply = await w.request('vera@example.test', 'POST', body);
      expect(reply.status).toBe(403);
      expect(await reply.text()).toContain('viewer');
    }
    const json = await w.request(
      'vera@example.test',
      'POST',
      { email: 'x@example.test' },
      'application/json'
    );
    expect(json.status).toBe(403);
    expect(await json.json()).toMatchObject({ code: 'forbidden' });
    expect((await w.access.entries()).map((e) => e.email)).toEqual([
      'admin@example.test',
      'vera@example.test',
    ]);
    const denied = await w.store.listAudit({
      actor: 'vera@example.test',
      limit: 10,
    });
    expect(denied).toHaveLength(4);
    expect(denied.every((row) => row.outcome === 'denied')).toBe(true);
  });

  test('a bad role is a 400 and nothing changes', async () => {
    const w = await world([['admin@example.test', 'admin']]);
    const reply = await w.request('admin@example.test', 'POST', {
      email: 'x@example.test',
      role: 'owner',
    });
    expect(reply.status).toBe(400);
    expect(await w.access.emails()).toEqual(['admin@example.test']);
  });

  test('the owner CLI path (allow with a role, setRole) adds admins and can repair a viewer', async () => {
    const w = await world([['admin@example.test', 'admin']]);
    await w.access.allow('owner@example.test', 'owner-cli');
    expect(
      (await w.access.entries()).find((e) => e.email === 'owner@example.test')
        ?.role
    ).toBe('admin');
    await w.access.allow('v@example.test', 'owner-cli', 'viewer');
    expect(await w.access.setRole('v@example.test', 'admin', 'owner-cli')).toBe(
      'changed'
    );
  });
});
