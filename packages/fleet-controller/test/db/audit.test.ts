import { describe, expect, test } from 'bun:test';

import { MemoryStore } from '../../src/testing/memory-store';
import { useDatabase } from '../support/database';

describe('audit log', () => {
  const database = useDatabase();
  test('SQLite store appends, filters and pages entries newest first', async () => {
    const { store, close } = await database().newStore();
    try {
      await store.audit({
        actor: 'a@x',
        action: 'node.retire',
        targetKind: 'node',
        targetId: 'n1',
        detail: { reason: 'lost' },
      });
      await store.audit({
        actor: 'b@x',
        action: 'settings.put',
        targetKind: 'settings',
        targetId: 'fleet',
        outcome: 'denied',
      });
      await store.audit({
        actor: 'a@x',
        action: 'node.delete',
        targetKind: 'node',
        targetId: 'n2',
        outcome: 'failed',
      });
      const all = await store.listAudit({ limit: 10 });
      expect(all.map((r) => r.action)).toEqual([
        'node.delete',
        'settings.put',
        'node.retire',
      ]);
      expect(all[2]?.detail).toEqual({ reason: 'lost' });
      expect(
        await store.listAudit({ limit: 10, targetKind: 'node' })
      ).toHaveLength(2);
      expect(await store.listAudit({ limit: 10, actor: 'b@x' })).toMatchObject([
        { outcome: 'denied' },
      ]);
      const page = await store.listAudit({ limit: 10, beforeId: all[0]!.id });
      expect(page.map((r) => r.action)).toEqual([
        'settings.put',
        'node.retire',
      ]);
    } finally {
      await close();
    }
  });

  test('in-memory store behaves the same', async () => {
    const store = new MemoryStore();
    await store.audit({
      actor: 'a@x',
      action: 'x',
      targetKind: 'node',
      targetId: '1',
    });
    await store.audit({
      actor: 'a@x',
      action: 'y',
      targetKind: 'node',
      targetId: '2',
    });
    expect((await store.listAudit({ limit: 1 }))[0]?.action).toBe('y');
    expect(await store.listAudit({ limit: 5, targetId: '1' })).toHaveLength(1);
  });
});
