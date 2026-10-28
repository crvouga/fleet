import {
  DESIRED_HISTORY_KEEP,
  desiredChangeCause,
  isDesiredSnapshot,
  type DesiredHistoryRow,
  type DesiredSnapshot,
} from '../domain/desired-history';

import type { Db } from './client';
import { dateOf, numberOf, text, textOrNull, type Row } from './rows';

function snapshotOf(raw: unknown): DesiredSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return isDesiredSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toRow(row: Row): DesiredHistoryRow {
  const desired = snapshotOf(row['desired']);
  if (desired === null) throw new Error('desired_history holds invalid JSON');
  return {
    id: numberOf(row, 'id'),
    nodeId: text(row, 'node_id'),
    revision: text(row, 'revision'),
    desired,
    at: dateOf(row, 'at'),
    cause: textOrNull(row, 'cause'),
  };
}

export interface DesiredRecord {
  readonly nodeId: string;
  readonly desired: DesiredSnapshot;
  /** A caller's label; otherwise derived from the previous document. */
  readonly cause?: string | undefined;
  readonly now: Date;
}

/**
 * Appends the document unless its revision is already the newest row, then
 * prunes beyond the retention bound. Runs in one transaction so concurrent
 * heartbeats cannot write the same revision twice.
 */
export async function recordDesired(
  db: Db,
  record: DesiredRecord
): Promise<boolean> {
  const { nodeId, desired, cause, now } = record;
  // Almost every heartbeat repeats the newest revision: answer that with a read,
  // without taking the write lock. The transaction below re-checks.
  const newest = await db`
    select revision from desired_history where node_id = ${nodeId}
    order by id desc limit 1`;
  if (
    newest[0] !== undefined &&
    text(newest[0], 'revision') === desired.revision
  )
    return false;
  return db.begin(async (tx) => {
    const exists = await tx`select 1 as one from nodes where id = ${nodeId}`;
    if (exists.length === 0) return false;
    const latest = await tx`
      select revision, desired from desired_history
      where node_id = ${nodeId} order by id desc limit 1`;
    const last = latest[0];
    if (last !== undefined && text(last, 'revision') === desired.revision)
      return false;
    const label =
      cause ??
      desiredChangeCause(
        last === undefined ? null : snapshotOf(last['desired']),
        desired
      );
    await tx`
      insert into desired_history (node_id, revision, desired, at, cause)
      values (${nodeId}, ${desired.revision}, ${JSON.stringify(desired)}, ${now}, ${label})`;
    await tx`
      delete from desired_history
      where node_id = ${nodeId}
        and id not in (
          select id from desired_history where node_id = ${nodeId}
          order by id desc limit ${DESIRED_HISTORY_KEEP})`;
    return true;
  });
}

export async function selectDesiredHistory(
  db: Db,
  nodeId: string,
  limit: number
): Promise<DesiredHistoryRow[]> {
  const rows = await db`
    select * from desired_history where node_id = ${nodeId}
    order by id desc limit ${limit}`;
  return rows.map(toRow);
}
