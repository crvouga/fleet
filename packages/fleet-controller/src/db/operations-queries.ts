import type { Db } from './client';
import {
  isOperationKind,
  isOperationStatus,
  type Operation,
} from '../domain/operations';
import type {
  NewOperation,
  OperationQuery,
  OperationUpdate,
} from '../domain/operations-store';
import {
  dateOf,
  dateOrNull,
  jsonObject,
  numberOf,
  text,
  textOrNull,
  type Row,
} from './rows';

function known<T>(row: Row, key: string, guard: (v: unknown) => v is T): T {
  const value = row[key];
  if (guard(value)) return value;
  throw new TypeError(`database column ${key} was not a known value`);
}

export function toOperation(row: Row): Operation {
  return {
    id: text(row, 'id'),
    kind: known(row, 'kind', isOperationKind),
    nodeId: textOrNull(row, 'node_id'),
    status: known(row, 'status', isOperationStatus),
    requestedBy: text(row, 'requested_by'),
    requestedAt: dateOf(row, 'requested_at'),
    updatedAt: dateOf(row, 'updated_at'),
    completedAt: dateOrNull(row, 'completed_at'),
    attempts: numberOf(row, 'attempts'),
    progress: textOrNull(row, 'progress'),
    failure: textOrNull(row, 'failure'),
    idempotencyKey: textOrNull(row, 'idempotency_key'),
    detail: jsonObject(row, 'detail'),
  };
}

export async function selectOperation(
  db: Db,
  id: string
): Promise<Operation | null> {
  const rows = await db`select * from operations where id = ${id}`;
  return rows[0] === undefined ? null : toOperation(rows[0]);
}

export async function selectByKey(
  db: Db,
  key: string
): Promise<Operation | null> {
  const rows =
    await db`select * from operations where idempotency_key = ${key}`;
  return rows[0] === undefined ? null : toOperation(rows[0]);
}

/** Active operations on one node. */
export async function selectActiveOnNode(
  db: Db,
  nodeId: string
): Promise<Operation[]> {
  const rows = await db`
    select * from operations
    where node_id = ${nodeId} and status in ('pending', 'in_progress')
    order by requested_at, id`;
  return rows.map(toOperation);
}

/** Active operations on the node, or that name it as their replacement. */
export async function selectActiveFor(
  db: Db,
  nodeId: string
): Promise<Operation[]> {
  const rows = await db`
    select * from operations
    where status in ('pending', 'in_progress')
      and (node_id = ${nodeId} or json_extract(detail, '$.replacement') = ${nodeId})
    order by requested_at, id`;
  return rows.map(toOperation);
}

export async function insertOperation(
  db: Db,
  input: NewOperation
): Promise<Operation> {
  const at = input.requestedAt.toISOString();
  const rows = await db`
    insert into operations
      (id, kind, node_id, status, requested_by, requested_at, updated_at,
       progress, idempotency_key, detail)
    values (${input.id}, ${input.kind}, ${input.nodeId}, 'pending', ${input.requestedBy},
      ${at}, ${at}, ${input.progress}, ${input.idempotencyKey}, ${JSON.stringify(input.detail)})
    returning *`;
  const row = rows[0];
  if (row === undefined) throw new Error('operation insert returned no row');
  return toOperation(row);
}

/** Bound values for `selectOperations`; a null disables its filter. */
function filterValues(query: OperationQuery) {
  return {
    node: query.nodeId ?? null,
    kind: query.kind ?? null,
    status: query.status ?? null,
    active: query.activeOnly === true ? 1 : 0,
    beforeAt: query.before?.requestedAt.toISOString() ?? null,
    beforeId: query.before?.id ?? null,
  };
}

export async function selectOperations(
  db: Db,
  query: OperationQuery
): Promise<Operation[]> {
  const f = filterValues(query);
  const rows = await db`
    select * from operations
    where (${f.node} is null or node_id = ${f.node})
      and (${f.kind} is null or kind = ${f.kind})
      and (${f.status} is null or status = ${f.status})
      and (${f.active} = 0 or status in ('pending', 'in_progress'))
      and (${f.beforeAt} is null or requested_at < ${f.beforeAt}
           or (requested_at = ${f.beforeAt} and id < ${f.beforeId}))
    order by requested_at desc, id desc
    limit ${query.limit}`;
  return rows.map(toOperation);
}

const TERMINAL_SQL = `('succeeded', 'failed', 'cancelled')`;

/** Compare-and-swap on the status; the detail is merged as a JSON merge patch. */
export async function updateOperation(
  db: Db,
  id: string,
  change: OperationUpdate
): Promise<Operation | null> {
  const failureGiven = change.failure === undefined ? 0 : 1;
  const rows = await db.unsafe(
    `update operations set
       status = ?, updated_at = ?, progress = ?,
       failure = case when ? = 1 then ? else failure end,
       detail = json_patch(detail, ?),
       attempts = attempts + ?,
       completed_at = case when ? in ${TERMINAL_SQL} then ? else completed_at end
     where id = ? and status = ?
     returning *`,
    [
      change.status,
      change.updatedAt.toISOString(),
      change.progress,
      failureGiven,
      change.failure ?? null,
      JSON.stringify(change.detail ?? {}),
      change.countAttempt === true ? 1 : 0,
      change.status,
      change.updatedAt.toISOString(),
      id,
      change.expect,
    ]
  );
  return rows[0] === undefined ? null : toOperation(rows[0]);
}
