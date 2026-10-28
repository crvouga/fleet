import { describe, expect, test } from 'bun:test';

import { IDS, cookiesFrom, html, post, seedFleet, setup } from './helpers';

const VIEWER = 'fleet_session=viewer:vera';

function populated() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

describe('settings form: concurrency, preview and acknowledgement', () => {
  test('the form carries the revision it was loaded at and offers a preview', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 70 } },
      'chris'
    );
    const page = await html(app, '/settings/fleet');
    expect(page).toMatch(
      /name="expectedRevision"[^>]*value="1"|value="1"[^>]*name="expectedRevision"/
    );
    expect(page).toContain('Preview impact');
  });

  test('a stale revision is refused with a plain message and nothing is saved', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 70 } },
      'chris'
    );
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 75 } },
      'dana'
    );
    const res = await post(app, '/settings/fleet', {
      mode: 'form',
      expectedRevision: '1',
      'disk.alertPercent': '90',
    });
    expect(res.status).toBe(409);
    const page = await res.text();
    expect(page).toContain('these settings changed');
    expect(page).toContain('revision 2');
    // Their edit survives in the raw editor and the old revision is kept so saving again cannot overwrite.
    expect(page).toContain('&quot;alertPercent&quot;: 90');
    expect(page).toMatch(
      /name="expectedRevision"[^>]*value="1"|value="1"[^>]*name="expectedRevision"/
    );
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      disk: { alertPercent: 75 },
    });
    const json = await app.request('/settings/fleet', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'fleet_session=ok:tester',
        origin: 'http://localhost',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        mode: 'form',
        expectedRevision: '1',
      }).toString(),
    });
    expect(json.status).toBe(409);
    expect(await json.json()).toMatchObject({
      code: 'conflict',
      currentRevision: 2,
    });
  });

  test('an existing scope without the revision is refused', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings('fleet', {}, 'chris');
    const res = await post(app, '/settings/fleet', { mode: 'form' });
    expect(res.status).toBe(428);
    expect(await res.text()).toContain('did not say which version');
  });

  test('a destabilising save is refused with a checkbox per warning, then goes through once confirmed', async () => {
    const { app, deps } = populated();
    const fields = { mode: 'form', 'runners.cordoned': 'true' } as const;
    const refused = await post(app, '/settings/fleet', fields);
    // The fixture fleet has CI nodes: cordoning every one of them stalls CI.
    expect(refused.status).toBe(422);
    const page = await refused.text();
    expect(page).toContain('could destabilise the fleet');
    expect(page).toContain('name="acknowledge" value="ci_runners_cordoned"');
    expect(await deps.store.getSettings('fleet')).toBeNull();
    const saved = await post(app, '/settings/fleet', {
      ...fields,
      acknowledge: 'ci_runners_cordoned',
    });
    expect(saved.status).toBe(303);
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      runners: { cordoned: true },
    });
    const audit = await deps.store.listAudit({
      targetKind: 'settings',
      targetId: 'fleet',
      limit: 5,
    });
    expect(audit.map((row) => row.outcome)).toEqual(['success', 'failed']);
    expect(audit[0]?.detail).toMatchObject({
      acknowledged: ['ci_runners_cordoned'],
    });
  });

  test('preview shows which nodes change and writes nothing', async () => {
    const { app, deps } = populated();
    const res = await post(app, '/settings/fleet', {
      mode: 'form',
      intent: 'preview',
      'disk.alertPercent': '70',
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('Preview: nothing was saved');
    expect(page).toContain('would receive a new desired document');
    expect(await deps.store.getSettings('fleet')).toBeNull();
    expect(
      await deps.store.listAudit({ targetKind: 'settings', limit: 5 })
    ).toEqual([]);
  });
});

describe('viewers cannot change anything from the dashboard', () => {
  test('every form action is 403, audited as denied, and changes nothing', async () => {
    const { app, deps } = populated();
    const attempts: [string, Record<string, string>][] = [
      ['/settings/fleet', { mode: 'form', 'disk.alertPercent': '70' }],
      ['/settings/fleet/restore', { historyId: '1' }],
      [`/nodes/${IDS.online}/credential/rotate`, {}],
      [`/nodes/${IDS.online}/credential/revoke`, { confirm: 'Build 1' }],
      [`/nodes/${IDS.online}/role`, { role: 'devbox' }],
    ];
    for (const [path, fields] of attempts) {
      const res = await post(app, path, fields, { cookie: VIEWER });
      expect([path, res.status]).toEqual([path, 403]);
      expect(await res.text()).toContain('viewer');
    }
    expect(await deps.store.getSettings('fleet')).toBeNull();
    expect(
      (await deps.store.credentialStatus(IDS.online))?.revokedAt
    ).toBeNull();
    const denied = await deps.store.listAudit({ actor: 'vera', limit: 20 });
    expect(denied).toHaveLength(attempts.length);
    expect(
      denied.every(
        (row) => row.outcome === 'denied' && row.actorRole === 'viewer'
      )
    ).toBe(true);
  });

  test('a viewer reads the settings page with its controls disabled', async () => {
    const { app } = populated();
    const page = await html(app, '/settings/fleet', VIEWER);
    expect(page).toContain('Save settings');
    expect(page).toMatch(/<button[^>]*disabled[^>]*>\s*Save settings/);
    const node = await html(app, `/nodes/${IDS.online}`, VIEWER);
    expect(node).not.toContain('Rotate credential');
  });
});

describe('credential actions from the node page', () => {
  test('an admin rotates, then revokes by typing the name; both are audited', async () => {
    const { app, deps } = populated();
    const page = await html(app, `/nodes/${IDS.online}`);
    expect(page).toContain('Rotate credential');
    expect(page).toContain('Desired-state history');
    const rotate = await post(app, `/nodes/${IDS.online}/credential/rotate`);
    expect(rotate.status).toBe(303);
    expect(
      await html(app, `/nodes/${IDS.online}`, cookiesFrom(rotate))
    ).toContain('will rotate its credential');
    expect(
      (await deps.store.credentialStatus(IDS.online))?.rotateRequestedAt
    ).toBeInstanceOf(Date);
    const refused = await post(app, `/nodes/${IDS.online}/credential/revoke`, {
      confirm: 'nope',
    });
    expect(
      await html(app, `/nodes/${IDS.online}`, cookiesFrom(refused))
    ).toContain('type its name');
    expect(
      (await deps.store.credentialStatus(IDS.online))?.revokedAt
    ).toBeNull();
    const revoke = await post(app, `/nodes/${IDS.online}/credential/revoke`, {
      confirm: 'Build 1',
    });
    expect(revoke.status).toBe(303);
    expect(
      (await deps.store.credentialStatus(IDS.online))?.revokedAt
    ).toBeInstanceOf(Date);
    const actions = (
      await deps.store.listAudit({
        targetKind: 'node',
        targetId: IDS.online,
        limit: 10,
      })
    ).map((row) => `${row.action}:${row.outcome}`);
    expect(actions).toEqual([
      'credential.revoke:success',
      'credential.revoke:denied',
      'credential.rotate_request:success',
    ]);
  });
});
