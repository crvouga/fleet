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
    insert into fleet.events (at, node_id, node_label, kind, severity, message, data)
    values (
      coalesce(${at?.toISOString() ?? null}::timestamptz, now()),
      ${event.nodeId}::text,
      ${event.nodeLabel}::text,
      ${event.kind}::text,
      ${event.severity}::text,
      ${event.message}::text,
      ${data}::text::jsonb
    )`;
}

/**
 * Inserts several events for one node in order, in a single statement. An
 * event whose data.key this node already has is skipped (domain/event-keys.ts):
 * the caller holds the node's row lock, so two reports cannot race on a key.
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
      select data->>'key' as key from fleet.events
      where node_id = ${node.id}::text
        and data->>'key' in (
          select jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb))`;
    for (const row of rows) seen.add(String(row['key']));
  }
  const fresh = unseen(events, seen);
  if (fresh.length === 0) return;
  const items = JSON.stringify(fresh);
  await db`
    insert into fleet.events (at, node_id, node_label, kind, severity, message, data)
    select ${at.toISOString()}::timestamptz, ${node.id}::text, ${node.label}::text,
           e.item->>'kind', e.item->>'severity', e.item->>'message',
           coalesce(e.item->'data', '{}'::jsonb)
    from jsonb_array_elements(${items}::text::jsonb) with ordinality as e(item, ord)
    order by e.ord`;
}

export async function selectEvents(
  db: Db,
  query: EventQuery
): Promise<EventRow[]> {
  const rows = await db`
    select * from fleet.events
    where (${query.nodeId ?? null}::text is null or node_id = ${query.nodeId ?? null}::text)
      and (${query.severity ?? null}::text is null
           or severity = ${query.severity ?? null}::text
           or (${query.severity ?? null}::text = 'warn' and severity = 'error'))
      and (${query.beforeId ?? null}::bigint is null or id < ${query.beforeId ?? null}::bigint)
    order by id desc
    limit ${query.limit}::int`;
  return rows.map(toEventRow);
}
