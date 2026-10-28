/**
 * Level-triggered reconciliation of one operation against what the nodes
 * report. Pure: the same operation and observation always give the same step,
 * so running it at every heartbeat (or twice, or after a crash) is safe.
 * Completion is PROVEN by observed state, never assumed from the request.
 */
import type { Approval, Role } from '../types';

import {
  timeoutSecondsOf,
  type Operation,
  type OperationStatus,
} from './operations';

/** Clocks on nodes are only roughly right; boot times are compared with this slack. */
export const CLOCK_SKEW_SECONDS = 120;

export interface NodeObservation {
  readonly exists: boolean;
  readonly approval: Approval;
  readonly role: Role | null;
  readonly lastSeenAt: Date | null;
  readonly bootId: string | null;
  readonly uptimeSeconds: number | null;
  /** Busy runner slots; null when the node reports no runners. */
  readonly busySlots: number | null;
  /** Whether the node says runner admission is closed; null when it does not say. */
  readonly gateClosed: boolean | null;
  readonly appliedRevision: string | null;
  readonly desiredRevision: string;
  /** Effective `runners.cordoned` in the desired document. */
  readonly cordoned: boolean;
  /** Effective `reboot.enabled` (default true). */
  readonly rebootEnabled: boolean;
  readonly converged: boolean;
  readonly reconcileIssue: string | null;
}

export interface ReplacementObservation {
  readonly exists: boolean;
  readonly approval: Approval;
  readonly role: Role | null;
  readonly converged: boolean;
  readonly lastSeenAt: Date | null;
  readonly reconcileIssue: string | null;
}

/** Idempotent changes of DESIRED state the reconciler asks for. */
export type Effect =
  | { readonly type: 'ensure-cordon' }
  | { readonly type: 'retire-node' }
  | {
      readonly type: 'assign-role';
      readonly nodeId: string;
      readonly role: Role;
    };

export interface Step {
  readonly status: OperationStatus;
  readonly progress: string;
  readonly failure: string | null;
  /** Merged into `detail`. */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly effects: readonly Effect[];
}

export interface ReconcileInput {
  readonly op: Operation;
  readonly node: NodeObservation;
  readonly replacement: ReplacementObservation | null;
  readonly now: Date;
}

const hours = (seconds: number): string =>
  seconds >= 86400
    ? `${Math.round(seconds / 86400)} d`
    : seconds >= 3600
      ? `${Math.round((seconds / 3600) * 10) / 10} h`
      : `${Math.round(seconds / 60)} min`;

const stage = (name: string): Record<string, unknown> => ({ stage: name });

function reported(op: Operation, node: NodeObservation): boolean {
  return node.lastSeenAt !== null && node.lastSeenAt >= op.requestedAt;
}

/** The node reported after the request and its applied revision is the one that holds the intent. */
function acknowledged(op: Operation, node: NodeObservation): boolean {
  return (
    reported(op, node) &&
    node.appliedRevision !== null &&
    node.appliedRevision === node.desiredRevision
  );
}

function waitingFor(op: Operation, node: NodeObservation): string {
  return reported(op, node)
    ? `Waiting for the node to apply the request (it runs desired revision ${node.appliedRevision ?? 'none'}, wants ${node.desiredRevision}).`
    : 'Waiting for the node to report. It picks the request up at its next heartbeat.';
}

type Drain =
  | { readonly state: 'drained' }
  | { readonly state: 'waiting'; readonly progress: string };

/** Is the node drained? Needs the ack, an idle runner set and a closed admission gate. */
function drainState(op: Operation, node: NodeObservation): Drain {
  if (!node.cordoned)
    return {
      state: 'waiting',
      progress:
        'Re-applying the cordon that was removed from the node settings.',
    };
  if (!acknowledged(op, node))
    return { state: 'waiting', progress: waitingFor(op, node) };
  if (node.busySlots !== null && node.busySlots > 0)
    return {
      state: 'waiting',
      progress: `Draining: ${node.busySlots} runner slot${node.busySlots === 1 ? ' is' : 's are'} still busy. No new jobs are admitted.`,
    };
  if (node.busySlots !== null && node.gateClosed === false)
    return {
      state: 'waiting',
      progress:
        'No job is running, but the node has not closed runner admission yet.',
    };
  return { state: 'drained' };
}

function timeoutFailure(op: Operation, node: NodeObservation): string {
  const limit = hours(timeoutSecondsOf(op));
  const seen =
    node.lastSeenAt === null
      ? 'it has never reported'
      : `it last reported at ${node.lastSeenAt.toISOString()}`;
  const next = {
    drain: `A job may be stuck: check the busy runner slots on the node page, then cancel this drain, or wait and ask again.`,
    restart: `Check power and network, and that automatic reboots are enabled; the request can be repeated.`,
    decommission: `If the machine is unreachable and you have checked that it is off or isolated, decommission it again with force; otherwise wait for its jobs, or cancel this operation.`,
    replace: `Install the replacement machine, approve it, and check its readiness issues; then ask again.`,
  }[op.kind];
  return `The ${op.kind} did not finish within ${limit} (${seen}). ${next}`;
}

function done(
  status: OperationStatus,
  progress: string,
  extra: Partial<Step> = {}
): Step {
  return {
    status,
    progress,
    failure: null,
    detail: {},
    effects: [],
    ...extra,
  };
}

const cordon = [{ type: 'ensure-cordon' }] as const;

function stepDrain(input: ReconcileInput): Step {
  const { op, node } = input;
  const drain = drainState(op, node);
  if (drain.state === 'drained')
    return done(
      'succeeded',
      'Drained: runner admission is closed and no job is running. The node stays cordoned until you undrain it.',
      { detail: stage('draining') }
    );
  return done(
    acknowledged(op, node) ? 'in_progress' : 'pending',
    drain.progress,
    {
      detail: stage('draining'),
      effects: cordon,
    }
  );
}

function rebooted(op: Operation, node: NodeObservation): boolean {
  if (!reported(op, node) || node.bootId === null) return false;
  const before = op.detail['bootIdAtRequest'];
  const bootStart =
    node.lastSeenAt !== null && node.uptimeSeconds !== null
      ? node.lastSeenAt.getTime() / 1000 - node.uptimeSeconds
      : null;
  const startedAfter =
    bootStart === null
      ? null
      : bootStart >= op.requestedAt.getTime() / 1000 - CLOCK_SKEW_SECONDS;
  if (typeof before === 'string')
    return node.bootId !== before && startedAfter !== false;
  return startedAfter === true;
}

function stepRestart(input: ReconcileInput): Step {
  const { op, node } = input;
  if (rebooted(op, node))
    return done('succeeded', 'Restarted: the node reports a new boot.', {
      detail: stage('rebooting'),
    });
  if (!node.rebootEnabled)
    return done(
      'failed',
      'reboot.enabled was turned off, so the node will not restart itself.',
      {
        failure:
          'reboot.enabled is off for this node, so it will not restart itself. Turn it on in the node settings and ask again, or reboot the machine by hand.',
      }
    );
  if (!acknowledged(op, node))
    return done('pending', waitingFor(op, node), {
      detail: stage('awaiting-ack'),
    });
  const busy = node.busySlots ?? 0;
  return done(
    'in_progress',
    busy > 0
      ? `Draining before the restart: ${busy} runner slot${busy === 1 ? ' is' : 's are'} still busy. The node reboots once it is idle.`
      : 'The node is idle and reboots at its next cycle (after its reboot window).',
    { detail: stage(busy > 0 ? 'draining' : 'rebooting') }
  );
}

function stepDecommission(input: ReconcileInput): Step {
  const { op, node } = input;
  const drain = drainState(op, node);
  if (drain.state === 'drained')
    return done(
      'in_progress',
      'Drained. Retiring the node: its credentials stop working.',
      { detail: stage('retiring'), effects: [{ type: 'retire-node' }] }
    );
  return done(
    acknowledged(op, node) ? 'in_progress' : 'pending',
    drain.progress,
    {
      detail: stage('draining'),
      effects: cordon,
    }
  );
}

function replacementFailure(
  replacement: ReplacementObservation | null,
  expected: Role | null
): string | null {
  if (replacement === null || !replacement.exists)
    return 'The replacement machine was deleted. Register it again and start a new replace.';
  if (replacement.approval === 'rejected' || replacement.approval === 'retired')
    return `The replacement machine is ${replacement.approval}. Register a machine and start a new replace.`;
  if (replacement.role !== null && replacement.role !== expected)
    return `The replacement was assigned the ${replacement.role} role instead of ${expected ?? 'the old role'}. Change it back or start a new replace.`;
  return null;
}

function stepReplace(input: ReconcileInput): Step {
  const { op, node, replacement } = input;
  const failure = replacementFailure(replacement, node.role);
  if (failure !== null)
    return done('failed', failure, { failure, effects: [] });
  const next = replacement as ReplacementObservation;
  const old = node.role;
  if (next.approval === 'pending')
    return done(
      'in_progress',
      'Waiting for you to approve the replacement machine. The old node is cordoned meanwhile.',
      { detail: stage('awaiting-approval'), effects: cordon }
    );
  const effects =
    next.role === null && old !== null
      ? [
          ...cordon,
          {
            type: 'assign-role',
            nodeId: String(op.detail['replacement']),
            role: old,
          } as const,
        ]
      : cordon;
  if (next.converged && next.role === old && next.lastSeenAt !== null)
    return done(
      'succeeded',
      'Replaced: the new machine is approved, has the role and has converged. Decommission the old node when you are ready.',
      { detail: stage('converging') }
    );
  return done(
    'in_progress',
    `The replacement is converging${next.reconcileIssue === null ? '' : `: ${next.reconcileIssue}`}.`,
    { detail: stage('converging'), effects }
  );
}

function ended(input: ReconcileInput): Step | null {
  const { op, node } = input;
  if (!node.exists)
    return done('failed', 'The node no longer exists.', {
      failure:
        'The node was deleted while the operation was active. Nothing is left to do.',
    });
  if (node.approval === 'retired' && op.kind === 'decommission')
    return done('succeeded', 'The node is retired.', {
      detail: stage('retiring'),
    });
  if (node.approval === 'retired' || node.approval === 'rejected')
    return done(
      'cancelled',
      `The node is ${node.approval}; the ${op.kind} no longer applies.`
    );
  return null;
}

/**
 * The next step for an active operation. A terminal operation is returned
 * unchanged by the caller; this function never moves one.
 */
export function reconcileOperation(input: ReconcileInput): Step {
  const { op, now } = input;
  const early = ended(input);
  if (early !== null) return early;
  const expired =
    now.getTime() - op.requestedAt.getTime() > timeoutSecondsOf(op) * 1000;
  const step = {
    drain: stepDrain,
    restart: stepRestart,
    decommission: stepDecommission,
    replace: stepReplace,
  }[op.kind](input);
  if (step.status !== 'in_progress' && step.status !== 'pending') return step;
  if (!expired) return step;
  const failure = timeoutFailure(op, input.node);
  return done('failed', 'Timed out.', { failure });
}
