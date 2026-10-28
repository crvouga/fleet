import { describe, expect, test } from 'bun:test';

import { nodeRow } from '../../src/testing/fixtures';
import { FIXED_NOW, LATEST_REVISION } from '../../src/testing/test-deps';
import { IDS, get, html, seedFleet, setup } from './helpers';

function populated() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

describe('overview', () => {
  test('shows health, tiles, roles, capacity, revisions, attention and feed', async () => {
    const { app, deps } = populated();
    await deps.store.addEvent({
      nodeId: IDS.units,
      nodeLabel: 'web-3e4f',
      kind: 'unit-failed',
      severity: 'error',
      message: 'caddy.service failed',
    });
    await deps.store.addEvent({
      nodeId: null,
      nodeLabel: null,
      kind: 'noise',
      severity: 'info',
      message: 'quiet info event',
    });
    const page = await html(app, '/');
    expect(page).toContain('<title>Overview');
    expect(page).toContain('Needs attention');
    expect(page).toContain('need attention');
    expect(page).toContain('Online');
    expect(page).toContain('Pending approval');
    expect(page).toContain('CI runner capacity');
    expect(page).toContain('slots busy');
    expect(page).toContain('Revisions');
    expect(page).toContain('on the latest main');
    expect(page).toContain('Offline: silent for 3h 00m');
    expect(page).toContain(
      'Rolled back to the previous system: runner never became healthy'
    );
    expect(page).toContain('2 failed units: caddy.service, backup.service');
    expect(page).toContain('Disk 94% full (alert at 90%)');
    expect(page).toContain('Waiting for approval');
    expect(page).toContain('Missed check-ins');
    expect(page).toContain('caddy.service failed');
    expect(page).not.toContain('quiet info event');
    // Active roles always; a retired role only while approved nodes carry it.
    for (const role of ['ci', 'devbox', 'web', 'cache']) {
      expect(page).toContain(`href="/nodes?role=${role}"`);
    }
    expect(page).not.toContain('href="/nodes?role=netboot"');
  });

  test('counts: 3 slots busy of 13 over online and stale ci nodes', async () => {
    const { app } = populated();
    const page = await html(app, '/');
    // a3f9 4/6 (online), b21c 3/3 (stale), e5a0 0/4 (online) = 7 of 13
    expect(page).toMatch(/7\s*<span[^>]*>\s*\/ 13/);
  });

  test('is healthy when nothing is wrong', async () => {
    const { app, deps } = setup();
    deps.store.seedNode(
      nodeRow({
        short: 'a001',
        lastSeenAt: new Date(FIXED_NOW.getTime() - 5000),
        body: { revision: LATEST_REVISION },
      })
    );
    const page = await html(app, '/');
    expect(page).toContain('No operational alerts');
    expect(page).toContain('Nothing needs you right now.');
  });

  test('empty fleet shows the add-your-first-node steps', async () => {
    const { app } = setup();
    const page = await html(app, '/');
    expect(page).toContain('Add your first node');
    expect(page).toContain('/installers/release');
    expect(page).toContain('Install the base system');
    expect(page).toContain('Assign a role here');
    expect(page).not.toContain('Choose a role');
    expect(page).toContain('Approve it here');
    expect(page).toContain('href="/add"');
  });

  test('/add shows the same steps under one h1', async () => {
    const { app } = setup();
    const page = await html(app, '/add');
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain('Add a node');
    expect(page).toContain('fleet-installer');
  });

  test('pending count badge appears in the navigation', async () => {
    const { app } = populated();
    const page = await html(app, '/');
    expect(page).toMatch(
      /Pending[\s\S]{0,200}>1<[\s\S]{0,40}waiting for approval/
    );
  });
});

describe('node detail', () => {
  test('shows facts, charts, callouts, timeline and forms', async () => {
    const { app, deps } = populated();
    await deps.store.addEvent({
      nodeId: IDS.rolledBack,
      nodeLabel: 'ci-e5a0',
      kind: 'rollback',
      severity: 'error',
      message: 'rolled back after health check',
    });
    const page = await html(app, `/nodes/${IDS.rolledBack}`);
    expect(page).toContain('Rolled back');
    expect(page).toContain('runner never became healthy');
    expect(page).toContain('rolled back after health check');
    expect(page).toContain('Effective configuration');
    expect(page).toContain('name="displayName"');
    expect(page).toContain(`action="/nodes/${IDS.rolledBack}/retire"`);
    expect(page).toContain(`action="/nodes/${IDS.rolledBack}/delete"`);
    const failed = await html(app, `/nodes/${IDS.units}`);
    expect(failed).toContain('2 failed units');
    expect(failed).toContain('backup.service');
  });

  test('charts and availability render from heartbeat history', async () => {
    const { app } = populated();
    const page = await html(app, `/nodes/${IDS.online}`);
    expect(page).toContain('Availability, last 24 h');
    expect(page).toContain('Load (1 min)');
    expect(page).toContain('Memory used');
    expect(page).toContain('Disk used');
    expect(page).toContain('Runner slots busy');
    expect(page).toContain('<svg');
    expect(page).toContain('Show data');
    expect(page).toContain('Build 1');
    expect(page).toMatch(/Availability, last 24 h[\s\S]{0,200}100%/);
  });

  test('effective configuration names the scope each value came from', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { heartbeat: { intervalSeconds: 45 }, disk: { alertPercent: 80 } },
      'chris'
    );
    await deps.store.putSettings(
      'role:ci',
      { disk: { alertPercent: 70 } },
      'chris'
    );
    await deps.store.putSettings(
      `node:${IDS.online}`,
      { disk: { alertPercent: 60 } },
      'chris'
    );
    const page = await html(app, `/nodes/${IDS.online}`);
    expect(page).toContain('href="/settings/fleet"');
    expect(page).toContain('Fleet</a>');
    expect(page).toContain(`href="/settings/node:${IDS.online}"`);
    expect(page).toContain('This node</a>');
    const web = await html(app, `/nodes/${IDS.units}`);
    expect(web).not.toContain('Role ci');
    await deps.store.putSettings(
      'role:web',
      { reboot: { enabled: false } },
      'chris'
    );
    const webAgain = await html(app, `/nodes/${IDS.units}`);
    expect(webAgain).toContain('href="/settings/role:web"');
    expect(webAgain).toContain('Role web</a>');
  });

  test('a pending node offers approve and reject at the top', async () => {
    const { app } = populated();
    const page = await html(app, `/nodes/${IDS.pending}`);
    expect(page).toContain('Waiting for your approval');
    expect(page).toContain(`action="/nodes/${IDS.pending}/approve"`);
    expect(page).toContain(`action="/nodes/${IDS.pending}/reject"`);
  });

  test('retire and delete are behind a confirmation step', async () => {
    const { app } = populated();
    const page = await html(app, `/nodes/${IDS.online}`);
    expect(page).toMatch(
      /<details id="retire"[\s\S]*?name="confirm" value="yes"/
    );
    expect(page).toMatch(
      /<details id="delete"[\s\S]*?name="confirm" value="yes"/
    );
  });

  test('unknown or malformed ids are 404 pages', async () => {
    const { app } = populated();
    const missing = await get(app, `/nodes/${'9'.repeat(64)}`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Node not found');
    expect((await get(app, '/nodes/not-an-id')).status).toBe(404);
  });

  test('the webhook is masked to its host in the effective configuration', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      {
        alerts: {
          webhookUrl: 'https://hooks.example.com/services/SECRET/TOKEN?key=1',
        },
      },
      'chris'
    );
    const page = await html(app, `/nodes/${IDS.online}`);
    expect(page).toContain('https://hooks.example.com/');
    expect(page).not.toContain('SECRET');
    expect(page).not.toContain('key=1');
  });
});

describe('pending approvals', () => {
  test('lists pending nodes with approve and reject, and rejected ones apart', async () => {
    const { app } = populated();
    const page = await html(app, '/pending');
    expect(page).toContain('Pending approvals');
    expect(page).toContain('netboot-f001');
    expect(page).toContain('Runs');
    expect(page).not.toContain('Requested role');
    expect(page).toContain('No role yet');
    expect(page).toContain(`action="/nodes/${IDS.pending}/approve"`);
    expect(page).toContain('Rejected machines (1)');
    expect(page).toContain('Approve anyway');
    expect(page).toContain('name="next" value="/pending"');
  });

  test('says so when nothing is waiting', async () => {
    const { app } = setup();
    expect(await html(app, '/pending')).toContain(
      'No machines are waiting for approval'
    );
  });
});

describe('events', () => {
  async function withEvents(count: number) {
    const harness = populated();
    for (let i = 1; i <= count; i += 1) {
      await harness.deps.store.addEvent({
        nodeId: i % 2 === 0 ? IDS.online : IDS.units,
        nodeLabel: i % 2 === 0 ? 'Build 1' : 'web-3e4f',
        kind: 'test',
        severity: i % 3 === 0 ? 'error' : 'warn',
        message: `event number ${i}`,
      });
    }
    return harness;
  }

  test('pages newest first with an older link and a way back', async () => {
    const { app } = await withEvents(30);
    const first = await html(app, '/events');
    expect(first).toContain('event number 30');
    expect(first).toContain('event number 6');
    expect(first).not.toContain('event number 5<');
    const link = first.match(/href="(\/events\?before=\d+)" rel="next"/)?.[1];
    expect(link).toBeDefined();
    const second = await html(app, link ?? '');
    expect(second).toContain('event number 5<');
    expect(second).toContain('event number 1<');
    expect(second).not.toContain('event number 6<');
    expect(second).toContain('Back to newest');
    expect(second).not.toContain('rel="next"');
  });

  test('filters by severity and by node', async () => {
    const { app } = await withEvents(12);
    const errors = await html(app, '/events?severity=error');
    expect(errors).toContain('event number 12');
    expect(errors).not.toContain('event number 11<');
    const node = await html(app, `/events?node=${IDS.units}`);
    expect(node).toContain('event number 11<');
    expect(node).not.toContain('event number 12<');
    expect(
      await html(app, '/events?severity=bogus&before=abc&node=zzz')
    ).toContain('event number 12');
  });

  test('says so when nothing matches', async () => {
    const { app } = setup();
    expect(await html(app, '/events')).toContain('No events match.');
  });
});

describe('fragment and assets', () => {
  test('the fragment is an overview body with no page frame', async () => {
    const { app } = populated();
    const res = await get(app, '/ui/fleet');
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain('<html');
    expect(body).toContain('Needs attention');
    expect(body).toContain('CI runner capacity');
  });

  test('the nodes fragment honors the same query as the page', async () => {
    const { app } = populated();
    const body = await html(app, '/ui/fleet?view=nodes&role=cache');
    expect(body).toContain('cache-7f10');
    expect(body).not.toContain('web-3e4f');
    expect(body).not.toContain('<html');
  });

  test('pages point at the live fragment and the script', async () => {
    const { app } = populated();
    expect(await html(app, '/')).toContain(
      'data-live-src="/ui/fleet?view=overview"'
    );
    expect(await html(app, '/nodes?role=ci&sort=name')).toContain(
      'data-live-src="/ui/fleet?view=nodes&amp;role=ci&amp;sort=name&amp;dir=asc"'
    );
    const script = await get(app, '/assets/app.js');
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(await script.text()).toContain('visibilitychange');
    const etag = script.headers.get('etag') ?? '';
    const again = await app.request('/assets/app.js', {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  test('every page links the stylesheet and has a doctype and skip link', async () => {
    const { app } = populated();
    for (const path of [
      '/',
      '/nodes',
      '/pending',
      '/events',
      '/settings',
      '/add',
    ]) {
      const page = await html(app, path);
      expect(page.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(page).toContain('href="/assets/app.css"');
      expect(page).toContain('href="#main"');
      expect(page).toContain('id="main"');
      expect(page).toContain('aria-current="page"');
    }
  });

  test('relative times carry the exact time as a tooltip', async () => {
    const { app } = populated();
    const page = await html(app, '/nodes');
    expect(page).toMatch(
      /<time datetime="2026-10-14T11:59:40.000Z" title="2026-10-14 11:59:40 UTC" data-rel/
    );
    expect(page).toContain('20 s ago');
  });
});
