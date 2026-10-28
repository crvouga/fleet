import type { Operation, OperationKind, OperationStatus } from './operations';

export interface NewOperation {
  readonly id: string;
  readonly kind: OperationKind;
  readonly nodeId: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly progress: string | null;
  readonly idempotencyKey: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type CreateResult =
  /** Stored. */
  | { readonly outcome: 'created'; readonly operation: Operation }
  /** The idempotency key was seen before for the same node and kind: the stored operation. */
  | { readonly outcome: 'replayed'; readonly operation: Operation }
  /** The key was used for something else. */
  | { readonly outcome: 'key_conflict'; readonly operation: Operation }
  /** An active operation on this node excludes this one. */
  | { readonly outcome: 'conflict'; readonly operation: Operation };

export interface OperationQuery {
  readonly nodeId?: string;
  readonly kind?: OperationKind;
  readonly status?: OperationStatus;
  /** Only pending or in_progress operations. */
  readonly activeOnly?: boolean;
  /** Only operations with an id sorting before this one, for paging (newest first). */
  readonly before?: { readonly requestedAt: Date; readonly id: string };
  readonly limit: number;
}

/** What may change on an existing operation. The status moves one table hop at a time. */
export interface OperationUpdate {
  /** The status the caller read; the update applies only if it is still current. */
  readonly expect: OperationStatus;
  readonly status: OperationStatus;
  readonly updatedAt: Date;
  readonly progress: string | null;
  readonly failure?: string | null;
  /** Merged into the stored detail. */
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly countAttempt?: boolean;
}

/** The controller's record of lifecycle intent per node (`node_lifecycle`). */
export interface NodeLifecycle {
  readonly nodeId: string;
  readonly drainRequestedAt: Date | null;
  readonly drainReason: string | null;
  readonly restartRequestedAt: Date | null;
  readonly restartCompletedAt: Date | null;
  readonly replacedBy: string | null;
  readonly decommissionRequestedAt: Date | null;
}

/** `null` clears a column; a missing key leaves it alone. */
export type LifecyclePatch = {
  readonly [K in keyof Omit<NodeLifecycle, 'nodeId'>]?: NodeLifecycle[K] | null;
};

export interface OperationsStore {
  /**
   * One atomic step: replay by idempotency key, refuse a conflicting active
   * operation (`exclusive` lists the kinds that conflict on this node), else insert.
   */
  create(
    input: NewOperation,
    exclusive: readonly OperationKind[]
  ): Promise<CreateResult>;
  get(id: string): Promise<Operation | null>;
  findByKey(idempotencyKey: string): Promise<Operation | null>;
  list(query: OperationQuery): Promise<readonly Operation[]>;
  /** Active operations on this node or naming it as their replacement. */
  listActiveFor(nodeId: string): Promise<readonly Operation[]>;
  /** Compare-and-swap on the status. Null when the operation is gone or its status moved. */
  update(id: string, change: OperationUpdate): Promise<Operation | null>;
  lifecycle(nodeId: string): Promise<NodeLifecycle | null>;
  patchLifecycle(nodeId: string, patch: LifecyclePatch): Promise<void>;
}
