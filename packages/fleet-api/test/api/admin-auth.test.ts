import { describe, expect, test } from 'bun:test';

import { FleetBrowserAuth } from '../../src/auth/browser-auth';
import { PgAccessStore } from '../../src/db/access-store';
import { sha256Hex } from '../../src/auth/hash';
import { ADMIN_TOKEN, CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';
import { nodeIdOf } from '../support/fixtures';

const ADMIN_ROUTES: readonly (readonly [string, string, unknown?])[] = [
  ['GET', '/v1/nodes'],
  ['GET', `/v1/nodes/${nodeIdOf(1)}`],
  ['PATCH', `/v1/nodes/${nodeIdOf(1)}`, { note: 'x' }],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/approve`],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/reject`],
  ['POST', `/v1/nodes/${nodeIdOf(1)}/retire`],
  ['DELETE', `/v1/nodes/${nodeIdOf(1)}`],
  ['GET', '/v1/summary'],
  ['GET', '/v1/events'],
  ['GET', '/v1/settings'],
  ['GET', '/v1/settings/fleet'],
  ['PUT', '/v1/settings/fleet', {}],
  ['GET', '/v1/settings/fleet/history'],
  ['GET', '/metrics'],
];

describeApi('admin authentication', (ctx) => {
  test('every admin route answers 401 to an anonymous caller, before touching the data', async () => {
    const { h } = ctx();
    for (const [method, path, json] of ADMIN_ROUTES) {
      const reply = await h.call(
        method,
        path,
        json === undefined ? {} : { json }
      );
      expect(reply.status).toBe(401);
      expect(reply.body.error).toBe('unauthorized');
    }
  });

  test('a wrong, partial, padded or differently-schemed token is refused', async () => {
    const { h } = ctx();
    const attempts = [
      `Bearer ${ADMIN_TOKEN.slice(0, -1)}`,
      `Bearer ${ADMIN_TOKEN} `.trimEnd() + 'x',
      `bearer ${ADMIN_TOKEN}`,
      `Token ${ADMIN_TOKEN}`,
      ADMIN_TOKEN,
      'Bearer',
      'Bearer ',
      `Bearer ${CI_ROLE_TOKEN}`,
    ];
    for (const Authorization of attempts) {
      expect(
        (await h.call('GET', '/v1/nodes', { headers: { Authorization } }))
          .status
      ).toBe(401);
    }
  });

  test('a node credential does not open admin routes', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    for (const [method, path, json] of ADMIN_ROUTES) {
      const reply = await h.asNode(1, method, path, json);
      expect(reply.status).toBe(401);
    }
  });

  test('the bearer token opens every admin route', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    for (const [method, path, json] of ADMIN_ROUTES) {
      const reply = await h.admin(method, path, json);
      expect([200, 404]).toContain(reply.status);
      expect(reply.status).not.toBe(401);
    }
  });

  test('401 never says whether a token, a cookie or a node was the problem', async () => {
    const { h } = ctx();
    const none = await h.call('GET', '/v1/nodes');
    const bad = await h.call('GET', '/v1/nodes', {
      headers: { Authorization: 'Bearer wrong', Cookie: 'fleet_session=x.1.y' },
    });
    expect(bad.body).toEqual(none.body);
  });

  describe('with a signed-in session', () => {
    const signIn = async () => {
      const access = new PgAccessStore(ctx().db.sql);
      await access.allow('chris@example.test', 'test-owner');
      const token = 's'.repeat(43);
      await access.createSession(
        sha256Hex(token),
        {
          issuer: 'https://relay.example/realms/test',
          subject: 'google-user',
          email: 'chris@example.test',
        },
        new Date(Date.now() + 43200000),
        sha256Hex(
          JSON.stringify([
            'https://relay.example/realms/test',
            'fleet',
            'http://localhost',
          ])
        )
      );
      const browser = new FleetBrowserAuth(access, {
        origin: 'http://localhost',
        issuer: 'https://relay.example/realms/test',
        clientId: 'fleet',
      });
      const h = ctx().harness({ browser });
      const cookie = `fleet_${sha256Hex('http://localhost').slice(0, 16)}_session=${token}`;
      return { h, cookie };
    };
    const same = { Origin: 'http://localhost' };

    test('reads work with just the cookie', async () => {
      const { h, cookie } = await signIn();
      expect(
        (await h.call('GET', '/v1/nodes', { headers: { Cookie: cookie } }))
          .status
      ).toBe(200);
      expect(
        (await h.call('GET', '/metrics', { headers: { Cookie: cookie } }))
          .status
      ).toBe(200);
    });

    test('writes need a same-site Origin', async () => {
      const { h, cookie } = await signIn();
      const write = (headers: Record<string, string>) =>
        h.call('PUT', '/v1/settings/fleet', {
          headers: { Cookie: cookie, ...headers },
          json: { sync: { paused: true } },
        });
      expect((await write({})).status).toBe(403);
      expect((await write({ Origin: 'https://evil.example' })).status).toBe(
        403
      );
      expect((await write({ Origin: 'null' })).status).toBe(403);
      expect((await write({ Referer: 'https://evil.example/' })).status).toBe(
        403
      );
      const refused = await write({ Origin: 'https://evil.example' });
      expect(refused.body.error).toBe('cross_origin');
      expect((await h.admin('GET', '/v1/settings/fleet')).body.value).toEqual(
        {}
      );
      expect((await write(same)).status).toBe(200);
      expect(
        (await write({ Referer: 'http://localhost/settings' })).status
      ).toBe(200);
    });

    test('every state-changing method is protected, and a refused one changes nothing', async () => {
      const { h, cookie } = await signIn();
      await h.register(1);
      const cross = { Cookie: cookie, Origin: 'https://evil.example' };
      for (const [method, path, json] of ADMIN_ROUTES.filter(
        ([m]) => m !== 'GET'
      )) {
        const reply = await h.call(method, path, {
          headers: cross,
          ...(json === undefined ? {} : { json }),
        });
        expect(reply.status).toBe(403);
      }
      expect(
        (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node.approval
      ).toBe('pending');
    });

    test('actions are attributed to the signed-in person', async () => {
      const { h, cookie } = await signIn();
      await h.register(1);
      await h.call('POST', `/v1/nodes/${nodeIdOf(1)}/approve`, {
        headers: { Cookie: cookie, ...same },
      });
      await h.call('PUT', '/v1/settings/fleet', {
        headers: { Cookie: cookie, ...same },
        json: { sync: { paused: true } },
      });
      expect(
        (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node.approvedBy
      ).toBe('chris@example.test');
      expect((await h.admin('GET', '/v1/settings/fleet')).body.updatedBy).toBe(
        'chris@example.test'
      );
      const events = (await h.admin('GET', '/v1/events')).body.events;
      expect(
        events.find((e: { kind: string }) => e.kind === 'approved').message
      ).toContain('chris');
    });

    test('the bearer token needs no Origin: scripts and CI have none', async () => {
      const { h } = await signIn();
      const reply = await h.call('PUT', '/v1/settings/fleet', {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        json: { sync: { paused: true } },
      });
      expect(reply.status).toBe(200);
    });

    test('an expired session is just anonymous', async () => {
      const { h, cookie } = await signIn();
      await ctx().db
        .sql`update fleet.browser_sessions set expires_at = now() - interval '1 second'`;
      expect(
        (await h.call('GET', '/v1/nodes', { headers: { Cookie: cookie } }))
          .status
      ).toBe(401);
    });

    test('a tampered cookie is anonymous', async () => {
      const { h, cookie } = await signIn();
      const forged = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
      expect(
        (await h.call('GET', '/v1/nodes', { headers: { Cookie: forged } }))
          .status
      ).toBe(401);
    });

    test('a wrong Authorization header does not switch the Origin check off for a cookie', async () => {
      const { h, cookie } = await signIn();
      const reply = await h.call('GET', '/v1/nodes', {
        headers: { Cookie: cookie, Authorization: 'Bearer wrong' },
      });
      expect(reply.status).toBe(200);
      const write = await h.call('PUT', '/v1/settings/fleet', {
        headers: { Cookie: cookie, Authorization: 'Bearer wrong' },
        json: {},
      });
      expect(write.status).toBe(403);
    });
  });
});

describe('login rate limit', () => {
  describeApi('GET /auth/login', (ctx) => {
    test('is limited per address before the dashboard handler runs', async () => {
      const { harness } = ctx();
      const h = harness({
        api: { loginLimit: { limit: 3, windowMs: 60_000 } },
      });
      const attempt = (ip: string) =>
        h.call('GET', '/auth/login', {
          headers: { 'cf-connecting-ip': ip },
          body: 'username=a&password=b',
        });
      for (let i = 0; i < 3; i += 1)
        expect((await attempt('203.0.113.9')).status).toBe(404);
      const limited = await attempt('203.0.113.9');
      expect(limited.status).toBe(429);
      expect(limited.body.error).toBe('rate_limited');
      expect(limited.headers.get('Retry-After')).not.toBeNull();
      expect((await attempt('203.0.113.10')).status).toBe(404);
      h.clock.advance(60);
      expect((await attempt('203.0.113.9')).status).toBe(404);
    });

    test('other paths and methods are not counted', async () => {
      const { harness } = ctx();
      const h = harness({
        api: { loginLimit: { limit: 1, windowMs: 60_000 } },
      });
      for (let i = 0; i < 5; i += 1) await h.call('GET', '/login');
      expect((await h.call('GET', '/auth/login', { body: 'x' })).status).toBe(
        404
      );
    });
  });
});
