import type { Db } from './client';
import type { LifecyclePatch, NodeLifecycle } from '../domain/operations-store';
import { dateOrNull, text, textOrNull, type Row } from './rows';

export function toLifecycle(row: Row): NodeLifecycle {
  return {
    nodeId: text(row, 'node_id'),
    drainRequestedAt: dateOrNull(row, 'drain_requested_at'),
    drainReason: textOrNull(row, 'drain_reason'),
    restartRequestedAt: dateOrNull(row, 'restart_requested_at'),
    restartCompletedAt: dateOrNull(row, 'restart_completed_at'),
    replacedBy: textOrNull(row, 'replaced_by'),
    decommissionRequestedAt: dateOrNull(row, 'decommission_requested_at'),
  };
}

export async function selectLifecycle(
  db: Db,
  nodeId: string
): Promise<NodeLifecycle | null> {
  const rows = await db`select * from node_lifecycle where node_id = ${nodeId}`;
  return rows[0] === undefined ? null : toLifecycle(rows[0]);
}

/** Patch key to column. Columns owned by other features (rotation, revocation) are never touched here. */
const COLUMNS: Readonly<Record<keyof Omit<NodeLifecycle, 'nodeId'>, string>> = {
  drainRequestedAt: 'drain_requested_at',
  drainReason: 'drain_reason',
  restartRequestedAt: 'restart_requested_at',
  restartCompletedAt: 'restart_completed_at',
  replacedBy: 'replaced_by',
  decommissionRequestedAt: 'decommission_requested_at',
};

function stored(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

/** Upsert only the named columns; `null` clears one. The node must exist (foreign key). */
export async function upsertLifecycle(
  db: Db,
  nodeId: string,
  patch: LifecyclePatch
): Promise<void> {
  const entries = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter(
    (key) => patch[key] !== undefined
  );
  if (entries.length === 0) {
    await db`insert into node_lifecycle (node_id) values (${nodeId}) on conflict (node_id) do nothing`;
    return;
  }
  const columns = entries.map((key) => COLUMNS[key]);
  const values = entries.map((key) => stored(patch[key] ?? null));
  await db.unsafe(
    `insert into node_lifecycle (node_id, ${columns.join(', ')})
     values (?, ${columns.map(() => '?').join(', ')})
     on conflict (node_id) do update set ${columns
       .map((column) => `${column} = excluded.${column}`)
       .join(', ')}`,
    [nodeId, ...values]
  );
}
