import type { Operation } from '../domain/operations';
import type {
  CreateResult,
  LifecyclePatch,
  NewOperation,
  NodeLifecycle,
  OperationQuery,
  OperationUpdate,
  OperationsStore,
} from '../domain/operations-store';

import type { Db } from './client';
import { selectLifecycle, upsertLifecycle } from './lifecycle-queries';
import {
  insertOperation,
  selectActiveFor,
  selectActiveOnNode,
  selectByKey,
  selectOperation,
  selectOperations,
  updateOperation,
} from './operations-queries';

/** `operations` and `node_lifecycle` in SQLite. */
export class SqliteOperations implements OperationsStore {
  constructor(private readonly db: Db) {}

  create(
    input: NewOperation,
    exclusive: readonly Operation['kind'][]
  ): Promise<CreateResult> {
    return this.db.begin(async (tx) => {
      const replay =
        input.idempotencyKey === null
          ? null
          : await selectByKey(tx, input.idempotencyKey);
      if (replay !== null) {
        const same =
          replay.kind === input.kind && replay.nodeId === input.nodeId;
        return {
          outcome: same ? 'replayed' : 'key_conflict',
          operation: replay,
        };
      }
      const active = await selectActiveOnNode(tx, input.nodeId);
      const other = active.find((op) => exclusive.includes(op.kind));
      if (other !== undefined) return { outcome: 'conflict', operation: other };
      return {
        outcome: 'created',
        operation: await insertOperation(tx, input),
      };
    });
  }

  get(id: string): Promise<Operation | null> {
    return selectOperation(this.db, id);
  }

  findByKey(key: string): Promise<Operation | null> {
    return selectByKey(this.db, key);
  }

  list(query: OperationQuery): Promise<readonly Operation[]> {
    return selectOperations(this.db, query);
  }

  listActiveFor(nodeId: string): Promise<readonly Operation[]> {
    return selectActiveFor(this.db, nodeId);
  }

  update(id: string, change: OperationUpdate): Promise<Operation | null> {
    return updateOperation(this.db, id, change);
  }

  lifecycle(nodeId: string): Promise<NodeLifecycle | null> {
    return selectLifecycle(this.db, nodeId);
  }

  patchLifecycle(nodeId: string, patch: LifecyclePatch): Promise<void> {
    return upsertLifecycle(this.db, nodeId, patch);
  }
}
