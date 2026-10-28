import { describe, expect, test } from 'bun:test';

import { IDS, cookiesFrom, get, html, post, seedFleet, setup } from './helpers';

function populated() {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

const VIEWER = 'fleet_session=viewer:reader';

describe('operation forms', () => {
  test('restart needs the node name typed; with it, an operation and an audit entry exist', async () => {
    const { app, deps } = populated();
    const refused = await post(app, `/nodes/${IDS.online}/operations/restart`, {
      confirm: 'yes',
    });
    expect(
      await html(
        app,
        refused.headers.get('location') ?? '/',
        cookiesFrom(refused)
      )
    ).toContain('type its name (Build 1)');
    expect(await deps.store.operations.list({ limit: 5 })).toEqual([]);
    const accepted = await post(
      app,
      `/nodes/${IDS.online}/operations/restart`,
      {
        confirm: 'Build 1',
      }
    );
    expect(accepted.status).toBe(303);
    const [op] = await deps.store.operations.list({ limit: 5 });
    expect(op).toMatchObject({
      kind: 'restart',
      nodeId: IDS.online,
      status: 'pending',
      requestedBy: 'tester',
    });
    expect(
      (await deps.store.getSettings(`node:${IDS.online}`))?.value
    ).toHaveProperty('maintenance.restartAfter');
    const trail = await deps.store.listAudit({
      limit: 10,
      targetId: IDS.online,
    });
    expect(trail.map((e) => [e.action, e.outcome]).reverse()).toEqual([
      ['node.restart', 'denied'],
      ['node.restart', 'success'],
    ]);
  });

  test('replace and decommission need the name too; decommission of a reachable node ignores force', async () => {
    const { app, deps } = populated();
    for (const kind of ['replace', 'decommission'])
      await post(app, `/nodes/${IDS.online}/operations/${kind}`, {
        replacement: IDS.pending,
      });
    expect(await deps.store.operations.list({ limit: 5 })).toEqual([]);
    const forced = await post(
      app,
      `/nodes/${IDS.online}/operations/decommission`,
      {
        confirm: 'Build 1',
        force: 'true',
      }
    );
    expect(
      await html(
        app,
        forced.headers.get('location') ?? '/',
        cookiesFrom(forced)
      )
    ).toContain('force is only for a node that has stopped reporting');
    expect(await deps.store.operations.list({ limit: 5 })).toEqual([]);
  });

  test('drain and undrain need no typed name, and undrain cancels the drain', async () => {
    const { app, deps } = populated();
    await post(app, `/nodes/${IDS.online}/operations/drain`);
    expect((await deps.store.getSettings(`node:${IDS.online}`))?.value).toEqual(
      { runners: { cordoned: true } }
    );
    const undrained = await post(
      app,
      `/nodes/${IDS.online}/operations/undrain`
    );
    expect(
      await html(
        app,
        undrained.headers.get('location') ?? '/',
        cookiesFrom(undrained)
      )
    ).toContain('Undrained');
    expect((await deps.store.operations.list({ limit: 5 }))[0]?.status).toBe(
      'cancelled'
    );
  });

  test('cancel works from the operations page form', async () => {
    const { app, deps } = populated();
    await post(app, `/nodes/${IDS.online}/operations/drain`);
    const [op] = await deps.store.operations.list({ limit: 5 });
    const cancelled = await post(app, `/operations/${op?.id}/cancel`);
    expect(cancelled.headers.get('location')).toBe('/operations');
    expect((await deps.store.operations.get(op?.id ?? ''))?.status).toBe(
      'cancelled'
    );
  });

  test('every form refuses a foreign origin and a viewer, and changes nothing', async () => {
    const { app, deps } = populated();
    const paths = [
      `/nodes/${IDS.online}/operations/drain`,
      `/nodes/${IDS.online}/operations/restart`,
      `/operations/anything/cancel`,
    ];
    for (const path of paths) {
      expect(
        (
          await post(
            app,
            path,
            { confirm: 'Build 1' },
            { origin: 'https://evil.example' }
          )
        ).status
      ).toBe(403);
      expect(
        (await post(app, path, { confirm: 'Build 1' }, { cookie: VIEWER }))
          .status
      ).toBe(403);
    }
    expect(await deps.store.operations.list({ limit: 5 })).toEqual([]);
  });

  test('unknown node or action flashes an error', async () => {
    const { app } = populated();
    const res = await post(app, `/nodes/${'7'.repeat(64)}/operations/drain`);
    expect(res.headers.get('location')).toBe('/nodes');
    const bad = await post(app, `/nodes/${IDS.online}/operations/explode`);
    expect(bad.headers.get('location')).toBe('/nodes');
  });
});

describe('operations and audit pages', () => {
  test('the operations page lists requests with their progress and a cancel form', async () => {
    const { app } = populated();
    expect(await html(app, '/operations')).toContain('No operations yet');
    await post(app, `/nodes/${IDS.online}/operations/drain`);
    const page = await html(app, '/operations');
    expect(page).toContain('Drain requested');
    expect(page).toContain('Build 1');
    expect(page).toMatch(/action="\/operations\/[^"]+\/cancel"/);
    expect(page).toContain('href="/operations"');
  });

  test('the audit page is for administrators; a viewer is told no and the denial is audited', async () => {
    const { app, deps } = populated();
    await post(app, `/nodes/${IDS.online}/operations/drain`);
    const page = await html(app, '/audit');
    expect(page).toContain('node.drain');
    expect(page).toContain('tester');
    const denied = await get(app, '/audit', VIEWER);
    expect(denied.status).toBe(403);
    expect(
      (await deps.store.listAudit({ limit: 10 })).some(
        (e) => e.outcome === 'denied' && e.action === 'audit.read'
      )
    ).toBe(true);
    expect((await get(app, '/audit', null)).status).toBe(303);
  });

  test('the navigation links both pages', async () => {
    const { app } = populated();
    const page = await html(app, '/');
    expect(page).toContain('href="/operations"');
    expect(page).toContain('href="/audit"');
  });

  test('the pending page asks for the name before rejecting', async () => {
    const { app } = populated();
    const page = await html(app, '/pending');
    expect(page).toContain('Type netboot-f001 to confirm');
    expect(page).not.toContain('name="confirm" value="yes"');
  });
});
