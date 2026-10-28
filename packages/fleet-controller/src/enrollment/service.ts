import type { AppDeps } from '../deps';
import type { RegisterInput } from '../store';
import type { ActiveRole, NodeRow, Role } from '../types';

import { signBinding, verifyBinding, type Binding } from './binding';
import {
  hashGrantToken,
  looksLikeGrant,
  newGrantId,
  newGrantToken,
  viewOfGrant,
  type GrantRow,
  type GrantView,
} from './grants';
import type { Redemption } from './store';

export interface IssueRequest {
  readonly role: ActiveRole | null;
  readonly label: string | null;
  readonly ttlSeconds: number;
  /** The controller's own origin, written into the binding. */
  readonly origin: string;
}

export interface Issued {
  readonly grant: GrantView;
  /** The only copy of the token; the controller keeps its hash. */
  readonly binding: Binding;
}

/** Creates a grant and its signed binding. Audited; the token never is. */
export async function issueGrant(
  deps: AppDeps,
  actor: { readonly name: string; readonly role: string },
  request: IssueRequest
): Promise<Issued> {
  const now = deps.now();
  const token = newGrantToken();
  const row = await deps.store.grants.create({
    id: newGrantId(),
    tokenHash: hashGrantToken(token),
    role: request.role,
    label: request.label,
    createdBy: actor.name,
    createdAt: now,
    expiresAt: new Date(now.getTime() + request.ttlSeconds * 1000),
  });
  const binding = signBinding(await deps.store.grants.bindingKey(), {
    origin: request.origin,
    grant: token,
    grantId: row.id,
    issuedAt: now.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
  await deps.store.audit({
    actor: actor.name,
    actorRole: actor.role,
    action: 'enrollment.grant_create',
    targetKind: 'enrollment_grant',
    targetId: row.id,
    detail: {
      role: row.role,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
    },
  });
  return { grant: viewOfGrant(row, now), binding };
}

export async function revokeGrant(
  deps: AppDeps,
  actor: { readonly name: string; readonly role: string },
  id: string
): Promise<GrantView | null> {
  const now = deps.now();
  const result = await deps.store.grants.revoke(id, now);
  if (!result.ok) return null;
  if (result.changed)
    await deps.store.audit({
      actor: actor.name,
      actorRole: actor.role,
      action: 'enrollment.grant_revoke',
      targetKind: 'enrollment_grant',
      targetId: id,
      detail: { wasUsedBy: result.grant.usedByNode },
    });
  return viewOfGrant(result.grant, now);
}

/** How a presented grant changes the registration it came with. */
interface GrantDecision {
  readonly redemption: Redemption;
  readonly approval: 'pending' | 'approved';
  readonly role: Role | null;
}

function decide(redemption: Redemption): GrantDecision {
  const ok =
    redemption.outcome === 'redeemed' || redemption.outcome === 'resumed';
  // Conservative: a grant approves only when the administrator who issued it
  // also chose the role; a role-less grant still waits for a person.
  const role = ok ? redemption.grant.role : null;
  return {
    redemption,
    approval: ok && role !== null ? 'approved' : 'pending',
    role,
  };
}

const shortId = (id: string): string => `node:${id.slice(0, 4)}`;
const labelOf = (node: NodeRow): string => node.displayName ?? node.hostname;

async function bestEffort(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Registration already succeeded; its record must not turn into a failure.
  }
}

interface Trail {
  readonly deps: AppDeps;
  readonly node: NodeRow;
  readonly grant: GrantRow;
}

function audit(
  t: Trail,
  action: string,
  outcome: 'success' | 'denied',
  extra: Record<string, unknown> = {}
): Promise<void> {
  return t.deps.store.audit({
    actor: shortId(t.node.id),
    action,
    targetKind: 'enrollment_grant',
    targetId: t.grant.id,
    outcome,
    detail: {
      grantId: t.grant.id,
      label: t.grant.label,
      node: t.node.id,
      ...extra,
    },
  });
}

async function recordRedeemed(t: Trail): Promise<void> {
  const { node, grant } = t;
  await audit(t, 'enrollment.grant_redeem', 'success', {
    approval: node.approval,
    role: node.role,
  });
  await t.deps.store.addEvent({
    nodeId: node.id,
    nodeLabel: labelOf(node),
    kind: 'enrollment_grant_redeemed',
    severity: 'info',
    message:
      node.approval === 'approved'
        ? `${labelOf(node)} enrolled with a single-use installer grant and was approved with the ${node.role ?? 'unassigned'} role`
        : `${labelOf(node)} enrolled with a single-use installer grant and waits for approval`,
    data: { grantId: grant.id, label: grant.label },
  });
}

/** A cloned installer, or a second machine given the same file: the first node
 * keeps the grant; this one is pending and both pages say so. */
async function recordReused(t: Trail): Promise<void> {
  const { node, grant } = t;
  const bound = grant.usedByNode ?? 'unknown';
  await audit(t, 'enrollment.grant_reused', 'denied', { boundNode: bound });
  const message = `An installer grant already used by ${bound.slice(0, 4)} was presented by ${node.id.slice(0, 4)}. The new machine is pending; check that the installer was not copied.`;
  const data = { grantId: grant.id, boundNode: bound, attemptingNode: node.id };
  const event = (target: NodeRow) =>
    t.deps.store.addEvent({
      nodeId: target.id,
      nodeLabel: labelOf(target),
      kind: 'enrollment_grant_reused',
      severity: 'warn',
      message,
      data,
    });
  await event(node);
  const first = await t.deps.store.findNode(bound);
  if (first !== null) await event(first);
}

async function recordRefused(t: Trail, reason: string): Promise<void> {
  await audit(t, 'enrollment.grant_refused', 'denied', { reason });
  await t.deps.store.addEvent({
    nodeId: t.node.id,
    nodeLabel: labelOf(t.node),
    kind: 'enrollment_grant_refused',
    severity: 'warn',
    message: `${labelOf(t.node)} presented an installer grant that is ${reason}; it waits for a person to approve it`,
    data: { grantId: t.grant.id, reason },
  });
}

async function record(
  deps: AppDeps,
  node: NodeRow,
  { redemption }: GrantDecision
): Promise<void> {
  if (redemption.outcome === 'unknown') return;
  const t = { deps, node, grant: redemption.grant };
  if (redemption.outcome === 'redeemed') return recordRedeemed(t);
  if (redemption.outcome === 'resumed')
    return audit(t, 'enrollment.grant_resume', 'success', {
      approval: node.approval,
    });
  if (redemption.outcome === 'reused') return recordReused(t);
  return recordRefused(t, redemption.outcome);
}

/**
 * Registers a node. A grant token that is presented without a matching static
 * token is redeemed first (the atomic single-use gate), then the node is
 * written; if that write fails the grant is released so the installer is not
 * lost. Anything that is not a valid grant leaves the registration `pending`.
 */
export async function registerWithGrant(
  deps: AppDeps,
  input: RegisterInput,
  grantToken: string
): Promise<{ node: NodeRow; created: boolean }> {
  const redemption = await deps.store.grants.redeem(
    hashGrantToken(grantToken),
    input.id,
    deps.now()
  );
  const decision = decide(redemption);
  let result: { node: NodeRow; created: boolean };
  try {
    result = await deps.store.registerNode({
      ...input,
      approval: decision.approval,
      tokenRole: decision.role,
      enrolledVia:
        decision.approval === 'approved' ? 'enrollment-token' : 'hello',
    });
  } catch (error) {
    if (redemption.outcome === 'redeemed')
      await deps.store.grants.release(redemption.grant.id, input.id);
    throw error;
  }
  await bestEffort(() => record(deps, result.node, decision));
  return result;
}

export type GrantCheck =
  | {
      readonly ok: true;
      readonly grant: GrantView;
      /** `automatic` only when registration would approve without a person. */
      readonly approval: 'automatic' | 'manual';
    }
  | {
      readonly ok: false;
      readonly code:
        | 'enrollment_not_ready'
        | 'enrollment_grant_expired'
        | 'enrollment_grant_revoked'
        | 'enrollment_binding_invalid';
    };

async function bindingFails(
  deps: AppDeps,
  token: string,
  row: GrantRow,
  binding: Binding | null
): Promise<boolean> {
  if (binding === null) return false;
  return (
    binding.grant !== token ||
    binding.grantId !== row.id ||
    !verifyBinding(await deps.store.grants.bindingKey(), binding)
  );
}

/** Read-only: validates a grant (and its binding, when sent) without consuming it. */
export async function checkGrant(
  deps: AppDeps,
  token: string,
  binding: Binding | null
): Promise<GrantCheck> {
  const row = await deps.store.grants.findByHash(hashGrantToken(token));
  if (row === null) return { ok: false, code: 'enrollment_not_ready' };
  if (await bindingFails(deps, token, row, binding))
    return { ok: false, code: 'enrollment_binding_invalid' };
  const now = deps.now();
  const view = viewOfGrant(row, now);
  if (view.state === 'revoked')
    return { ok: false, code: 'enrollment_grant_revoked' };
  if (row.expiresAt.getTime() <= now.getTime())
    return { ok: false, code: 'enrollment_grant_expired' };
  const automatic = view.state === 'pending' && view.role !== null;
  return {
    ok: true,
    grant: view,
    approval: automatic ? 'automatic' : 'manual',
  };
}

/**
 * `store.registerNode`, except that a grant token (and no static token already
 * approving the node) goes through the single-use gate first.
 */
export function registerEnrolled(
  deps: AppDeps,
  enrollmentToken: string | undefined,
  input: RegisterInput
): Promise<{ node: NodeRow; created: boolean }> {
  return input.approval === 'pending' && looksLikeGrant(enrollmentToken)
    ? registerWithGrant(deps, input, enrollmentToken)
    : deps.store.registerNode(input);
}
