/**
 * Node operations: drain, restart, replace and decommission.
 *
 * The controller never pushes a command to a node ("data, never code"). An
 * operation is the controller's RECORD of an intent it expressed as desired
 * state (a cordon, `maintenance.restartAfter`, a retired approval) and of the
 * progress it can PROVE from what the node reports. Everything here is pure:
 * state machines, invariants and request validation. See docs/operations.md.
 */
import type { Approval, NodeStatus, Role } from '../types';

export const OPERATION_KINDS = [
  'drain',
  'restart',
  'replace',
  'decommission',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = [
  'pending',
  'in_progress',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly OperationStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isOperationKind(value: unknown): value is OperationKind {
  return (
    typeof value === 'string' &&
    (OPERATION_KINDS as readonly string[]).includes(value)
  );
}

export function isOperationStatus(value: unknown): value is OperationStatus {
  return (
    typeof value === 'string' &&
    (OPERATION_STATUSES as readonly string[]).includes(value)
  );
}

export const isTerminal = (status: OperationStatus): boolean =>
  TERMINAL_STATUSES.includes(status);
export const isActive = (status: OperationStatus): boolean =>
  !isTerminal(status);

/** One row of `operations`. `detail` holds the kind-specific facts (stage, force, replacement…). */
export interface Operation {
  readonly id: string;
  readonly kind: OperationKind;
  readonly nodeId: string | null;
  readonly status: OperationStatus;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  /** How many reconcile passes looked at it while active. */
  readonly attempts: number;
  /** One public sentence: what is happening now. */
  readonly progress: string | null;
  /** One public sentence with the next step, set on `failed`. */
  readonly failure: string | null;
  readonly idempotencyKey: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

type Table = Readonly<Record<OperationStatus, readonly OperationStatus[]>>;

const COMMON: Table = {
  pending: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * The transition table per kind. Terminal states are final. A forced
 * decommission of an unreachable node is the only way to skip `in_progress`:
 * there is nothing to wait for.
 */
export const TRANSITIONS: Readonly<Record<OperationKind, Table>> = {
  drain: COMMON,
  restart: COMMON,
  replace: COMMON,
  decommission: {
    ...COMMON,
    pending: ['in_progress', 'succeeded', 'failed', 'cancelled'],
  },
};

export function canTransition(
  kind: OperationKind,
  from: OperationStatus,
  to: OperationStatus
): boolean {
  return TRANSITIONS[kind][from].includes(to);
}

/**
 * The hops from one status to another through the kind's table (breadth
 * first), e.g. `pending` to `succeeded` is `in_progress`, `succeeded`. Empty
 * when `from` equals `to`; null when the table has no path. Persisting hop by
 * hop is how a step that jumps ahead still obeys the table.
 */
export function pathTo(
  kind: OperationKind,
  from: OperationStatus,
  to: OperationStatus
): OperationStatus[] | null {
  if (from === to) return [];
  const queue: OperationStatus[][] = [[from]];
  const seen = new Set<OperationStatus>([from]);
  for (const path of queue) {
    for (const next of TRANSITIONS[kind][path[path.length - 1]!]) {
      if (seen.has(next)) continue;
      const extended = [...path, next];
      if (next === to) return extended.slice(1);
      seen.add(next);
      queue.push(extended);
    }
  }
  return null;
}

/** The stages a kind moves through while `in_progress`, in order (`detail.stage`). */
export const STAGES: Readonly<Record<OperationKind, readonly string[]>> = {
  drain: ['draining'],
  restart: ['awaiting-ack', 'draining', 'rebooting'],
  replace: ['awaiting-approval', 'converging'],
  decommission: ['draining', 'retiring'],
};

/** How long an operation may stay active before it fails with an actionable message. */
export const DEFAULT_TIMEOUT_SECONDS: Readonly<Record<OperationKind, number>> =
  {
    drain: 6 * 3600,
    restart: 3 * 3600,
    decommission: 6 * 3600,
    replace: 14 * 86400,
  };
export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 30 * 86400;

export function timeoutSecondsOf(op: Operation): number {
  const custom = op.detail['timeoutSeconds'];
  return typeof custom === 'number' &&
    Number.isInteger(custom) &&
    custom >= MIN_TIMEOUT_SECONDS &&
    custom <= MAX_TIMEOUT_SECONDS
    ? custom
    : DEFAULT_TIMEOUT_SECONDS[op.kind];
}

/** What request validation needs to know about the target node. */
export interface RequestNode {
  readonly id: string;
  readonly approval: Approval;
  readonly status: NodeStatus;
  readonly role: Role | null;
  /** Effective `reboot.enabled` for the node (defaults to true). */
  readonly rebootEnabled: boolean;
}

export interface ReplacementCandidate {
  readonly id: string;
  readonly approval: Approval;
  readonly role: Role | null;
}

export interface RequestContext {
  readonly kind: OperationKind;
  readonly node: RequestNode;
  /** Active operations on this node, every kind. */
  readonly active: readonly Operation[];
  readonly force: boolean;
  /** `undefined`: none named. `null`: named but not found. */
  readonly replacement?: ReplacementCandidate | null;
  /** Active replace operations that already use a replacement (any node). */
  readonly replacementsInUse?: readonly string[];
}

export type Refusal =
  | 'not_approved'
  | 'operation_in_progress'
  | 'reboots_disabled'
  | 'drain_unprovable'
  | 'force_requires_unreachable'
  | 'no_role'
  | 'invalid_replacement';

export type Plan =
  | {
      readonly ok: true;
      /** The request needs no waiting: it is `succeeded` at once (forced decommission). */
      readonly immediate: boolean;
    }
  | {
      readonly ok: false;
      readonly code: Refusal;
      readonly message: string;
      /** The conflicting active operation, when that is the reason. */
      readonly conflictId?: string;
    };

const PARTICIPLE: Readonly<Record<OperationKind, string>> = {
  drain: 'drained',
  restart: 'restarted',
  replace: 'replaced',
  decommission: 'decommissioned',
};

const refuse = (code: Refusal, message: string, conflictId?: string): Plan => ({
  ok: false,
  code,
  message,
  ...(conflictId === undefined ? {} : { conflictId }),
});

/** Kinds that exclude each other on one node: invariant "one lifecycle change at a time". */
export const EXCLUDES: Readonly<
  Record<OperationKind, readonly OperationKind[]>
> = {
  drain: ['drain', 'decommission'],
  restart: ['restart', 'decommission'],
  replace: ['replace', 'decommission'],
  decommission: ['decommission', 'restart', 'replace'],
};

function conflict(ctx: RequestContext): Plan | null {
  const other = ctx.active.find((op) => EXCLUDES[ctx.kind].includes(op.kind));
  if (other === undefined) return null;
  const same = other.kind === ctx.kind;
  return refuse(
    'operation_in_progress',
    same
      ? `A ${ctx.kind} is already ${other.status.replace('_', ' ')} for this node (operation ${other.id}). Wait for it, or cancel it first.`
      : `A ${other.kind} is ${other.status.replace('_', ' ')} for this node (operation ${other.id}); a ${ctx.kind} cannot run alongside it. Wait for it, or cancel it first.`,
    other.id
  );
}

function replacementProblem(ctx: RequestContext): string | null {
  const { replacement, node } = ctx;
  if (replacement === undefined || replacement === null)
    return 'Name the replacement machine: it must have registered with this controller (pending or approved).';
  if (replacement.id === node.id)
    return 'A node cannot replace itself. Install the new machine and name it.';
  if (replacement.approval !== 'pending' && replacement.approval !== 'approved')
    return `The replacement is ${replacement.approval}. Only a registered machine that is pending or approved can replace a node.`;
  return null;
}

function replacementConflict(ctx: RequestContext): string | null {
  const replacement = ctx.replacement as ReplacementCandidate;
  if (replacement.role !== null && replacement.role !== ctx.node.role)
    return `The replacement already has the ${replacement.role} role; it must have none or ${ctx.node.role ?? 'the same role'}.`;
  if (ctx.replacementsInUse?.includes(replacement.id))
    return 'The replacement is already used by another active replace operation.';
  return null;
}

function replacementRefusal(ctx: RequestContext): Plan | null {
  const problem = replacementProblem(ctx) ?? replacementConflict(ctx);
  return problem === null ? null : refuse('invalid_replacement', problem);
}

function kindRefusal(ctx: RequestContext): Plan | null {
  const { kind, node } = ctx;
  if (kind === 'restart' && !node.rebootEnabled)
    return refuse(
      'reboots_disabled',
      'reboot.enabled is off for this node, so it would never restart itself. Turn it on in the node settings, or reboot the machine by hand.'
    );
  if (kind === 'replace' && node.role === null)
    return refuse(
      'no_role',
      'This node has no assigned role, so there is nothing for a replacement to take over. Retire it instead.'
    );
  if (kind === 'replace') return replacementRefusal(ctx);
  return null;
}

function decommissionPlan(ctx: RequestContext): Plan {
  const unreachable = ctx.node.status === 'offline';
  if (ctx.force && !unreachable)
    return refuse(
      'force_requires_unreachable',
      `force is only for a node that has stopped reporting; this one is ${ctx.node.status}. Decommission it without force and it drains first.`
    );
  if (!ctx.force && unreachable)
    return refuse(
      'drain_unprovable',
      'This node is offline, so its drain cannot be confirmed. Bring it back, or repeat the request with force after you have checked that the machine is powered off or isolated.'
    );
  return { ok: true, immediate: ctx.force };
}

/**
 * Invariants for a new operation, in the order a person should fix them:
 * only approved nodes; one active operation per node and kind, and no
 * lifecycle change beside a decommission; reboots must be allowed; a
 * decommission drains first unless the node is unreachable AND `force` is set.
 */
export function planRequest(ctx: RequestContext): Plan {
  if (ctx.node.approval !== 'approved')
    return refuse(
      'not_approved',
      `This node is ${ctx.node.approval}; only approved nodes can be ${PARTICIPLE[ctx.kind]}.`
    );
  const busy = conflict(ctx);
  if (busy !== null) return busy;
  const refused = kindRefusal(ctx);
  if (refused !== null) return refused;
  return ctx.kind === 'decommission'
    ? decommissionPlan(ctx)
    : { ok: true, immediate: false };
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,120}$/;

/** The text a person must type to confirm a destructive action on this node. */
export function confirmationFor(node: {
  readonly hostname: string;
  readonly displayName: string | null;
}): string {
  return node.displayName ?? node.hostname;
}

/** True when `typed` names the node: its label (display name or hostname) or its hostname. */
export function confirmationMatches(
  typed: unknown,
  node: { readonly hostname: string; readonly displayName: string | null }
): boolean {
  if (typeof typed !== 'string') return false;
  const value = typed.trim();
  return (
    value.length > 0 &&
    (value === node.hostname || value === confirmationFor(node))
  );
}
