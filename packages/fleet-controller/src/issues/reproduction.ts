import type { Operation } from '../domain/operations';
import type { EventRow } from '../types';

import { clip } from './gather-node';

const MAX_STEPS = 8;

function describe(event: EventRow): string {
  return `${event.at.toISOString()} ${event.kind} (${event.severity}): ${clip(event.message, 200)}`;
}

/**
 * Steps reconstructed from what the controller recorded. It records events and
 * operations, not what an operator clicked, so this is a sequence of
 * observations, not a script. Null when there is nothing to reconstruct from.
 */
export function reproduction(input: {
  readonly event: EventRow | null;
  readonly operation: Operation | null;
  /** Events of the same node, newest first. */
  readonly events: readonly EventRow[];
}): string[] | null {
  const { event, operation } = input;
  if (event !== null) {
    const before = input.events
      .filter((entry) => entry.id < event.id)
      .slice(0, MAX_STEPS)
      .reverse()
      .map(describe);
    return [...before, `Observed: ${describe(event)}`];
  }
  if (operation !== null) {
    return [
      `${operation.requestedAt.toISOString()} ${operation.kind} requested for the node`,
      ...(operation.progress === null
        ? []
        : [`Progress: ${clip(operation.progress, 200)}`]),
      `Status ${operation.status} after ${operation.attempts} reconcile pass(es)`,
      ...(operation.failure === null
        ? []
        : [`Observed: ${clip(operation.failure, 300)}`]),
    ];
  }
  return null;
}
