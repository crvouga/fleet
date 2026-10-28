import { describe, expect, test } from 'bun:test';

import { FIXED_NOW } from '../../src/testing/test-deps';
import { IDS, post, seedFleet, setup } from './helpers';

function populated() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

describe('recovery operations are audited node settings', () => {
  for (const [path, section, key] of [
    ['retry-update', 'sync', 'retryBootAfter'],
    ['reopen-admission', 'runners', 'reopenAfter'],
    ['rotate-age-key', 'secrets', 'rotateAgeKeyAfter'],
  ] as const) {
    test(`${path} sets ${section}.${key} to now on the node's own settings`, async () => {
      const { app, deps } = populated();
      const scope = `node:${IDS.online}` as const;
      await deps.store.putSettings(
        scope,
        { sync: { paused: true } },
        'someone'
      );
      const res = await post(app, `/nodes/${IDS.online}/recovery/${path}`);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/nodes/${IDS.online}`);
      const saved = (await deps.store.getSettings(scope))?.value as Record<
        string,
        Record<string, unknown>
      >;
      expect(saved[section]?.[key]).toBe(
        Math.floor(FIXED_NOW.getTime() / 1000)
      );
      expect(saved['sync']?.['paused']).toBe(true);
      const history = await deps.store.settingsHistory(scope, 5);
      expect(history[0]?.changedBy).toBe('tester');
    });
  }

  test('a foreign origin changes nothing; an unknown node is refused', async () => {
    const { app, deps } = populated();
    const res = await post(
      app,
      `/nodes/${IDS.online}/recovery/retry-update`,
      {},
      { origin: 'https://evil.example' }
    );
    expect(res.status).toBe(403);
    expect(await deps.store.getSettings(`node:${IDS.online}`)).toBeNull();
    const missing = await post(
      app,
      `/nodes/${'0'.repeat(64)}/recovery/retry-update`
    );
    expect(missing.headers.get('location')).toBe('/nodes');
  });

  test('a settings edit that lands between read and write is not overwritten', async () => {
    const { app, deps } = populated();
    const scope = `node:${IDS.online}` as const;
    await deps.store.putSettings(scope, { sync: { paused: true } }, 'someone');
    // Another administrator saves right after this action reads the document.
    const read = deps.store.getSettings.bind(deps.store);
    let raced = false;
    deps.store.getSettings = async (requested) => {
      const row = await read(requested);
      if (requested === scope && !raced) {
        raced = true;
        await deps.store.putSettings(
          scope,
          { sync: { paused: false }, runners: { cordoned: true } },
          'other-admin',
          row?.revision
        );
      }
      return row;
    };
    const res = await post(app, `/nodes/${IDS.online}/recovery/retry-update`);
    expect(res.status).toBe(303);
    const saved = (await read(scope))?.value as Record<
      string,
      Record<string, unknown>
    >;
    // The other administrator's document survives; the action asked to retry.
    expect(saved['runners']?.['cordoned']).toBe(true);
    expect(saved['sync']?.['retryBootAfter']).toBeUndefined();
    const audit = await deps.store.listAudit({ limit: 5 });
    expect(audit.some((row) => row.outcome === 'failed')).toBe(true);
  });
});
