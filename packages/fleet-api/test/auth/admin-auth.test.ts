import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { FleetAdminAuth, TOKEN_ACTOR } from '../../src/auth/admin-auth';
import { ADMIN_TOKEN, silent } from '../support/api';

const auth = new FleetAdminAuth({
  env: { adminToken: ADMIN_TOKEN },
  now: () => new Date(),
  fetch,
  log: silent,
});

/** A route that reports what the auth object decided about the request. */
const probe = new Hono();
probe.all('/probe', async (c) =>
  c.json({ actor: await auth.actor(c), sameOrigin: auth.sameOrigin(c) })
);

async function ask(
  headers: Record<string, string>,
  host = 'fleet.example.test'
): Promise<{ actor: string | null; sameOrigin: boolean }> {
  const res = await probe.request(`http://${host}/probe`, {
    method: 'POST',
    headers,
  });
  return res.json();
}

describe('actor: bearer token', () => {
  test('the admin token identifies the token actor', async () => {
    expect((await ask({ Authorization: `Bearer ${ADMIN_TOKEN}` })).actor).toBe(
      TOKEN_ACTOR
    );
  });

  test('anything else does not', async () => {
    const wrong = [
      `Bearer ${ADMIN_TOKEN}x`,
      `Bearer ${ADMIN_TOKEN.slice(1)}`,
      'Bearer ',
      'Bearer',
      `Basic ${ADMIN_TOKEN}`,
      ADMIN_TOKEN,
      'Bearer wrong',
    ];
    for (const Authorization of wrong)
      expect((await ask({ Authorization })).actor).toBeNull();
    expect((await ask({})).actor).toBeNull();
  });

  test('a node credential is not an admin credential', async () => {
    const nodeToken = `${'a'.repeat(64)}.${'b'.repeat(64)}`;
    expect(
      (await ask({ Authorization: `Bearer ${nodeToken}` })).actor
    ).toBeNull();
  });
});

test('legacy Vault password sessions are no longer accepted', async () => {
  expect((await ask({ Cookie: 'fleet_session=ok:chris' })).actor).toBeNull();
  expect(auth).not.toHaveProperty('login');
});

describe('sameOrigin (CSRF)', () => {
  test('an Origin that names this host passes', async () => {
    expect(
      (await ask({ Origin: 'https://fleet.example.test' })).sameOrigin
    ).toBe(true);
  });

  test('another site, subdomain, parent, port or scheme-less value does not', async () => {
    for (const Origin of [
      'https://evil.example',
      'https://fleet.example.test.evil.example',
      'https://evil.fleet.example.test',
      'https://example.test',
      'https://fleet.example.test:8443',
      'fleet.example.test',
      'null',
      '',
    ]) {
      expect((await ask({ Origin })).sameOrigin).toBe(false);
    }
  });

  test('without Origin, a Referer from this host passes and another does not', async () => {
    expect(
      (await ask({ Referer: 'https://fleet.example.test/settings' })).sameOrigin
    ).toBe(true);
    expect(
      (await ask({ Referer: 'https://evil.example/fleet.example.test' }))
        .sameOrigin
    ).toBe(false);
  });

  test('with neither header the request is refused', async () => {
    expect((await ask({})).sameOrigin).toBe(false);
  });

  test('a present Origin decides, even if the Referer would pass', async () => {
    const reply = await ask({
      Origin: 'https://evil.example',
      Referer: 'https://fleet.example.test/',
    });
    expect(reply.sameOrigin).toBe(false);
  });

  test('behind a proxy, the forwarded host counts', async () => {
    const reply = await ask({
      Origin: 'https://fleet.example.com',
      'X-Forwarded-Host': 'fleet.example.com',
    });
    expect(reply.sameOrigin).toBe(true);
  });

  test('a forged Host header cannot make a foreign origin pass', async () => {
    const res = await probe.request('http://fleet.example.test/probe', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Host: 'fleet.example.test' },
    });
    expect((await res.json()).sameOrigin).toBe(false);
  });
});
