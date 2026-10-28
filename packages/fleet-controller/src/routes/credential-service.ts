import type { AppDeps } from '../deps';
import type { CredentialStatus } from '../domain/credential-rotation';
import { confirmationFor, confirmationMatches } from '../domain/operations';
import type { NodeRow } from '../types';

const labelOf = (node: NodeRow) => node.displayName ?? node.hostname;

export type RotationRequested =
  | { readonly ok: true; readonly status: CredentialStatus }
  | { readonly ok: false; readonly reason: 'revoked' | 'unknown_node' };

/** An admin asks the node to rotate its secret. Idempotent; audited; one event when it starts. */
export async function requestRotation(
  deps: AppDeps,
  node: NodeRow,
  actor: string
): Promise<RotationRequested> {
  const result = await deps.store.requestCredentialRotation(node.id);
  await deps.store.audit({
    actor,
    action: 'credential.rotate_request',
    targetKind: 'node',
    targetId: node.id,
    outcome: result.ok ? 'success' : 'failed',
    detail: result.ok ? { changed: result.changed } : { reason: result.reason },
  });
  if (!result.ok) return result;
  if (result.changed)
    await deps.store.addEvent({
      nodeId: node.id,
      nodeLabel: labelOf(node),
      kind: 'credential_rotation_requested',
      severity: 'info',
      message: `${actor} asked ${labelOf(node)} to rotate its credential`,
    });
  return { ok: true, status: result.status };
}

export type Revoked =
  | { readonly ok: true; readonly status: CredentialStatus }
  | { readonly ok: false; readonly reason: 'unknown_node' };

/** Invalidates the node's secret now. Audited; the event is a warning. */
export async function revokeCredential(
  deps: AppDeps,
  node: NodeRow,
  actor: string,
  reason: string | null
): Promise<Revoked> {
  const result = await deps.store.revokeCredential(node.id);
  if (!result.ok) return { ok: false, reason: 'unknown_node' };
  await deps.store.audit({
    actor,
    action: 'credential.revoke',
    targetKind: 'node',
    targetId: node.id,
    detail: { changed: result.changed, reason },
  });
  if (result.changed)
    await deps.store.addEvent({
      nodeId: node.id,
      nodeLabel: labelOf(node),
      kind: 'credential_revoked',
      severity: 'warn',
      message: `${actor} revoked the credential of ${labelOf(node)}${reason === null ? '' : `: ${reason}`}`,
    });
  return { ok: true, status: result.status };
}

/** The refusal body for a revoke that did not type the node's name. */
export function confirmationRequired(node: NodeRow) {
  const expected = confirmationFor(node);
  return {
    error: 'confirmation_required',
    message: `Revoking locks ${expected} out immediately. Send "confirm": "${expected}" (the node's name) to proceed.`,
    expected,
  };
}

/** True when `typed` names the node. Records the refusal as denied otherwise. */
export async function confirmedRevocation(
  deps: AppDeps,
  node: NodeRow,
  actor: string,
  typed: unknown
): Promise<boolean> {
  if (confirmationMatches(typed, node)) return true;
  await deps.store.audit({
    actor,
    action: 'credential.revoke',
    targetKind: 'node',
    targetId: node.id,
    outcome: 'denied',
    detail: { reason: 'confirmation_required' },
  });
  return false;
}
