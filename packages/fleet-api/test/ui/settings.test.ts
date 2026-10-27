import { describe, expect, test } from 'bun:test';

import { RULES, SECTIONS } from '../../src/config/schema';
import { allSettingPaths, SETTING_META } from '../../src/ui/lib/setting-meta';
import { IDS, cookiesFrom, get, html, post, seedFleet, setup } from './helpers';

function populated() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

type AnyRule = (typeof RULES)[(typeof SECTIONS)[number]][string];

function expectControl(
  page: string,
  section: string,
  key: string,
  rule: AnyRule
): void {
  const path = `${section}.${key}`;
  switch (rule.kind) {
    case 'int':
      expect(page).toMatch(
        new RegExp(
          `name="${path}"[^>]*type="number"|type="number"[^>]*name="${path}"`
        )
      );
      expect(page).toContain(`min="${rule.min}"`);
      expect(page).toContain(`max="${rule.max}"`);
      expect(page).toContain(`Allowed ${rule.min} to ${rule.max}`);
      return;
    case 'bool':
      expect(
        page.match(new RegExp(`name="${path}" value="(true|false)?"`, 'g'))
      ).toHaveLength(3);
      return;
    case 'list':
      expect(page).toContain(`<textarea id="f-${section}-${key}"`);
      return;
    case 'url-or-null':
      expect(page).toContain('type="url"');
  }
}

describe('settings form generation', () => {
  test('every rule has a control, a label and help text', async () => {
    const { app } = populated();
    const page = await html(app, '/settings');
    for (const section of SECTIONS) {
      for (const [key, rule] of Object.entries(RULES[section])) {
        const path = `${section}.${key}`;
        expect(page).toContain(`name="${path}"`);
        const meta = SETTING_META[path];
        expect(meta?.label.length).toBeGreaterThan(0);
        expect(meta?.help.length).toBeGreaterThan(20);
        expect(page).toContain(meta?.label ?? 'missing');
        expectControl(page, section, key, rule);
      }
    }
    expect(allSettingPaths().length).toBe(Object.keys(SETTING_META).length);
  });

  test('every control has an associated label', async () => {
    const { app } = populated();
    const page = await html(app, '/settings');
    for (const match of page.matchAll(
      /<(?:input|textarea|select)[^>]*\sid="([^"]+)"/g
    )) {
      const id = match[1] ?? '';
      expect(page.includes(`for="${id}"`)).toBe(true);
    }
  });

  test('sections have titles and an advanced raw view and history', async () => {
    const { app } = populated();
    const page = await html(app, '/settings');
    for (const title of [
      'Check-ins',
      'Updates',
      'Reboots',
      'Disk',
      'Runner capacity',
      'CI runners',
      'Alerts',
    ]) {
      expect(page).toContain(title);
    }
    expect(page).toContain('Advanced: raw JSON');
    expect(page).toContain('Change history');
    expect(page).toContain('No changes have been saved for this scope yet.');
  });

  test('scope switcher lists fleet, each role and counts overrides', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'role:ci',
      { disk: { alertPercent: 80 } },
      'chris'
    );
    const page = await html(app, '/settings');
    expect(page).toContain('href="/settings/fleet"');
    for (const role of ['ci', 'devbox']) {
      expect(page).toContain(`href="/settings/role:${role}"`);
    }
    // Retired roles have no scope tab unless they still hold settings.
    expect(page).not.toContain('href="/settings/role:web"');
    expect(page).toContain('1<span class="sr-only"> settings set');
  });

  test('role and node scopes explain inheritance and show inherited values', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { heartbeat: { intervalSeconds: 45 } },
      'chris'
    );
    const role = await html(app, '/settings/role:ci');
    expect(role).toContain('Empty inherits: 45 (Fleet)');
    expect(role).toContain('placeholder="45"');
    const node = await html(app, `/settings/node:${IDS.online}`);
    expect(node).toContain('Settings for Build 1');
    expect(node).toContain('Empty inherits: 45 (Fleet)');
  });

  test('unknown scopes and nodes are 404', async () => {
    const { app } = populated();
    for (const scope of [
      'bogus',
      'role:nope',
      `node:${'a'.repeat(64)}`,
      'node:123',
    ]) {
      expect((await get(app, `/settings/${scope}`)).status).toBe(404);
    }
    expect((await post(app, '/settings/bogus', {})).status).toBe(404);
  });
});

describe('saving settings', () => {
  test('valid input saves only what was filled in and flashes', async () => {
    const { app, deps } = populated();
    const res = await post(app, '/settings/fleet', {
      mode: 'form',
      'heartbeat.intervalSeconds': '30',
      'sync.paused': 'true',
      'reboot.enabled': 'false',
      'disk.alertPercent': '',
      'runners.repositories':
        'crvouga/fleet\n crvouga/other ,crvouga/third',
      'runners.extraLabels': 'team-a',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/settings/fleet');
    const stored = await deps.store.getSettings('fleet');
    expect(stored?.value).toEqual({
      heartbeat: { intervalSeconds: 30 },
      sync: { paused: true },
      reboot: { enabled: false },
      runners: {
        repositories: ['crvouga/fleet', 'crvouga/other', 'crvouga/third'],
        extraLabels: ['team-a'],
      },
    });
    expect(stored?.updatedBy).toBe('tester');
    const page = await html(app, '/settings/fleet', cookiesFrom(res));
    expect(page).toContain('Fleet settings saved.');
    expect(page).toContain('value="30"');
    expect(page).toContain('tester');
  });

  test('invalid input is not saved and the error is next to the field', async () => {
    const { app, deps } = populated();
    const res = await post(app, '/settings/fleet', {
      mode: 'form',
      'heartbeat.intervalSeconds': '5',
      'capacity.slotMax': 'abc',
      'runners.repositories': 'not a repo',
      'alerts.webhookUrl': 'http://insecure.example.com',
    });
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('Nothing was saved');
    expect(page).toContain(
      'heartbeat.intervalSeconds must be between 15 and 3600'
    );
    expect(page).toContain('capacity.slotMax must be a whole number');
    expect(page).toContain('runners.repositories has an invalid entry');
    expect(page).toContain('alerts.webhookUrl must be https');
    expect(page).toContain('id="f-heartbeat-intervalSeconds-error"');
    expect(page).toContain('aria-invalid="true"');
    expect(page).toContain('value="5"');
    expect(await deps.store.getSettings('fleet')).toBeNull();
  });

  test('reserved labels and duplicates are refused with the schema message', async () => {
    const { app } = populated();
    const res = await post(app, '/settings/fleet', {
      mode: 'form',
      'runners.extraLabels': 'gpu',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('the image already sets it');
  });

  test('role and node scopes save to their own documents', async () => {
    const { app, deps } = populated();
    await post(app, '/settings/role:cache', {
      mode: 'form',
      'disk.alertPercent': '75',
    });
    await post(app, `/settings/node:${IDS.cache}`, {
      mode: 'form',
      'capacity.slotMax': '2',
    });
    expect((await deps.store.getSettings('role:cache'))?.value).toEqual({
      disk: { alertPercent: 75 },
    });
    expect((await deps.store.getSettings(`node:${IDS.cache}`))?.value).toEqual({
      capacity: { slotMax: 2 },
    });
    expect(await deps.store.getSettings('fleet')).toBeNull();
  });

  test('clearing every field saves an empty document', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 80 } },
      'chris'
    );
    await post(app, '/settings/fleet', { mode: 'form' });
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({});
  });
});

describe('raw JSON', () => {
  test('valid JSON replaces the document', async () => {
    const { app, deps } = populated();
    const res = await post(app, '/settings/fleet', {
      mode: 'raw',
      raw: '{"disk":{"alertPercent":85}}',
    });
    expect(res.status).toBe(303);
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      disk: { alertPercent: 85 },
    });
  });

  test('unknown keys, bad JSON and non-objects show an error and keep the text', async () => {
    const { app, deps } = populated();
    const unknown = await post(app, '/settings/fleet', {
      mode: 'raw',
      raw: '{"disk":{"alertPercentt":85}}',
    });
    expect(unknown.status).toBe(422);
    const unknownPage = await unknown.text();
    expect(unknownPage).toContain('disk.alertPercentt is not a setting');
    const broken = await post(app, '/settings/fleet', {
      mode: 'raw',
      raw: '{nope',
    });
    expect(broken.status).toBe(422);
    const brokenPage = await broken.text();
    expect(brokenPage).toContain('That is not valid JSON.');
    expect(brokenPage).toContain('{nope');
    const list = await post(app, '/settings/fleet', {
      mode: 'raw',
      raw: '[1]',
    });
    expect(await list.text()).toContain('must be a JSON object');
    expect(await deps.store.getSettings('fleet')).toBeNull();
  });
});

describe('the webhook secret', () => {
  const SECRET =
    'https://hooks.example.com/services/T0/B0/topsecrettoken?sig=abc';

  test('never appears in any page, only its host', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { alerts: { webhookUrl: SECRET, offlineAfterSeconds: 300 } },
      'chris'
    );
    for (const path of [
      '/settings',
      '/settings/fleet',
      '/settings/role:ci',
      `/nodes/${IDS.online}`,
      '/',
    ]) {
      const page = await html(app, path);
      expect(page).not.toContain('topsecrettoken');
      expect(page).not.toContain('sig=abc');
    }
    const page = await html(app, '/settings/fleet');
    expect(page).toContain('Currently: https://hooks.example.com/');
    expect(page).toContain('Remove the saved webhook');
  });

  test('leaving it empty keeps it, the masked raw value keeps it, remove clears it', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { alerts: { webhookUrl: SECRET } },
      'chris'
    );
    await post(app, '/settings/fleet', {
      mode: 'form',
      'alerts.webhookUrl': '',
    });
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      alerts: { webhookUrl: SECRET },
    });
    const raw = await html(app, '/settings/fleet');
    expect(raw).toContain('https://hooks.example.com/…');
    await post(app, '/settings/fleet', {
      mode: 'raw',
      raw: '{"alerts":{"webhookUrl":"https://hooks.example.com/…"}}',
    });
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      alerts: { webhookUrl: SECRET },
    });
    await post(app, '/settings/fleet', {
      mode: 'form',
      'alerts.webhookUrl': 'https://new.example.com/x',
    });
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      alerts: { webhookUrl: 'https://new.example.com/x' },
    });
    await post(app, '/settings/fleet', {
      mode: 'form',
      'alerts.webhookUrl.__clear': '1',
    });
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({});
  });
});

describe('history and restore', () => {
  test('lists who and when, with restore on older versions only', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 70 } },
      'chris'
    );
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 80 } },
      'dana'
    );
    const page = await html(app, '/settings/fleet');
    expect(page).toContain('dana');
    expect(page).toContain('chris');
    expect(page).toContain('>current<');
    expect(page.match(/Restore this version/g)).toHaveLength(1);
    expect(page).toContain('action="/settings/fleet/restore"');
  });

  test('restore writes the old document again, as a new history entry', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 70 } },
      'chris'
    );
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 80 } },
      'dana'
    );
    const history = await deps.store.settingsHistory('fleet', 10);
    const oldest = history[history.length - 1];
    const res = await post(app, '/settings/fleet/restore', {
      historyId: String(oldest?.id),
    });
    expect(res.status).toBe(303);
    expect((await deps.store.getSettings('fleet'))?.value).toEqual({
      disk: { alertPercent: 70 },
    });
    expect(await deps.store.settingsHistory('fleet', 10)).toHaveLength(3);
    expect(await html(app, '/settings/fleet', cookiesFrom(res))).toContain(
      'Previous version restored.'
    );
  });

  test('restoring an unknown version changes nothing', async () => {
    const { app, deps } = populated();
    await deps.store.putSettings(
      'fleet',
      { disk: { alertPercent: 70 } },
      'chris'
    );
    const res = await post(app, '/settings/fleet/restore', {
      historyId: '9999',
    });
    expect(await html(app, '/settings/fleet', cookiesFrom(res))).toContain(
      'cannot be restored'
    );
    expect(await deps.store.settingsHistory('fleet', 10)).toHaveLength(1);
  });
});
