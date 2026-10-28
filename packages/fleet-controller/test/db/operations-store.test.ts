import { beforeEach, describe, expect, test } from 'bun:test';

import { EXCLUDES } from '../../src/domain/operations';
import type {
  NewOperation,
  OperationsStore,
} from '../../src/domain/operations-store';
import type { Store } from '../../src/store';
import { MemoryStore } from '../../src/testing/memory-store';
import { at, nodeIdOf, registerInput } from '../support/fixtures';
import { useDatabase } from '../support/database';

const draft = (
  id: string,
  nodeId: string,
  overrides: Partial<NewOperation> = {}
): NewOperation => ({
  id,
  kind: 'drain',
  nodeId,
  requestedBy: 'admin@example.com',
  requestedAt: at(0),
  progress: 'requested',
  idempotencyKey: null,
  detail: {},
  ...overrides,
});

interface Fixture {
  readonly store: Store;
  readonly reset: () => Promise<void>;
}

function contract(name: string, make: () => Promise<Fixture>): void {
  describe(`operations store: ${name}`, () => {
    let fixture: Fixture;
    let ops: OperationsStore;
    const node = nodeIdOf(1);
    const other = nodeIdOf(2);
    beforeEach(async () => {
      fixture = await make();
      await fixture.reset();
      ops = fixture.store.operations;
      await fixture.store.registerNode(registerInput(1));
      await fixture.store.registerNode(registerInput(2));
    });

    test('creates a pending operation and reads it back', async () => {
      const result = await ops.create(draft('a', node), EXCLUDES.drain);
      expect(result.outcome).toBe('created');
      const stored = await ops.get('a');
      expect(stored).toMatchObject({
        id: 'a',
        kind: 'drain',
        nodeId: node,
        status: 'pending',
        attempts: 0,
        progress: 'requested',
        failure: null,
        completedAt: null,
        detail: {},
      });
      expect(stored?.requestedAt.toISOString()).toBe(at(0).toISOString());
    });

    test('at most one active operation per node and kind, others are free', async () => {
      await ops.create(draft('a', node), EXCLUDES.drain);
      const second = await ops.create(draft('b', node), EXCLUDES.drain);
      expect(second).toMatchObject({
        outcome: 'conflict',
        operation: { id: 'a' },
      });
      expect(
        (await ops.create(draft('c', other), EXCLUDES.drain)).outcome
      ).toBe('created');
      expect(
        (
          await ops.create(
            draft('d', node, { kind: 'restart' }),
            EXCLUDES.restart
          )
        ).outcome
      ).toBe('created');
      expect(
        (
          await ops.create(
            draft('e', node, { kind: 'decommission' }),
            EXCLUDES.decommission
          )
        ).outcome
      ).toBe('conflict');
    });

    test('a finished operation no longer blocks a new one', async () => {
      await ops.create(draft('a', node), EXCLUDES.drain);
      await ops.update('a', {
        expect: 'pending',
        status: 'cancelled',
        updatedAt: at(5),
        progress: 'cancelled',
      });
      expect((await ops.create(draft('b', node), EXCLUDES.drain)).outcome).toBe(
        'created'
      );
    });

    test('an idempotency key replays the same request and refuses a different one', async () => {
      const key = 'retry-1';
      await ops.create(
        draft('a', node, { idempotencyKey: key }),
        EXCLUDES.drain
      );
      expect(
        await ops.create(
          draft('b', node, { idempotencyKey: key }),
          EXCLUDES.drain
        )
      ).toMatchObject({ outcome: 'replayed', operation: { id: 'a' } });
      expect(
        await ops.create(
          draft('c', other, { idempotencyKey: key }),
          EXCLUDES.drain
        )
      ).toMatchObject({ outcome: 'key_conflict', operation: { id: 'a' } });
      expect((await ops.findByKey(key))?.id).toBe('a');
      expect(await ops.findByKey('missing')).toBeNull();
    });

    test('update is a compare-and-swap on the status and merges detail', async () => {
      await ops.create(
        draft('a', node, { detail: { keep: 1, drop: 2 } }),
        EXCLUDES.drain
      );
      const moved = await ops.update('a', {
        expect: 'pending',
        status: 'in_progress',
        updatedAt: at(10),
        progress: 'working',
        detail: { stage: 'draining', drop: null },
        countAttempt: true,
      });
      expect(moved).toMatchObject({
        status: 'in_progress',
        progress: 'working',
        attempts: 1,
        completedAt: null,
        detail: { keep: 1, stage: 'draining' },
      });
      expect(moved?.detail).not.toHaveProperty('drop');
      // The status moved: a stale writer loses.
      expect(
        await ops.update('a', {
          expect: 'pending',
          status: 'failed',
          updatedAt: at(11),
          progress: 'late',
        })
      ).toBeNull();
      const done = await ops.update('a', {
        expect: 'in_progress',
        status: 'failed',
        updatedAt: at(20),
        progress: 'timed out',
        failure: 'It did not finish.',
      });
      expect(done).toMatchObject({
        status: 'failed',
        failure: 'It did not finish.',
        attempts: 1,
      });
      expect(done?.completedAt?.toISOString()).toBe(at(20).toISOString());
      expect(
        await ops.update('missing', {
          expect: 'pending',
          status: 'failed',
          updatedAt: at(1),
          progress: null,
        })
      ).toBeNull();
    });

    test('lists newest first with filters and paging', async () => {
      await ops.create(
        draft('a', node, { requestedAt: at(0) }),
        EXCLUDES.drain
      );
      await ops.create(
        draft('b', other, { requestedAt: at(10) }),
        EXCLUDES.drain
      );
      await ops.create(
        draft('c', node, { kind: 'restart', requestedAt: at(20) }),
        EXCLUDES.restart
      );
      await ops.update('a', {
        expect: 'pending',
        status: 'cancelled',
        updatedAt: at(30),
        progress: null,
      });
      expect((await ops.list({ limit: 10 })).map((o) => o.id)).toEqual([
        'c',
        'b',
        'a',
      ]);
      expect(
        (await ops.list({ limit: 10, nodeId: node })).map((o) => o.id)
      ).toEqual(['c', 'a']);
      expect(
        (await ops.list({ limit: 10, kind: 'drain' })).map((o) => o.id)
      ).toEqual(['b', 'a']);
      expect(
        (await ops.list({ limit: 10, status: 'cancelled' })).map((o) => o.id)
      ).toEqual(['a']);
      expect(
        (await ops.list({ limit: 10, activeOnly: true })).map((o) => o.id)
      ).toEqual(['c', 'b']);
      expect((await ops.list({ limit: 1 })).map((o) => o.id)).toEqual(['c']);
      expect(
        (
          await ops.list({
            limit: 10,
            before: { requestedAt: at(20), id: 'c' },
          })
        ).map((o) => o.id)
      ).toEqual(['b', 'a']);
    });

    test('active operations for a node include those naming it as replacement', async () => {
      await ops.create(
        draft('r', other, { kind: 'replace', detail: { replacement: node } }),
        EXCLUDES.replace
      );
      await ops.create(draft('d', node), EXCLUDES.drain);
      expect((await ops.listActiveFor(node)).map((o) => o.id).sort()).toEqual([
        'd',
        'r',
      ]);
      expect((await ops.listActiveFor(other)).map((o) => o.id)).toEqual(['r']);
      expect(await ops.listActiveFor(nodeIdOf(9))).toEqual([]);
    });

    test('lifecycle patches only the named columns and null clears', async () => {
      expect(await ops.lifecycle(node)).toBeNull();
      await ops.patchLifecycle(node, {
        drainRequestedAt: at(1),
        drainReason: 'rack move',
      });
      await ops.patchLifecycle(node, { restartRequestedAt: at(2) });
      expect(await ops.lifecycle(node)).toMatchObject({
        nodeId: node,
        drainReason: 'rack move',
        replacedBy: null,
      });
      expect((await ops.lifecycle(node))?.drainRequestedAt?.toISOString()).toBe(
        at(1).toISOString()
      );
      await ops.patchLifecycle(node, {
        drainRequestedAt: null,
        drainReason: null,
      });
      expect(await ops.lifecycle(node)).toMatchObject({
        drainRequestedAt: null,
        drainReason: null,
      });
      expect(
        (await ops.lifecycle(node))?.restartRequestedAt?.toISOString()
      ).toBe(at(2).toISOString());
    });
  });
}

contract('in memory', async () => ({
  store: new MemoryStore(),
  reset: async () => {},
}));

describe('operations store: sqlite specifics', () => {
  const database = useDatabase();
  contract('sqlite', async () => {
    const { store } = await database().newStore();
    return {
      store,
      reset: async () => {
        const { sql } = database();
        await sql.unsafe('delete from operations');
        await sql.unsafe('delete from nodes');
      },
    };
  });

  test('operations outlive the node they were about; lifecycle rows do not', async () => {
    const { store } = await database().newStore();
    await store.registerNode(registerInput(3));
    await store.operations.create(draft('keep', nodeIdOf(3)), EXCLUDES.drain);
    await store.operations.patchLifecycle(nodeIdOf(3), {
      drainRequestedAt: at(1),
    });
    await store.deleteNode(nodeIdOf(3), 'admin');
    expect((await store.operations.get('keep'))?.nodeId).toBe(nodeIdOf(3));
    expect(await store.operations.lifecycle(nodeIdOf(3))).toBeNull();
    await database().sql.unsafe('delete from operations');
  });

  test('the database refuses an unknown status or malformed detail', async () => {
    const { sql } = database();
    await expect(
      sql.unsafe(
        `insert into operations (id, kind, status, requested_by) values ('x', 'drain', 'bogus', 'a')`
      )
    ).rejects.toThrow();
    await expect(
      sql.unsafe(
        `insert into operations (id, kind, status, requested_by, detail) values ('y', 'drain', 'pending', 'a', 'not json')`
      )
    ).rejects.toThrow();
  });
});
