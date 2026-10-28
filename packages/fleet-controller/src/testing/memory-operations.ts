import {
  isActive,
  isTerminal,
  type Operation,
  type OperationKind,
} from '../domain/operations';
import type {
  CreateResult,
  LifecyclePatch,
  NewOperation,
  NodeLifecycle,
  OperationQuery,
  OperationUpdate,
  OperationsStore,
} from '../domain/operations-store';

const BLANK = (nodeId: string): NodeLifecycle => ({
  nodeId,
  drainRequestedAt: null,
  drainReason: null,
  restartRequestedAt: null,
  restartCompletedAt: null,
  replacedBy: null,
  decommissionRequestedAt: null,
});

function byIdDescending(a: Operation, b: Operation): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

const newestFirst = (a: Operation, b: Operation): number =>
  b.requestedAt.getTime() - a.requestedAt.getTime() || byIdDescending(a, b);

/** The in-memory twin of SqliteOperations: same contract, same results. */
export class MemoryOperations implements OperationsStore {
  private readonly operations = new Map<string, Operation>();
  private readonly lifecycles = new Map<string, NodeLifecycle>();

  async create(
    input: NewOperation,
    exclusive: readonly OperationKind[]
  ): Promise<CreateResult> {
    const all = [...this.operations.values()];
    const replay =
      input.idempotencyKey === null
        ? undefined
        : all.find((op) => op.idempotencyKey === input.idempotencyKey);
    if (replay !== undefined) {
      const same = replay.kind === input.kind && replay.nodeId === input.nodeId;
      return { outcome: same ? 'replayed' : 'key_conflict', operation: replay };
    }
    const other = all
      .filter((op) => op.nodeId === input.nodeId && isActive(op.status))
      .find((op) => exclusive.includes(op.kind));
    if (other !== undefined) return { outcome: 'conflict', operation: other };
    const operation: Operation = {
      id: input.id,
      kind: input.kind,
      nodeId: input.nodeId,
      status: 'pending',
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      updatedAt: input.requestedAt,
      completedAt: null,
      attempts: 0,
      progress: input.progress,
      failure: null,
      idempotencyKey: input.idempotencyKey,
      detail: { ...input.detail },
    };
    this.operations.set(operation.id, operation);
    return { outcome: 'created', operation };
  }

  async get(id: string): Promise<Operation | null> {
    return this.operations.get(id) ?? null;
  }

  async findByKey(key: string): Promise<Operation | null> {
    return (
      [...this.operations.values()].find((op) => op.idempotencyKey === key) ??
      null
    );
  }

  async list(query: OperationQuery): Promise<readonly Operation[]> {
    const { before } = query;
    return [...this.operations.values()]
      .filter((op) => query.nodeId === undefined || op.nodeId === query.nodeId)
      .filter((op) => query.kind === undefined || op.kind === query.kind)
      .filter((op) => query.status === undefined || op.status === query.status)
      .filter((op) => query.activeOnly !== true || isActive(op.status))
      .filter(
        (op) =>
          before === undefined ||
          op.requestedAt < before.requestedAt ||
          (op.requestedAt.getTime() === before.requestedAt.getTime() &&
            op.id < before.id)
      )
      .sort(newestFirst)
      .slice(0, query.limit);
  }

  async listActiveFor(nodeId: string): Promise<readonly Operation[]> {
    return [...this.operations.values()]
      .filter((op) => isActive(op.status))
      .filter(
        (op) => op.nodeId === nodeId || op.detail['replacement'] === nodeId
      )
      .sort((a, b) => -newestFirst(a, b));
  }

  async update(id: string, change: OperationUpdate): Promise<Operation | null> {
    const current = this.operations.get(id);
    if (current === undefined || current.status !== change.expect) return null;
    const detail: Record<string, unknown> = { ...current.detail };
    for (const [key, value] of Object.entries(change.detail ?? {})) {
      if (value === null) delete detail[key];
      else detail[key] = value;
    }
    const next: Operation = {
      ...current,
      status: change.status,
      updatedAt: change.updatedAt,
      progress: change.progress,
      failure: change.failure === undefined ? current.failure : change.failure,
      detail,
      attempts: current.attempts + (change.countAttempt === true ? 1 : 0),
      completedAt: isTerminal(change.status)
        ? change.updatedAt
        : current.completedAt,
    };
    this.operations.set(id, next);
    return next;
  }

  async lifecycle(nodeId: string): Promise<NodeLifecycle | null> {
    return this.lifecycles.get(nodeId) ?? null;
  }

  async patchLifecycle(nodeId: string, patch: LifecyclePatch): Promise<void> {
    const current = this.lifecycles.get(nodeId) ?? BLANK(nodeId);
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch))
      if (value !== undefined) next[key] = value;
    this.lifecycles.set(nodeId, next as unknown as NodeLifecycle);
  }
}
