import type { RegisterInput } from '../store';
import type { NodeRow } from '../types';

import type { Db } from './client';
import { insertEvent, type NewEvent } from './event-queries';
import { selectNode, upsertNode } from './node-queries';
import { text, toNodeRow } from './rows';

function registrationEvents(
  input: RegisterInput,
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
      message: `${node.hostname} approved with the ${input.role} role token`,
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
  const { row, created } = await upsertNode(db, input);
  const node = toNodeRow(row);
  for (const event of registrationEvents(input, node, created, before)) {
    await insertEvent(db, event, null);
  }
  return { node, created };
}
