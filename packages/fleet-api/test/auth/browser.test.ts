import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { sha256Hex } from '../../src/auth/hash';
import { FleetBrowserAuth } from '../../src/auth/browser-auth';
import { FleetAdminAuth } from '../../src/auth/admin-auth';
import { PgAccessStore } from '../../src/db/access-store';
import type { RelayClient } from '../../src/auth/relay-client';
import { mountUi } from '../../src/routes/ui';
import { createTestDeps } from '../../src/testing/test-deps';
import { databaseAvailable, useDatabase } from '../support/database';
import { silent } from '../support/api';

const config = {
  origin: 'https://fleet.example.test',
  issuer: 'https://auth.example.test/realms/projects',
  clientId: 'fleet-test',
};
const jar = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .filter((item) => !item?.endsWith('='))
    .join('; ');

describe.skipIf(!databaseAvailable)(
  'relay browser authorization with real persistent storage',
  () => {
    const database = useDatabase();
    function world(
      email = 'operator@example.test',
      verified = true,
      existing?: RelayClient
    ) {
      const access = new PgAccessStore(database().sql);
      const calls: { state: string; nonce: string; verifier: string }[] = [];
      let exchanges = 0;
      let fail = false;
      const client: RelayClient = {
        async authorize(state, nonce, verifier) {
          calls.push({ state, nonce, verifier });
          return `https://auth.example.test/authorize?state=${state}`;
        },
        async exchange(_url, state, nonce, verifier) {
          exchanges++;
          if (fail) throw new Error('upstream unavailable');
          expect(calls).toContainEqual({ state, nonce, verifier });
          return {
            iss: config.issuer,
            sub: 'stable-google-subject',
            email,
            email_verified: verified,
          };
        },
      };
      const browser = new FleetBrowserAuth(access, config, existing ?? client);
      const app = new Hono();
      const deps = createTestDeps();
      mountUi(app, {
        ...deps,
        browserAuth: browser,
        auth: new FleetAdminAuth({
          env: deps.env,
          now: deps.now,
          fetch,
          log: silent,
          browser,
          publicOrigin: config.origin,
        }),
      });
      const request = (
        path: string,
        cookie = '',
        method = 'GET',
        options: { body?: Record<string, string>; origin?: string } = {}
      ) =>
        app.request(`${config.origin}${path}`, {
          method,
          headers: {
            Cookie: cookie,
            Origin: options.origin ?? config.origin,
            'content-type': 'application/x-www-form-urlencoded',
          },
          ...(options.body ? { body: new URLSearchParams(options.body) } : {}),
        });
      const start = async (next = '/nodes') => {
        const response = await request(
          `/auth/login?next=${encodeURIComponent(next)}`
        );
        expect(response.status).toBe(303);
        return { cookie: jar(response), state: calls.at(-1)!.state };
      };
      const complete = (tx: { state: string; cookie: string }) =>
        request(
          `/auth/callback?state=${tx.state}&code=one-time-code`,
          tx.cookie
        );
      return {
        access,
        client: existing ?? client,
        browser,
        request,
        start,
        complete,
        calls,
        exchanges: () => exchanges,
        fail: () => {
          fail = true;
        },
      };
    }
    test('empty allowlist denies the first Google user and still offers working sign-out', async () => {
      const w = world('new@example.test');
      const signed = await w.complete(await w.start());
      expect(signed.headers.get('location')).toBe('/not-allowed');
      const cookie = jar(signed);
      const denied = await w.request('/not-allowed', cookie);
      expect(denied.status).toBe(403);
      expect(await denied.text()).toContain('Sign out');
      expect((await w.request('/', cookie)).headers.get('location')).toBe(
        '/not-allowed'
      );
      expect((await w.request('/login', cookie)).headers.get('location')).toBe(
        '/not-allowed'
      );
      expect((await w.request('/access', cookie)).headers.get('location')).toBe(
        '/not-allowed'
      );
      expect((await w.request('/logout', cookie, 'POST')).status).toBe(303);
      expect(
        (await w.request('/', cookie)).headers.get('location')
      ).toStartWith('/login');
    });
    test('allowlisted users inherit the UI and can add/revoke emails; access revocation is immediate', async () => {
      const w = world();
      await w.access.allow('operator@example.test', 'database-owner');
      const signed = await w.complete(await w.start());
      const cookie = jar(signed);
      expect(signed.headers.get('location')).toBe('/nodes');
      expect((await w.request('/access', cookie)).status).toBe(200);
      expect(
        (
          await w.request('/access', cookie, 'POST', {
            body: { email: 'Next@Example.test' },
          })
        ).status
      ).toBe(303);
      expect(await w.access.emails()).toContain('next@example.test');
      expect(
        (
          await w.request('/access', cookie, 'POST', {
            body: { action: 'revoke', email: 'next@example.test' },
            origin: 'https://evil.example',
          })
        ).status
      ).toBe(403);
      await w.access.revoke('operator@example.test', 'next@example.test');
      expect((await w.request('/access', cookie)).headers.get('location')).toBe(
        '/not-allowed'
      );
      expect((await w.request('/', cookie)).headers.get('location')).toBe(
        '/not-allowed'
      );
    });
    test('two tabs retain independent transactions; callback replay and missing binding are rejected without code retries', async () => {
      const w = world('tabs@example.test');
      await w.access.allow('tabs@example.test', 'database-owner');
      const one = await w.start(),
        two = await w.start();
      expect(one.cookie.split('=')[0]).not.toBe(two.cookie.split('=')[0]);
      expect(
        (await w.complete({ ...one, cookie: two.cookie })).headers.get(
          'location'
        )
      ).toContain('error=failed');
      expect((await w.complete(one)).headers.get('location')).toBe('/nodes');
      expect((await w.complete(two)).headers.get('location')).toBe('/nodes');
      expect((await w.complete(one)).headers.get('location')).toContain(
        'error=failed'
      );
      expect(w.exchanges()).toBe(2);
    });
    test('unverified Google emails and unavailable upstream fail securely', async () => {
      const w = world('unverified@example.test', false);
      await w.access.allow('unverified@example.test', 'database-owner');
      expect(
        (await w.complete(await w.start())).headers.get('location')
      ).toContain('error=failed');
      const tx = await w.start();
      w.fail();
      expect((await w.complete(tx)).headers.get('location')).toContain(
        'error=failed'
      );
      expect((await w.complete(tx)).headers.get('location')).toContain(
        'error=failed'
      );
      expect(w.exchanges()).toBe(2);
    });
    test('opaque sessions and pending login survive a new application instance; expired and tampered sessions fail', async () => {
      const w = world('restart@example.test');
      await w.access.allow('restart@example.test', 'database-owner');
      const tx = await w.start('//evil.example');
      const restarted = world('restart@example.test', true, w.client);
      const signed = await restarted.complete(tx);
      expect(signed.headers.get('location')).toBe('/');
      const cookie = jar(signed);
      const fresh = world('restart@example.test');
      expect((await fresh.request('/access', cookie)).status).toBe(200);
      expect((await fresh.request('/access', cookie + 'tampered')).status).toBe(
        303
      );
      await database()
        .sql`update fleet.browser_sessions set expires_at = now() - interval '1 second'`;
      expect(
        (await fresh.request('/', cookie)).headers.get('location')
      ).toStartWith('/login');
    });
    test('session tokens cannot be copied between Fleet origins, relay issuers or clients', async () => {
      const w = world('isolation@example.test');
      await w.access.allow('isolation@example.test', 'database-owner');
      const cookie = jar(await w.complete(await w.start()));
      const token = cookie.split('=').at(-1)!;
      for (const changed of [
        { ...config, clientId: 'another-client' },
        { ...config, issuer: 'https://another-relay.test/realms/other' },
        { ...config, origin: 'https://another-fleet.test' },
      ]) {
        const other = new FleetBrowserAuth(w.access, changed);
        const probe = new Hono();
        probe.get('/', async (c) => c.json(await other.identity(c)));
        const copied = `fleet_${sha256Hex(changed.origin).slice(0, 16)}_session=${token}`;
        const result = await probe.request(`${changed.origin}/`, {
          headers: { Cookie: copied },
        });
        expect(await result.json()).toBeNull();
      }
    });
    test('expired transactions are rejected before exchanging an authorization code', async () => {
      const w = world();
      const tx = await w.start();
      await database()
        .sql`update fleet.login_transactions set expires_at=now()-interval '1 second'`;
      expect((await w.complete(tx)).headers.get('location')).toContain(
        'error=failed'
      );
      expect(w.exchanges()).toBe(0);
    });
    test('concurrent removals cannot empty the allowlist and changes are audited', async () => {
      const access = new PgAccessStore(database().sql);
      await database().sql`delete from fleet.allowed_emails`;
      await access.allow('one@example.test', 'owner');
      await access.allow('two@example.test', 'owner');
      const removed = await Promise.all([
        access.revoke('one@example.test', 'owner'),
        access.revoke('two@example.test', 'owner'),
      ]);
      expect(removed.filter(Boolean)).toHaveLength(1);
      expect(await access.emails()).toHaveLength(1);
      const audit = await database()
        .sql`select action from fleet.access_audit where actor='owner'`;
      expect(
        audit.filter(
          (row: Record<string, unknown>) => row['action'] === 'revoke'
        )
      ).toHaveLength(1);
    });
  }
);
