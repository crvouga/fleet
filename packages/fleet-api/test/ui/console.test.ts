import { describe, expect, test } from 'bun:test';
import { IDS, COOKIE, ORIGIN, setup, seedFleet } from './helpers';
import { decodeState } from '../../src/console/model';
import { detectedPlatform } from '../../src/console/platform';
import { chartData } from '../../src/console/chart-data';
const secret = 'https://hooks.example.test/private/TOKEN?secret=hidden';
test('client charts keep missing reports as gaps and preserve measured zeroes', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const data = chartData(
    [
      {
        at: new Date('2026-10-24T11:55:00Z'),
        uptimeSeconds: 600,
        load1: 0,
        memUsedPercent: 30,
        diskPercent: null,
        slots: 2,
        busySlots: 0,
      },
    ],
    now
  );
  expect(data).toHaveLength(96);
  expect(data.slice(0, -1).every((point) => point.load === null)).toBe(true);
  expect(data.at(-1)).toMatchObject({
    load: 0,
    memory: 30,
    disk: null,
    busy: 0,
  });
});
function fixture() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}
async function state(
  app: ReturnType<typeof setup>['app'],
  path: string,
  cookie = COOKIE
) {
  return app.request(`/ui/state?${new URLSearchParams({ path })}`, {
    headers: { cookie },
  });
}

describe('client console data contract', () => {
  test('unauthorized requests never receive fleet state; login state is public', async () => {
    const { app } = fixture();
    const denied = await state(app, '/nodes', '');
    expect(denied.status).toBe(401);
    expect(await denied.json()).not.toHaveProperty('fleet');
    const login = await state(app, '/login', '');
    expect(login.status).toBe(200);
    expect((await login.json()).status).toBe('signed-out');
  });
  test('dates and scoped documents round-trip without disclosing webhook credentials', async () => {
    const { app, deps } = fixture();
    await deps.store.putSettings(
      'fleet',
      { alerts: { webhookUrl: secret } },
      'tester'
    );
    const response = await state(app, '/settings/fleet');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toContain('TOKEN');
    expect(body).not.toContain('secret=hidden');
    expect(body).toContain('https://hooks.example.test/…');
    const value = decodeState(body);
    expect(value.fleet.now).toBeInstanceOf(Date);
    expect(value.fleet.entries[0]?.view.firstSeenAt).toBeInstanceOf(Date);
    expect(value.fleet.documents).toBeInstanceOf(Map);
    expect(value.history[0]?.changedAt).toBeInstanceOf(Date);
    expect(value.access.available).toBe(false);
  });
  test('node views include their own history and events, and invalid scopes do not crash', async () => {
    const { app } = fixture();
    const response = await state(app, `/nodes/${IDS.online}`);
    const data = decodeState(await response.text());
    expect(data.points.length).toBeGreaterThan(0);
    expect(data.points[0]?.at).toBeInstanceOf(Date);
    expect((await state(app, '/settings/not-a-scope')).status).toBe(200);
  });
  test('JSON form actions retain origin protection, confirmation, and actor attribution', async () => {
    const { app, deps } = fixture();
    const action = (origin: string, body: string) =>
      app.request(`/nodes/${IDS.online}/retire`, {
        method: 'POST',
        headers: {
          cookie: COOKIE,
          Origin: origin,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    expect((await action('https://evil.test', 'confirm=yes')).status).toBe(403);
    const unconfirmed = await action(ORIGIN, '');
    expect((await unconfirmed.json()).flash.kind).toBe('error');
    expect((await deps.store.findNode(IDS.online))?.approval).toBe('approved');
    const confirmed = await action(ORIGIN, 'confirm=yes');
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).flash.kind).toBe('success');
    expect((await deps.store.findNode(IDS.online))?.approval).toBe('retired');
  });
  test('structured settings errors preserve stored configuration and secrets', async () => {
    const { app, deps } = fixture();
    await deps.store.putSettings(
      'fleet',
      { alerts: { webhookUrl: secret } },
      'tester'
    );
    const response = await app.request('/settings/fleet', {
      method: 'POST',
      headers: {
        cookie: COOKIE,
        Origin: ORIGIN,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'mode=form&heartbeat.intervalSeconds=2',
    });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('heartbeat.intervalSeconds');
    expect(body).not.toContain('TOKEN');
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      alerts: { webhookUrl: secret },
    });
  });
});

test('platform detection refuses guesses and unsupported installed-app targets', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  };
  expect(detectedPlatform(nav)).toBe('');
  expect(
    detectedPlatform(nav, {
      platform: 'macOS',
      architecture: 'arm',
      bitness: '64',
    })
  ).toBe('macos-arm64');
  expect(
    detectedPlatform({
      ...nav,
      userAgent: 'NixOS Linux x86_64',
      platform: 'Linux x86_64',
    })
  ).toBe('nixos');
  expect(
    detectedPlatform(
      { ...nav, userAgent: 'Windows ARM64', platform: 'Win32' },
      { architecture: 'arm', bitness: '64' }
    )
  ).toBe('');
  expect(
    detectedPlatform({ ...nav, userAgent: 'iPhone', platform: 'iPhone' })
  ).toBe('');
});
