import type { Operation, OperationKind } from '../../src/domain/operations';
import type {
  NodeObservation,
  ReplacementObservation,
} from '../../src/domain/operations-reconcile';

export const T0 = new Date('2026-10-14T12:00:00.000Z');
export const later = (seconds: number, base: Date = T0): Date =>
  new Date(base.getTime() + seconds * 1000);

export function operation(
  kind: OperationKind,
  overrides: Partial<Operation> = {}
): Operation {
  return {
    id: 'op-1',
    kind,
    nodeId: 'n'.repeat(64),
    status: 'pending',
    requestedBy: 'admin@example.com',
    requestedAt: T0,
    updatedAt: T0,
    completedAt: null,
    attempts: 0,
    progress: null,
    failure: null,
    idempotencyKey: null,
    detail: {},
    ...overrides,
  };
}

/** A healthy, online CI node that has applied everything the controller wants. */
export function observed(
  overrides: Partial<NodeObservation> = {}
): NodeObservation {
  return {
    exists: true,
    approval: 'approved',
    role: 'ci',
    lastSeenAt: later(30),
    bootId: 'boot-1',
    uptimeSeconds: 86_400,
    busySlots: 0,
    gateClosed: true,
    appliedRevision: 'rev-2',
    desiredRevision: 'rev-2',
    cordoned: true,
    rebootEnabled: true,
    converged: true,
    reconcileIssue: null,
    ...overrides,
  };
}

export function replacementObserved(
  overrides: Partial<ReplacementObservation> = {}
): ReplacementObservation {
  return {
    exists: true,
    approval: 'approved',
    role: 'ci',
    converged: true,
    lastSeenAt: later(60),
    reconcileIssue: null,
    ...overrides,
  };
}
