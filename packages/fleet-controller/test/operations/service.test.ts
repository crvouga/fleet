import { describe, expect, test } from 'bun:test';

import {
  reconcileForNode,
  reconcileOne,
  sweepOperations,
} from '../../src/operations/reconcile';
import { requestOperation } from '../../src/operations/request';
import { cancelOperation, undrainNode } from '../../src/operations/withdraw';
import { MemoryStore } from '../../src/testing/memory-store';
import { Clock } from '../support/controller';
import {
  heartbeatBody,
  nodeIdOf,
  registerInput,
  sha256,
} from '../support/fixtures';

async function fixture() {
  const clock = new Clock();
  const store = new MemoryStore(clock.now);
  const deps = { store, now: clock.now };
  await store.registerNode(
    registerInput(1, {
      approval: 'approved',
      tokenRole: 'ci',
      enrolledVia: 'enrollment-token',
      secretHash: sha256('s'),
    })
  );
  await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, clock.now());
  return { clock, store, deps };
}

const drain = (actor = 'a@example.com') => ({
  kind: 'drain' as const,
  nodeId: nodeIdOf(1),
  actor,
});

describe('operations service (in-memory store)', () => {
  test('reconciling an unchanged observation writes nothing', async () => {
    const { clock, deps } = await fixture();
    const started = await requestOperation(deps, drain());
    if (!started.ok) throw new Error('refused');
    clock.advance(10);
    const first = await reconcileOne(deps, started.operation);
    clock.advance(10);
    const second = await reconcileOne(deps, first);
    expect(second).toBe(first);
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(second.status).toBe('pending');
  });

  test('a lost compare-and-swap leaves the winner’s state', async () => {
    const { deps, store } = await fixture();
    const started = await requestOperation(deps, drain());
    if (!started.ok) throw new Error('refused');
    const stale = started.operation;
    await store.operations.update(stale.id, {
      expect: 'pending',
      status: 'cancelled',
      updatedAt: deps.now(),
      progress: 'cancelled elsewhere',
    });
    const result = await reconcileOne(deps, stale);
    expect(result.status).toBe('cancelled');
  });

  test('a terminal operation is never reconciled again', async () => {
    const { deps, clock } = await fixture();
    const started = await requestOperation(deps, drain());
    if (!started.ok) throw new Error('refused');
    const cancelled = await cancelOperation(
      deps,
      started.operation.id,
      'a@example.com'
    );
    if (!cancelled.ok) throw new Error('not cancelled');
    clock.advance(10 * 3600);
    expect(await reconcileOne(deps, cancelled.operation)).toBe(
      cancelled.operation
    );
    expect(await sweepOperations(deps)).toBe(0);
  });

  test('an operation on a deleted node fails with an explanation', async () => {
    const { deps, store } = await fixture();
    const started = await requestOperation(deps, drain());
    if (!started.ok) throw new Error('refused');
    await store.deleteNode(nodeIdOf(1), 'a@example.com');
    expect(await sweepOperations(deps)).toBe(1);
    expect(await store.operations.get(started.operation.id)).toMatchObject({
      status: 'failed',
      failure: expect.stringContaining('deleted'),
    });
  });

  test('retiring a node cancels its drain; a decommission is complete', async () => {
    const { deps, store } = await fixture();
    const started = await requestOperation(deps, drain());
    if (!started.ok) throw new Error('refused');
    await store.setApproval(nodeIdOf(1), 'retired', 'a@example.com');
    expect(await reconcileForNode(deps, nodeIdOf(1))).toBe(true);
    expect((await store.operations.get(started.operation.id))?.status).toBe(
      'cancelled'
    );
  });

  test('undrain is refused while a decommission holds the node', async () => {
    const { deps } = await fixture();
    const held = await requestOperation(deps, {
      kind: 'decommission',
      nodeId: nodeIdOf(1),
      actor: 'a@example.com',
    });
    expect(held.ok).toBe(true);
    const refused = await undrainNode(deps, nodeIdOf(1), 'a@example.com');
    expect(refused).toMatchObject({
      ok: false,
      status: 409,
      code: 'operation_in_progress',
    });
  });

  test('requests against a missing node are 404 and audited nowhere as success', async () => {
    const { deps, store } = await fixture();
    const result = await requestOperation(deps, {
      ...drain(),
      nodeId: nodeIdOf(9),
    });
    expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(
      (await store.listAudit({ limit: 5 })).filter(
        (e) => e.outcome === 'success'
      )
    ).toEqual([]);
  });
});
