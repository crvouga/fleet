import { randomUUID } from 'node:crypto';

import {
  effectiveConfig,
  offlineAfterSeconds,
} from '../domain/effective-config';
import {
  EXCLUDES,
  planRequest,
  type Operation,
  type OperationKind,
  type Refusal,
} from '../domain/operations';
import { statusOf } from '../domain/status';
import type { NodeRow } from '../types';
import { readFacts } from '../ui/lib/facts';

import { auditAction, nodeEvent, type OpsDeps } from './context';
import { setCordon, setRestartAfter } from './intent';
import { settingsFor } from './observe';

export interface OperationRequest {
  readonly kind: OperationKind;
  readonly nodeId: string;
  readonly actor: string;
  readonly force?: boolean;
  readonly replacement?: string;
  readonly reason?: string;
  readonly timeoutSeconds?: number;
  readonly idempotencyKey?: string;
}

export type RequestOutcome =
  | {
      readonly ok: true;
      readonly operation: Operation;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 500;
      readonly code:
        Refusal | 'not_found' | 'idempotency_conflict' | 'internal';
      readonly message: string;
      readonly operationId?: string;
    };

const refused = (
  status: 404 | 409 | 500,
  code: Extract<RequestOutcome, { ok: false }>['code'],
  message: string,
  operationId?: string
): RequestOutcome => ({
  ok: false,
  status,
  code,
  message,
  ...(operationId === undefined ? {} : { operationId }),
});

async function planFor(
  deps: OpsDeps,
  node: NodeRow,
  req: OperationRequest
): Promise<ReturnType<typeof planRequest>> {
  const config = effectiveConfig(await settingsFor(deps, node), node);
  const [active, replaces] = await Promise.all([
    deps.store.operations.list({
      nodeId: node.id,
      activeOnly: true,
      limit: 50,
    }),
    deps.store.operations.list({
      kind: 'replace',
      activeOnly: true,
      limit: 200,
    }),
  ]);
  const candidate =
    req.replacement === undefined
      ? undefined
      : await deps.store.findNode(req.replacement);
  return planRequest({
    kind: req.kind,
    node: {
      id: node.id,
      approval: node.approval,
      status: statusOf(node, deps.now(), offlineAfterSeconds(config)),
      role: node.role,
      rebootEnabled: config.reboot?.enabled !== false,
    },
    active,
    force: req.force === true,
    ...(req.replacement === undefined
      ? {}
      : {
          replacement:
            candidate === null || candidate === undefined
              ? null
              : {
                  id: candidate.id,
                  approval: candidate.approval,
                  role: candidate.role,
                },
        }),
    replacementsInUse: replaces
      .map((op) => op.detail['replacement'])
      .filter((id): id is string => typeof id === 'string'),
  });
}

function detailOf(
  req: OperationRequest,
  node: NodeRow,
  now: Date
): Record<string, unknown> {
  const facts = readFacts(node);
  return {
    ...(req.reason === undefined ? {} : { reason: req.reason }),
    ...(req.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: req.timeoutSeconds }),
    ...(req.kind === 'restart'
      ? {
          bootIdAtRequest: facts.bootId,
          restartAfter: Math.floor(now.getTime() / 1000),
        }
      : {}),
    ...(req.kind === 'decommission' ? { force: req.force === true } : {}),
    ...(req.kind === 'replace'
      ? { replacement: req.replacement ?? null, role: node.role }
      : {}),
  };
}

/** Records the intent as desired state and lifecycle facts. Throws when it cannot. */
async function recordIntent(
  deps: OpsDeps,
  op: Operation,
  node: NodeRow,
  immediate: boolean
): Promise<void> {
  const now = deps.now();
  const lifecycle = deps.store.operations;
  if (op.kind === 'drain') {
    await setCordon(deps, node.id, op.requestedBy);
    await lifecycle.patchLifecycle(node.id, {
      drainRequestedAt: now,
      drainReason:
        typeof op.detail['reason'] === 'string' ? op.detail['reason'] : null,
    });
  } else if (op.kind === 'restart') {
    await setRestartAfter(
      deps,
      node.id,
      op.requestedBy,
      Number(op.detail['restartAfter'])
    );
    await lifecycle.patchLifecycle(node.id, {
      restartRequestedAt: now,
      restartCompletedAt: null,
    });
  } else if (op.kind === 'replace') {
    await setCordon(deps, node.id, op.requestedBy);
    await lifecycle.patchLifecycle(node.id, {
      replacedBy: String(op.detail['replacement']),
      drainRequestedAt: now,
    });
  } else {
    if (!immediate) await setCordon(deps, node.id, op.requestedBy);
    await lifecycle.patchLifecycle(node.id, { decommissionRequestedAt: now });
  }
}

async function fail(
  deps: OpsDeps,
  op: Operation,
  message: string
): Promise<Operation> {
  return (
    (await deps.store.operations.update(op.id, {
      expect: op.status,
      status: 'failed',
      updatedAt: deps.now(),
      progress: 'Could not record the request.',
      failure: message,
    })) ?? op
  );
}

const STARTED: Readonly<Record<OperationKind, string>> = {
  drain:
    'Drain requested: the node is cordoned and finishes its running jobs without taking new ones.',
  restart:
    'Restart requested: the node drains, waits until it is idle and reboots once.',
  replace:
    'Replace requested: the node is cordoned while the replacement is approved and converges.',
  decommission:
    'Decommission requested: the node drains first, then it is retired.',
};

/** Retire the node now (forced decommission of an unreachable node). */
async function retireNow(deps: OpsDeps, op: Operation): Promise<Operation> {
  await deps.store.setApproval(op.nodeId ?? '', 'retired', op.requestedBy);
  await auditAction(deps, {
    actor: op.requestedBy,
    action: 'node.retire',
    targetId: op.nodeId,
    detail: { operationId: op.id, via: 'decommission', force: true },
  });
  return (
    (await deps.store.operations.update(op.id, {
      expect: 'pending',
      status: 'succeeded',
      updatedAt: deps.now(),
      progress:
        'Retired without a drain because the node is unreachable (force). Its access is revoked.',
    })) ?? op
  );
}

async function afterCreate(
  deps: OpsDeps,
  op: Operation,
  node: NodeRow,
  immediate: boolean
): Promise<Operation> {
  try {
    await recordIntent(deps, op, node, immediate);
    return immediate ? await retireNow(deps, op) : op;
  } catch {
    return fail(
      deps,
      op,
      'The controller could not record the request in the node settings. Nothing was changed on the node. Try again.'
    );
  }
}

const KEY_REUSED = 'That idempotency key was used for a different request.';

/** A stored operation for the same idempotency key is the answer, whatever has happened since. */
async function replayFor(
  deps: OpsDeps,
  req: OperationRequest
): Promise<RequestOutcome | null> {
  if (req.idempotencyKey === undefined) return null;
  const known = await deps.store.operations.findByKey(req.idempotencyKey);
  if (known === null) return null;
  return known.kind === req.kind && known.nodeId === req.nodeId
    ? { ok: true, operation: known, replayed: true }
    : refused(409, 'idempotency_conflict', KEY_REUSED);
}

function audit(
  deps: OpsDeps,
  req: OperationRequest,
  outcome: 'success' | 'denied' | 'failed',
  detail: Record<string, unknown>
): Promise<void> {
  return auditAction(deps, {
    actor: req.actor,
    action: `node.${req.kind}`,
    targetId: req.nodeId,
    outcome,
    detail: {
      ...detail,
      ...(req.force === true ? { force: true } : {}),
      ...(req.replacement === undefined
        ? {}
        : { replacement: req.replacement }),
    },
  });
}

/** Records the intent, then the audit entry and event for the person's action. */
async function settle(
  deps: OpsDeps,
  req: OperationRequest,
  node: NodeRow,
  created: Operation
): Promise<RequestOutcome> {
  const immediate = req.kind === 'decommission' && req.force === true;
  const operation = await afterCreate(deps, created, node, immediate);
  if (operation.status === 'failed') {
    await audit(deps, req, 'failed', { operationId: operation.id });
    return refused(
      500,
      'internal',
      operation.failure ?? 'The request failed.',
      operation.id
    );
  }
  await audit(deps, req, 'success', { operationId: operation.id });
  await nodeEvent(deps, node, {
    kind: 'operation_requested',
    severity: 'info',
    message: `${req.actor} requested ${req.kind} of ${node.displayName ?? node.hostname}`,
    data: { operationId: operation.id, kind: req.kind },
  });
  return { ok: true, operation, replayed: false };
}

async function store(
  deps: OpsDeps,
  req: OperationRequest,
  node: NodeRow
): Promise<RequestOutcome> {
  const now = deps.now();
  const created = await deps.store.operations.create(
    {
      id: randomUUID(),
      kind: req.kind,
      nodeId: node.id,
      requestedBy: req.actor,
      requestedAt: now,
      progress: STARTED[req.kind],
      idempotencyKey: req.idempotencyKey ?? null,
      detail: detailOf(req, node, now),
    },
    EXCLUDES[req.kind]
  );
  if (created.outcome === 'replayed')
    return { ok: true, operation: created.operation, replayed: true };
  if (created.outcome === 'key_conflict')
    return refused(409, 'idempotency_conflict', KEY_REUSED);
  if (created.outcome === 'conflict') {
    await audit(deps, req, 'denied', { code: 'operation_in_progress' });
    return refused(
      409,
      'operation_in_progress',
      `Another operation is already active for this node (${created.operation.id}).`,
      created.operation.id
    );
  }
  return settle(deps, req, node, created.operation);
}

/**
 * Starts an operation. Order matters: validate the invariants, store the
 * operation (atomic with the exclusivity check and the idempotency key), then
 * record the intent as desired state. Completion is decided at heartbeats.
 */
export async function requestOperation(
  deps: OpsDeps,
  req: OperationRequest
): Promise<RequestOutcome> {
  const replay = await replayFor(deps, req);
  if (replay !== null) return replay;
  const node = await deps.store.findNode(req.nodeId);
  if (node === null) return refused(404, 'not_found', 'No such node.');
  const plan = await planFor(deps, node, req);
  if (plan.ok) return store(deps, req, node);
  await audit(deps, req, 'denied', { code: plan.code });
  return refused(409, plan.code, plan.message, plan.conflictId);
}
