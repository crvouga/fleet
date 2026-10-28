import type { RegisterInput } from '../store';
import type { NodeRow, Role } from '../types';

import type { Db } from './client';
import { insertEvent, type NewEvent } from './event-queries';
import { selectNode, upsertNode } from './node-queries';
import { text, textOrNull, toNodeRow } from './rows';

export const ENROLLMENT_ACTOR = 'enrollment-token';

/** The `role_assigned` event: who changed the assignment, from what to what. */
export function roleAssignedEvent(
  node: NodeRow,
  previous: Role | null,
  actor: string
): NewEvent {
  const message =
    node.role === null
      ? `${actor} unassigned the ${previous ?? 'previous'} role`
      : previous === null
        ? `${actor} assigned the ${node.role} role`
        : `${actor} changed the role from ${previous} to ${node.role}`;
  return {
    nodeId: node.id,
    nodeLabel: node.displayName ?? node.hostname,
    kind: 'role_assigned',
    severity: 'info',
    message,
    data: { role: node.role, previous, actor },
  };
}

function registrationEvents(
  node: NodeRow,
  created: boolean,
  before: string | null
): NewEvent[] {
  const base = {
    nodeId: node.id,
    nodeLabel: node.displayName ?? node.hostname,
  };
  const events: NewEvent[] = [];
  if (created) {
    events.push({
      ...base,
      kind: 'registered',
      severity: 'info',
      message: `${node.hostname} announced itself`,
    });
  } else {
    const demoted = before === 'approved' && node.approval !== 'approved';
    events.push({
      ...base,
      kind: 'reregistered',
      severity: demoted ? 'warn' : 'info',
      message: demoted
        ? `${node.hostname} registered again with a new secret and needs approval`
        : `${node.hostname} registered again with a new secret`,
    });
  }
  if (node.approval === 'approved' && before !== 'approved') {
    events.push({
      ...base,
      kind: 'approved',
      severity: 'info',
      message: `${node.hostname} approved with an enrollment token`,
    });
  }
  return events;
}

/** Upsert the node and record what happened, atomically. */
export async function registerWithEvents(
  db: Db,
  input: RegisterInput
): Promise<{ node: NodeRow; created: boolean }> {
  const previous = await selectNode(db, input.id, true);
  const before = previous === null ? null : text(previous, 'approval');
  const roleBefore = previous === null ? null : textOrNull(previous, 'role');
  const { row, created } = await upsertNode(db, input);
  const node = toNodeRow(row);
  const events = registrationEvents(node, created, before);
  if (roleBefore === null && node.role !== null)
    events.push(roleAssignedEvent(node, null, ENROLLMENT_ACTOR));
  for (const event of events) await insertEvent(db, event, null);
  return { node, created };
}
