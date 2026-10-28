import {
  isActive,
  isTerminal,
  pathTo,
  type Operation,
} from '../domain/operations';
import {
  reconcileOperation,
  type Effect,
  type NodeObservation,
  type Step,
} from '../domain/operations-reconcile';
import type { NodeRow } from '../types';

import { auditAction, logFailure, nodeEvent, type OpsDeps } from './context';
import { clearRestartAfter, setCordon } from './intent';
import { observeNode, observeReplacement } from './observe';

const SWEEP_LIMIT = 500;

interface Applied {
  readonly count: number;
  readonly failed: Effect['type'] | null;
  readonly retired: boolean;
}

/** Returns whether it changed desired state; every effect is idempotent. */
async function applyEffect(
  deps: OpsDeps,
  op: Operation,
  effect: Effect,
  node: NodeObservation
): Promise<boolean> {
  const actor = op.requestedBy;
  if (effect.type === 'ensure-cordon') {
    if (node.cordoned || op.nodeId === null) return false;
    return setCordon(deps, op.nodeId, actor);
  }
  if (effect.type === 'retire-node' && op.nodeId !== null) {
    await deps.store.setApproval(op.nodeId, 'retired', actor);
    await auditAction(deps, {
      actor,
      action: 'node.retire',
      targetId: op.nodeId,
      detail: { operationId: op.id, via: 'decommission' },
    });
    return true;
  }
  if (effect.type === 'assign-role') {
    await deps.store.assignRole(effect.nodeId, effect.role, actor);
    await auditAction(deps, {
      actor,
      action: 'node.role',
      targetId: effect.nodeId,
      detail: { operationId: op.id, role: effect.role, via: 'replace' },
    });
    return true;
  }
  return false;
}

async function applyEffects(
  deps: OpsDeps,
  op: Operation,
  step: Step,
  node: NodeObservation
): Promise<Applied> {
  let count = 0;
  let retired = false;
  for (const effect of step.effects) {
    try {
      if (await applyEffect(deps, op, effect, node)) count += 1;
      retired ||= effect.type === 'retire-node';
    } catch (error) {
      logFailure('could not apply an operation effect', op, error);
      return { count, failed: effect.type, retired };
    }
  }
  return { count, failed: null, retired };
}

function unchanged(op: Operation, step: Step, applied: number): boolean {
  return (
    applied === 0 &&
    op.status === step.status &&
    op.progress === step.progress &&
    Object.entries(step.detail).every(
      ([key, value]) => op.detail[key] === value
    )
  );
}

/** What the person is told when the controller could not change desired state. */
function withFailure(step: Step, applied: Applied): Step {
  if (applied.failed === null) {
    return applied.retired
      ? {
          ...step,
          status: 'succeeded',
          progress:
            'Drained and retired: the node’s access is revoked and it no longer receives desired state.',
        }
      : step;
  }
  return {
    ...step,
    status: step.status === 'pending' ? 'pending' : 'in_progress',
    failure: null,
    progress: `${step.progress} The controller could not record its next change (${applied.failed}); it will retry at the next report.`,
  };
}

function label(node: NodeRow | null): string {
  return node === null ? 'a node' : (node.displayName ?? node.hostname);
}

/** The event and the audit entry for an operation that just reached a terminal state. */
async function announceEnd(
  deps: OpsDeps,
  op: Operation,
  node: NodeRow | null
): Promise<void> {
  const failed = op.status === 'failed';
  const text = (failed ? op.failure : op.progress) ?? '';
  if (node !== null)
    await nodeEvent(deps, node, {
      kind: `operation_${op.status}`,
      severity: failed ? 'error' : 'info',
      message:
        `${op.kind} of ${label(node)} ${op.status.replace('_', ' ')}: ${text}`.trim(),
      data: { operationId: op.id, kind: op.kind },
    });
  await auditAction(deps, {
    actor: 'controller',
    action: `operation.${op.kind}.${op.status}`,
    targetId: op.nodeId,
    outcome: failed ? 'failed' : 'success',
    detail: { operationId: op.id, requestedBy: op.requestedBy },
  });
}

/** Lifecycle facts and clean-up once an operation ended. A restart that did not happen must not happen later. */
async function settleEnd(deps: OpsDeps, op: Operation): Promise<void> {
  if (op.kind !== 'restart' || op.nodeId === null) return;
  if (op.status === 'succeeded')
    await deps.store.operations.patchLifecycle(op.nodeId, {
      restartCompletedAt: deps.now(),
    });
  else await clearRestartAfter(deps, op.nodeId, op.requestedBy);
}

interface Outcome {
  readonly step: Step;
  readonly applied: number;
  readonly node: NodeRow | null;
}

/** Writes each table hop in turn; the last one carries the progress, failure and detail. */
async function walk(
  deps: OpsDeps,
  op: Operation,
  outcome: Outcome
): Promise<Operation | null> {
  const { step } = outcome;
  const hops = pathTo(op.kind, op.status, step.status) ?? [];
  const targets = hops.length === 0 ? [op.status] : hops;
  let current = op;
  for (const [index, status] of targets.entries()) {
    const last = index === targets.length - 1;
    const next = await deps.store.operations.update(op.id, {
      expect: current.status,
      status,
      updatedAt: deps.now(),
      progress: last ? step.progress : 'Started.',
      ...(last && status === 'failed' ? { failure: step.failure } : {}),
      detail: last ? step.detail : {},
      countAttempt: last && outcome.applied > 0,
    });
    if (next === null) return null;
    current = next;
  }
  return current;
}

async function persist(
  deps: OpsDeps,
  op: Operation,
  outcome: Outcome
): Promise<Operation> {
  const current = await walk(deps, op, outcome);
  if (current === null) return (await deps.store.operations.get(op.id)) ?? op;
  const { node, step } = outcome;
  if (isTerminal(current.status)) {
    await announceEnd(deps, current, node);
    await settleEnd(deps, current);
  } else if (op.status !== current.status && node !== null)
    await nodeEvent(deps, node, {
      kind: 'operation_started',
      severity: 'info',
      message: `${op.kind} of ${label(node)} is in progress: ${step.progress}`,
      data: { operationId: op.id, kind: op.kind },
    });
  return current;
}

/** One reconcile pass. Idempotent: an unchanged observation writes nothing. */
export async function reconcileOne(
  deps: OpsDeps,
  op: Operation
): Promise<Operation> {
  if (!isActive(op.status) || op.nodeId === null) return op;
  const { node, observation } = await observeNode(deps, op.nodeId);
  const replacement =
    op.kind === 'replace'
      ? await observeReplacement(deps, op.detail['replacement'])
      : null;
  const planned = reconcileOperation({
    op,
    node: observation,
    replacement,
    now: deps.now(),
  });
  const applied = await applyEffects(deps, op, planned, observation);
  const step = withFailure(planned, applied);
  if (unchanged(op, step, applied.count)) return op;
  return persist(deps, op, { step, applied: applied.count, node });
}

/** Reconciles every active operation that concerns this node. Never throws. */
export async function reconcileForNode(
  deps: OpsDeps,
  nodeId: string
): Promise<boolean> {
  let touched = false;
  for (const op of await deps.store.operations.listActiveFor(nodeId)) {
    try {
      const next = await reconcileOne(deps, op);
      touched ||= next !== op;
    } catch (error) {
      logFailure('operation reconcile failed', op, error);
    }
  }
  return touched;
}

/**
 * Reconciles every active operation, so one whose node has gone silent still
 * times out. Run by the scheduler; safe to call at any time.
 */
export async function sweepOperations(deps: OpsDeps): Promise<number> {
  const active = await deps.store.operations.list({
    activeOnly: true,
    limit: SWEEP_LIMIT,
  });
  let changed = 0;
  for (const op of active) {
    try {
      if ((await reconcileOne(deps, op)) !== op) changed += 1;
    } catch (error) {
      logFailure('operation sweep failed', op, error);
    }
  }
  return changed;
}

/**
 * The heartbeat hook. Runs before the desired document is computed, so
 * intent the controller records now reaches the node in this very response.
 * A failure here never fails a heartbeat. Returns the node as it is now.
 */
export async function settleOperations(
  deps: OpsDeps,
  node: NodeRow
): Promise<NodeRow> {
  try {
    if (!(await reconcileForNode(deps, node.id))) return node;
    return (await deps.store.findNode(node.id)) ?? node;
  } catch (error) {
    logFailure('operation settle failed', { id: '-', kind: 'drain' }, error);
    return node;
  }
}
