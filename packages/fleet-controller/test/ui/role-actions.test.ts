import { describe, expect, test } from 'bun:test';

import { nodeRow } from '../../src/testing/fixtures';
import {
  IDS,
  cookiesFrom,
  html,
  post,
  seedFleet,
  setup,
  type Harness,
} from './helpers';

function populated(): Harness {
  const harness = setup();
  seedFleet(harness.deps);
  return harness;
}

async function roleEvents(harness: Harness, id: string) {
  const events = await harness.deps.store.listEvents({ nodeId: id, limit: 50 });
  return events.filter((event) => event.kind === 'role_assigned');
}

describe('assigning a role from the dashboard', () => {
  test('assign, change and unassign record the actor each time', async () => {
    const harness = populated();
    const { app, deps } = harness;
    const path = `/nodes/${IDS.online}/role`;
    const unassign = await post(app, path, { role: '' });
    expect(unassign.status).toBe(303);
    expect(unassign.headers.get('location')).toBe(`/nodes/${IDS.online}`);
    expect((await deps.store.findNode(IDS.online))?.role).toBeNull();
    const flash = await html(
      app,
      `/nodes/${IDS.online}`,
      cookiesFrom(unassign)
    );
    expect(flash).toContain('it will run the base system');

    await post(app, path, { role: 'devbox' });
    expect((await deps.store.findNode(IDS.online))?.role).toBe('devbox');
    await post(app, path, { role: 'ci' });
    expect((await deps.store.findNode(IDS.online))?.role).toBe('ci');
    const events = await roleEvents(harness, IDS.online);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.data['actor'] === 'tester')).toBe(
      true
    );
  });

  test('a role that is unknown or retired is refused and changes nothing', async () => {
    const harness = populated();
    for (const role of ['web', 'root', 'ci;rm']) {
      const res = await post(harness.app, `/nodes/${IDS.online}/role`, {
        role,
      });
      expect(res.status).toBe(303);
      const page = await html(
        harness.app,
        res.headers.get('location') ?? '/',
        cookiesFrom(res)
      );
      expect(page).toContain('Choose one of ci, devbox, or no role.');
    }
    expect((await harness.deps.store.findNode(IDS.online))?.role).toBe('ci');
    expect(await roleEvents(harness, IDS.online)).toHaveLength(0);
  });

  test('a cross-origin or missing Origin request is refused', async () => {
    const harness = populated();
    for (const origin of ['https://evil.example', null]) {
      const res = await post(
        harness.app,
        `/nodes/${IDS.online}/role`,
        { role: 'devbox' },
        { origin }
      );
      expect(res.status).toBe(403);
    }
    expect((await harness.deps.store.findNode(IDS.online))?.role).toBe('ci');
  });

  test('a JSON client gets the redirect and flash instead of a 303', async () => {
    const { app } = populated();
    const res = await app.request(`/nodes/${IDS.online}/role`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        cookie: 'fleet_session=ok:tester',
        origin: 'http://localhost',
      },
      body: 'role=devbox',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      redirect: `/nodes/${IDS.online}`,
      flash: { kind: 'success' },
    });
  });
});

describe('approving with a role', () => {
  test('approve assigns the chosen role in the same step', async () => {
    const harness = populated();
    const res = await post(harness.app, `/nodes/${IDS.pending}/approve`, {
      role: 'ci',
      next: '/pending',
    });
    expect(res.headers.get('location')).toBe('/pending');
    const row = await harness.deps.store.findNode(IDS.pending);
    expect(row?.approval).toBe('approved');
    expect(row?.role).toBe('ci');
    const page = await html(harness.app, '/pending', cookiesFrom(res));
    expect(page).toContain('netboot-f001 approved as ci.');
  });

  test('approve without a role leaves the node unassigned', async () => {
    const harness = populated();
    await post(harness.app, `/nodes/${IDS.pending}/approve`, { role: '' });
    const row = await harness.deps.store.findNode(IDS.pending);
    expect(row?.approval).toBe('approved');
    expect(row?.role).toBeNull();
    expect(await roleEvents(harness, IDS.pending)).toHaveLength(0);
  });

  test('approving a reinstalled machine with no choice keeps its stored role', async () => {
    const harness = populated();
    await harness.deps.store.assignRole(IDS.pending, 'devbox', 'chris');
    await post(harness.app, `/nodes/${IDS.pending}/approve`, { role: '' });
    const row = await harness.deps.store.findNode(IDS.pending);
    expect(row?.approval).toBe('approved');
    expect(row?.role).toBe('devbox');
  });

  test('approve with a bad role approves nothing', async () => {
    const harness = populated();
    await post(harness.app, `/nodes/${IDS.pending}/approve`, { role: 'web' });
    const row = await harness.deps.store.findNode(IDS.pending);
    expect(row?.approval).toBe('pending');
    expect(row?.role).toBeNull();
  });
});

describe('the node page shows desired against observed state', () => {
  test('role control, closures, convergence, issues and recipient', async () => {
    const harness = setup();
    const recipient = `age1${'z'.repeat(58)}`;
    const row = nodeRow({
      short: 'd0d0',
      role: 'devbox',
      lastSeenAt: harness.deps.now(),
      body: {
        closure: 'devbox',
        hardware: { capabilities: ['gpu'] },
        ageRecipient: recipient,
        reconcile: {
          phase: 'blocked',
          issues: ['FLEET_SECRETS_RECIPIENT_MISSING: not a recipient'],
        },
      },
    });
    harness.deps.store.seedNode(row);
    const page = await html(harness.app, `/nodes/${row.id}`);
    expect(page).toContain(`action="/nodes/${row.id}/role"`);
    expect(page).toContain('No role (base)');
    expect(page).toContain(
      '<option value="devbox" selected="">devbox</option>'
    );
    expect(page).toContain('Desired closure');
    expect(page).toContain('Running closure');
    expect(page).toContain('Blocked');
    expect(page).toContain('Cannot converge');
    expect(page).toContain('FLEET_SECRETS_RECIPIENT_MISSING: not a recipient');
    expect(page).toContain(recipient);
    expect(page).toContain('Applied revision');
    expect(page).not.toContain('Config revision');
  });

  test('an unassigned node says so and is found by the unassigned filter', async () => {
    const harness = setup();
    const row = nodeRow({
      short: 'ba5e',
      role: null,
      lastSeenAt: harness.deps.now(),
    });
    harness.deps.store.seedNode(row);
    const page = await html(harness.app, `/nodes/${row.id}`);
    expect(page).toContain('unassigned');
    expect(page).toContain(
      '<option value="" selected="">No role (base)</option>'
    );
    expect(page).toContain('<code class="font-mono text-xs">base</code>');
    const list = await html(harness.app, '/nodes?role=unassigned');
    expect(list).toContain('node-ba5e');
    const ci = await html(harness.app, '/nodes?role=ci');
    expect(ci).not.toContain('node-ba5e');
  });
});
