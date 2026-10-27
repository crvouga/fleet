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
});
