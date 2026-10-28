import { effectiveConfig } from '../domain/effective-config';
import type { Operation } from '../domain/operations';

import { auditAction, nodeEvent, type OpsDeps } from './context';
import { clearCordon, clearRestartAfter } from './intent';
import { settingsFor } from './observe';

export type CancelOutcome =
  | { readonly ok: true; readonly operation: Operation }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code: 'not_found' | 'already_finished';
      readonly message: string;
    };

/** Returns the node to where it was: the cordon or the restart request is removed. */
async function withdrawIntent(
  deps: OpsDeps,
  op: Operation,
  actor: string
): Promise<void> {
  if (op.nodeId === null) return;
  if (op.kind === 'restart') await clearRestartAfter(deps, op.nodeId, actor);
  else await clearCordon(deps, op.nodeId, actor);
  if (op.kind !== 'restart')
    await deps.store.operations.patchLifecycle(op.nodeId, {
      drainRequestedAt: null,
      drainReason: null,
    });
}

export async function cancelOperation(
  deps: OpsDeps,
  id: string,
  actor: string
): Promise<CancelOutcome> {
  const op = await deps.store.operations.get(id);
  if (op === null)
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      message: 'No such operation.',
    };
  if (
    op.status === 'succeeded' ||
    op.status === 'failed' ||
    op.status === 'cancelled'
  )
    return {
      ok: false,
      status: 409,
      code: 'already_finished',
      message: `The operation already ${op.status === 'succeeded' ? 'succeeded' : op.status}; it cannot be cancelled.`,
    };
  const next = await deps.store.operations.update(op.id, {
    expect: op.status,
    status: 'cancelled',
    updatedAt: deps.now(),
    progress: `Cancelled by ${actor}. The node is returned to its previous settings.`,
  });
  if (next === null)
    return {
      ok: false,
      status: 409,
      code: 'already_finished',
      message:
        'The operation changed while you cancelled it; reload and look again.',
    };
  await withdrawIntent(deps, next, actor);
  await auditAction(deps, {
    actor,
    action: 'operation.cancel',
    targetId: next.nodeId,
    detail: { operationId: next.id, kind: next.kind },
  });
  return { ok: true, operation: next };
}

export type UndrainOutcome =
  | {
      readonly ok: true;
      readonly cancelled: readonly string[];
      readonly stillCordoned: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code: string;
      readonly message: string;
    };

/** Lifts the node-scope cordon and cancels its active drain operation. */
export async function undrainNode(
  deps: OpsDeps,
  nodeId: string,
  actor: string
): Promise<UndrainOutcome> {
  const node = await deps.store.findNode(nodeId);
  if (node === null)
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      message: 'No such node.',
    };
  const active = await deps.store.operations.list({
    nodeId,
    activeOnly: true,
    limit: 50,
  });
  const holding = active.find(
    (op) => op.kind === 'decommission' || op.kind === 'replace'
  );
  if (holding !== undefined) {
    await auditAction(deps, {
      actor,
      action: 'node.undrain',
      targetId: nodeId,
      outcome: 'denied',
      detail: { code: 'operation_in_progress', operationId: holding.id },
    });
    return {
      ok: false,
      status: 409,
      code: 'operation_in_progress',
      message: `A ${holding.kind} (operation ${holding.id}) holds this node drained. Cancel it first.`,
    };
  }
  const cancelled: string[] = [];
  for (const op of active.filter((candidate) => candidate.kind === 'drain')) {
    const done = await deps.store.operations.update(op.id, {
      expect: op.status,
      status: 'cancelled',
      updatedAt: deps.now(),
      progress: `Undrained by ${actor}.`,
    });
    if (done !== null) cancelled.push(done.id);
  }
  await clearCordon(deps, nodeId, actor);
  await deps.store.operations.patchLifecycle(nodeId, {
    drainRequestedAt: null,
    drainReason: null,
  });
  const config = effectiveConfig(await settingsFor(deps, node), node);
  const stillCordoned = config.runners?.cordoned === true;
  await auditAction(deps, {
    actor,
    action: 'node.undrain',
    targetId: nodeId,
    detail: { cancelled, stillCordoned },
  });
  await nodeEvent(deps, node, {
    kind: 'node_undrained',
    severity: 'info',
    message: `${actor} undrained ${node.displayName ?? node.hostname}`,
    data: { cancelled },
  });
  return { ok: true, cancelled, stillCordoned };
}
