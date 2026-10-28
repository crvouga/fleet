import { describe, expect, test } from 'bun:test';

import {
  IDS,
  ORIGIN,
  cookiesFrom,
  get,
  html,
  post,
  seedFleet,
  setup,
} from './helpers';

function populated() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

const PAGES = [
  '/',
  '/nodes',
  `/nodes/${IDS.online}`,
  '/pending',
  '/events',
  '/settings',
  '/settings/role:ci',
  '/ui/fleet',
  '/add',
];

describe('sign in', () => {
  test('every page redirects to /login?next= without a session', async () => {
    const { app } = populated();
    for (const path of PAGES) {
      const res = await get(app, path, null);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        `/login?next=${encodeURIComponent(path)}`
      );
    }
  });

  test('next keeps the query string', async () => {
    const { app } = populated();
    const res = await get(app, '/nodes?status=offline&q=a%20b', null);
    expect(res.headers.get('location')).toBe(
      `/login?next=${encodeURIComponent('/nodes?status=offline&q=a%20b')}`
    );
  });

  test('login uses the provider and never renders Vault credentials', async () => {
    const { app } = populated();
    const page = await html(app, '/login?next=/nodes', null);
    expect(page).toContain('OpenID Connect');
    expect(page).not.toContain('login-password');
    expect(page).not.toContain('login-username');
    expect(page).not.toContain('Vault');
  });
  test('password posts cannot create a session', async () => {
    const { app } = populated();
    const res = await post(
      app,
      '/login',
      { username: 'dana', password: 'anything' },
      { cookie: null }
    );
    expect(res.status).toBe(410);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  test('logout refuses missing or foreign origin', async () => {
    const { app } = populated();
    for (const origin of [null, 'https://evil.example'])
      expect((await post(app, '/logout', {}, { origin })).status).toBe(403);
  });

  test('logout clears the cookie and goes to /login', async () => {
    const { app } = populated();
    const res = await post(app, '/logout');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('a signed-in person visiting /login is sent on', async () => {
    const { app } = populated();
    const res = await get(app, '/login?next=/events');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/events');
  });
});

const ACTIONS = ['approve', 'reject', 'retire', 'delete', 'edit'];

describe('csrf and auth on state changes', () => {
  test('every POST refuses a foreign or missing Origin and changes nothing', async () => {
    const { app, deps } = populated();
    for (const name of ACTIONS) {
      for (const origin of ['https://evil.example', null]) {
        const res = await post(
          app,
          `/nodes/${IDS.pending}/${name}`,
          { confirm: 'yes' },
          { origin }
        );
        expect(res.status).toBe(403);
      }
    }
    for (const path of ['/settings/fleet', '/settings/fleet/restore']) {
      expect(
        (await post(app, path, {}, { origin: 'https://evil.example' })).status
      ).toBe(403);
    }
    expect((await deps.store.findNode(IDS.pending))?.approval).toBe('pending');
    expect(await deps.store.findNode(IDS.online)).not.toBeNull();
  });

  test('a same-origin POST without a session goes to /login and changes nothing', async () => {
    const { app, deps } = populated();
    const res = await post(
      app,
      `/nodes/${IDS.pending}/approve`,
      {},
      { cookie: null }
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect((await deps.store.findNode(IDS.pending))?.approval).toBe('pending');
  });
});

describe('node actions', () => {
  test('approve changes the store, records the actor and flashes', async () => {
    const { app, deps } = populated();
    const res = await post(app, `/nodes/${IDS.pending}/approve`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/nodes/${IDS.pending}`);
    const row = await deps.store.findNode(IDS.pending);
    expect(row?.approval).toBe('approved');
    expect(row?.approvedBy).toBe('tester');
    const next = await html(
      app,
      res.headers.get('location') ?? '/',
      cookiesFrom(res)
    );
    expect(next).toContain('netboot-f001 approved.');
    expect(next).toContain('role="status"');
    const again = await get(app, '/', cookiesFrom(res));
    expect(again.headers.get('set-cookie')).toContain('fleet_flash=;');
  });

  test('the flash shows once', async () => {
    const { app } = populated();
    const res = await post(app, `/nodes/${IDS.pending}/approve`);
    const cookie = cookiesFrom(res);
    const first = await get(app, '/pending', cookie);
    expect(await first.text()).toContain('netboot-f001 approved.');
    const clearing = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('fleet_flash='));
    expect(clearing).toBeDefined();
    const second = await html(app, '/pending');
    expect(second).not.toContain('netboot-f001 approved.');
  });

  test('approve honors a safe next and ignores an unsafe one', async () => {
    const { app } = populated();
    const ok = await post(app, `/nodes/${IDS.pending}/approve`, {
      next: '/pending',
    });
    expect(ok.headers.get('location')).toBe('/pending');
    const bad = await post(app, `/nodes/${IDS.rejected}/approve`, {
      next: '//evil.example',
    });
    expect(bad.headers.get('location')).toBe(`/nodes/${IDS.rejected}`);
  });

  test('reject only works on pending nodes', async () => {
    const { app, deps } = populated();
    expect((await post(app, `/nodes/${IDS.pending}/reject`)).status).toBe(303);
    expect((await deps.store.findNode(IDS.pending))?.approval).toBe('rejected');
    const res = await post(app, `/nodes/${IDS.online}/reject`);
    expect((await deps.store.findNode(IDS.online))?.approval).toBe('approved');
    expect(
      await html(app, res.headers.get('location') ?? '/', cookiesFrom(res))
    ).toContain('cannot be rejected');
  });

  test('retire and delete need the confirmation field', async () => {
    const { app, deps } = populated();
    const noConfirm = await post(app, `/nodes/${IDS.online}/retire`);
    expect((await deps.store.findNode(IDS.online))?.approval).toBe('approved');
    expect(
      await html(
        app,
        noConfirm.headers.get('location') ?? '/',
        cookiesFrom(noConfirm)
      )
    ).toContain('confirm before');
    await post(app, `/nodes/${IDS.online}/delete`);
    expect(await deps.store.findNode(IDS.online)).not.toBeNull();
    const retired = await post(app, `/nodes/${IDS.online}/retire`, {
      confirm: 'yes',
    });
    expect(retired.status).toBe(303);
    expect((await deps.store.findNode(IDS.online))?.approval).toBe('retired');
    const deleted = await post(app, `/nodes/${IDS.online}/delete`, {
      confirm: 'yes',
    });
    expect(deleted.headers.get('location')).toBe('/nodes');
    expect(await deps.store.findNode(IDS.online)).toBeNull();
    expect(await html(app, '/nodes', cookiesFrom(deleted))).toContain(
      'Build 1 deleted.'
    );
  });

  test('actions on a missing node flash an error and change nothing', async () => {
    const { app } = populated();
    const res = await post(app, `/nodes/${'7'.repeat(64)}/approve`);
    expect(res.headers.get('location')).toBe('/nodes');
    expect(await html(app, '/nodes', cookiesFrom(res))).toContain(
      'no longer exists'
    );
    const bad = await post(app, '/nodes/xyz/delete', { confirm: 'yes' });
    expect(bad.headers.get('location')).toBe('/nodes');
  });

  test('edit saves name, note and labels; empty clears them', async () => {
    const { app, deps } = populated();
    const res = await post(app, `/nodes/${IDS.cache}/edit`, {
      displayName: ' Attic ',
      note: 'in the closet',
      labels: 'fast,\nnvme  ssd',
    });
    expect(res.status).toBe(303);
    const row = await deps.store.findNode(IDS.cache);
    expect([row?.displayName, row?.note, row?.labels]).toEqual([
      'Attic',
      'in the closet',
      ['fast', 'nvme', 'ssd'],
    ]);
    expect(await html(app, `/nodes/${IDS.cache}`, cookiesFrom(res))).toContain(
      'Saved.'
    );
    await post(app, `/nodes/${IDS.cache}/edit`, {
      displayName: '',
      note: '',
      labels: '',
    });
    const cleared = await deps.store.findNode(IDS.cache);
    expect([cleared?.displayName, cleared?.note, cleared?.labels]).toEqual([
      null,
      null,
      [],
    ]);
  });

  test('edit rejects bad labels and over-long values', async () => {
    const { app, deps } = populated();
    for (const fields of [
      { labels: 'good bad<label>' },
      { displayName: 'x'.repeat(81) },
      { note: 'x'.repeat(501) },
      { labels: Array.from({ length: 17 }, (_, i) => `l${i}`).join(' ') },
    ]) {
      const res = await post(app, `/nodes/${IDS.cache}/edit`, fields);
      const page = await html(app, `/nodes/${IDS.cache}`, cookiesFrom(res));
      expect(page).toContain('role="alert"');
    }
    const row = await deps.store.findNode(IDS.cache);
    expect([row?.displayName, row?.labels]).toEqual([null, []]);
    expect(ORIGIN).toBe('http://localhost');
  });
});
