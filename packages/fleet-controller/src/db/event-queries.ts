import type { EventQuery } from '../store';
import type { EventInput, EventRow } from '../types';

import { type StoredEvent, unseen } from '../domain/event-keys';

import type { Db } from './client';
import { toEventRow } from './rows';

/** An event as written by the store itself. Fields the database defaults are omitted. */
export interface NewEvent {
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly kind: string;
  readonly severity: EventInput['severity'];
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export async function insertEvent(
  db: Db,
  event: NewEvent,
  at: Date | null
): Promise<void> {
  const data = JSON.stringify(event.data ?? {});
  await db`
    insert into events (at, node_id, node_label, kind, severity, message, data)
    values (
      coalesce(${at?.toISOString() ?? null}, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ${event.nodeId},
      ${event.nodeLabel},
      ${event.kind},
      ${event.severity},
      ${event.message},
      ${data}
    )`;
}

/**
 * Inserts several events for one node in order, in a single statement. An
 * event whose data.key this node already has is skipped (domain/event-keys.ts):
 * the caller holds a write transaction, so two reports cannot race on a key.
 */
export async function insertEvents(
  db: Db,
  node: { readonly id: string; readonly label: string },
  events: readonly StoredEvent[],
  at: Date
): Promise<void> {
  const keys = events
    .map((event) => event.data['key'])
    .filter((key): key is string => typeof key === 'string');
  const seen = new Set<string>();
  if (keys.length > 0) {
    const rows = await db`
      select data->>'key' as key from events
      where node_id = ${node.id}
        and data->>'key' in (
          select value from json_each(${JSON.stringify(keys)}))`;
    for (const row of rows) seen.add(String(row['key']));
  }
  const fresh = unseen(events, seen);
  if (fresh.length === 0) return;
  const items = JSON.stringify(fresh);
  await db`
    insert into events (at, node_id, node_label, kind, severity, message, data)
    select ${at.toISOString()}, ${node.id}, ${node.label},
           e.value->>'kind', e.value->>'severity', e.value->>'message',
           coalesce(e.value->'data', '{}')
    from json_each(${items}) as e
    order by cast(e.key as integer)`;
}

export async function selectEvents(
  db: Db,
  query: EventQuery
): Promise<EventRow[]> {
  const rows = await db`
    select * from events
    where (${query.nodeId ?? null} is null or node_id = ${query.nodeId ?? null})
      and (${query.severity ?? null} is null
           or severity = ${query.severity ?? null}
           or (${query.severity ?? null} = 'warn' and severity = 'error'))
      and (${query.beforeId ?? null} is null or id < ${query.beforeId ?? null})
    order by id desc
    limit ${query.limit}`;
  return rows.map(toEventRow);
}
