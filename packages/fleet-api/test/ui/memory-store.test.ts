import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { MemoryStore } from '../../src/testing/memory-store';
import { heartbeatBody, nodeId } from '../../src/testing/fixtures';

const hash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const NOW = new Date('2026-10-14T12:00:00Z');

function fresh() {
  let clock = NOW;
  const store = new MemoryStore(() => clock);
  return {
    store,
    tick: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
}

const register = (
  store: MemoryStore,
  short: string,
  approval: 'pending' | 'approved',
  secret = 's1'
) =>
  store.registerNode({
    id: nodeId(short),
    role: 'ci',
    hostname: `ci-${short}`,
    secretHash: hash(secret),
    approval,
    enrolledVia: approval === 'approved' ? 'role-token' : 'hello',
    remoteAddr: '10.0.0.1',
  });

describe('MemoryStore', () => {
  test('register creates once, then replaces the secret', async () => {
    const { store } = fresh();
    const first = await register(store, 'aaaa', 'pending');
    expect(first.created).toBe(true);
    expect(first.node.approval).toBe('pending');
    const second = await register(store, 'aaaa', 'pending', 's2');
    expect(second.created).toBe(false);
    expect(await store.authenticateNode(nodeId('aaaa'), hash('s1'))).toBeNull();
    await store.setApproval(nodeId('aaaa'), 'approved', 'chris');
    expect(
      await store.authenticateNode(nodeId('aaaa'), hash('s2'))
    ).not.toBeNull();
  });

  test('rejected stays rejected on register; retired comes back as given', async () => {
    const { store } = fresh();
    await register(store, 'bbbb', 'pending');
    await store.setApproval(nodeId('bbbb'), 'rejected', 'chris');
    expect((await register(store, 'bbbb', 'approved')).node.approval).toBe(
      'rejected'
    );
    await register(store, 'cccc', 'approved');
    await store.setApproval(nodeId('cccc'), 'retired', 'chris');
    expect((await register(store, 'cccc', 'pending')).node.approval).toBe(
      'pending'
    );
  });

  test('authenticate refuses wrong hashes, rejected and retired nodes', async () => {
    const { store } = fresh();
    await register(store, 'dddd', 'approved');
    expect(await store.authenticateNode(nodeId('dddd'), 'wrong')).toBeNull();
    expect(
      await store.authenticateNode(nodeId('dddd'), hash('s1'))
    ).not.toBeNull();
    await store.setApproval(nodeId('dddd'), 'retired', 'chris');
    expect(await store.authenticateNode(nodeId('dddd'), hash('s1'))).toBeNull();
  });

  test('approval changes record who and when, and an event', async () => {
    const { store, tick } = fresh();
    await register(store, 'eeee', 'pending');
    tick(1000);
    const row = await store.setApproval(nodeId('eeee'), 'approved', 'dana');
    expect(row?.approvedBy).toBe('dana');
    expect(row?.approvedAt?.getTime()).toBe(NOW.getTime() + 1000);
    const events = await store.listEvents({ limit: 10 });
    expect(events[0]?.kind).toBe('approved');
    expect(events[0]?.message).toContain('dana');
  });

  test('heartbeats update the node, add a history point and the node events', async () => {
    const { store } = fresh();
    await register(store, 'ffff', 'approved');
    const id = nodeId('ffff');
    const body = heartbeatBody(id, 'ci', 'ci-ffff', {
      revision: 'abc',
      memory: { totalMiB: 1000, availableMiB: 250 },
      events: [{ kind: 'boot', severity: 'info', message: 'node started' }],
    });
    const row = await store.recordHeartbeat(id, body, '10.0.0.9', NOW);
    expect(row?.revision).toBe('abc');
    expect(row?.lastSeenAt).toEqual(NOW);
    const points = await store.listHeartbeats(
      id,
      new Date(NOW.getTime() - 1000)
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.memUsedPercent).toBe(75);
    expect((await store.listEvents({ nodeId: id, limit: 5 }))[0]?.message).toBe(
      'node started'
    );
    expect(
      await store.recordHeartbeat(nodeId('0000'), body, null, NOW)
    ).toBeNull();
  });

  test('delete forgets the node but events keep its label', async () => {
    const { store } = fresh();
    await register(store, '1111', 'approved');
    expect(await store.deleteNode(nodeId('1111'), 'chris')).toBe(true);
    expect(await store.deleteNode(nodeId('1111'), 'chris')).toBe(false);
    expect(await store.findNode(nodeId('1111'))).toBeNull();
    const events = await store.listEvents({ limit: 10 });
    expect(events.every((e) => e.nodeId === null)).toBe(true);
    expect(events[0]?.nodeLabel).toBe('ci-1111');
  });

  test('events page by id, newest first, and filter by node and severity', async () => {
    const { store } = fresh();
    for (let i = 0; i < 5; i += 1) {
      await store.addEvent({
        nodeId: i % 2 === 0 ? 'n' : null,
        nodeLabel: null,
        kind: 'k',
        severity: i === 4 ? 'error' : 'warn',
        message: `m${i}`,
      });
    }
    const all = await store.listEvents({ limit: 10 });
    expect(all.map((e) => e.message)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
    const older = await store.listEvents({
      limit: 2,
      beforeId: all[1]?.id ?? 0,
    });
    expect(older.map((e) => e.message)).toEqual(['m2', 'm1']);
    expect(
      (await store.listEvents({ limit: 10, severity: 'error' })).map(
        (e) => e.message
      )
    ).toEqual(['m4']);
    expect(
      (await store.listEvents({ limit: 10, nodeId: 'n' })).map((e) => e.message)
    ).toEqual(['m4', 'm2', 'm0']);
  });

  test('settings: put replaces, appends history, newest first', async () => {
    const { store, tick } = fresh();
    await store.putSettings(
      'fleet',
      { heartbeat: { intervalSeconds: 30 } },
      'chris'
    );
    tick(1000);
    await store.putSettings(
      'fleet',
      { heartbeat: { intervalSeconds: 90 } },
      'dana'
    );
    expect((await store.getSettings('fleet'))?.value).toEqual({
      heartbeat: { intervalSeconds: 90 },
    });
    expect(await store.getSettings('role:ci')).toBeNull();
    const history = await store.settingsHistory('fleet', 10);
    expect(history.map((h) => h.changedBy)).toEqual(['dana', 'chris']);
    expect(await store.listSettings()).toHaveLength(1);
  });

  test('offline notices: due once, then marked; prune removes old points', async () => {
    const { store } = fresh();
    await register(store, '2222', 'approved');
    const id = nodeId('2222');
    await store.recordHeartbeat(
      id,
      heartbeatBody(id, 'ci', 'ci-2222'),
      null,
      NOW
    );
    const later = new Date(NOW.getTime() + 600_000);
    expect(await store.nodesDueOfflineNotice(later, 300)).toHaveLength(1);
    await store.setOfflineNotified(id, later);
    expect(await store.nodesDueOfflineNotice(later, 300)).toHaveLength(0);
    expect(await store.pruneHeartbeats(later)).toBe(1);
  });

  test('patch changes only the fields given', async () => {
    const { store } = fresh();
    await register(store, '3333', 'approved');
    const id = nodeId('3333');
    await store.patchNode(id, { displayName: 'Big', labels: ['x'] }, 'chris');
    const row = await store.patchNode(id, { note: 'hello' }, 'chris');
    expect([row?.displayName, row?.note, row?.labels]).toEqual([
      'Big',
      'hello',
      ['x'],
    ]);
  });
});
