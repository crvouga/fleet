import { timingSafeEqual } from 'node:crypto';

import type { RegisterInput, NodePatch } from '../store';
import type { Approval } from '../types';

import type { Db } from './client';
import { text, type Row } from './rows';

export async function selectNode(
  db: Db,
  id: string,
  lock: boolean
): Promise<Row | null> {
  const rows = lock
    ? await db`select * from fleet.nodes where id = ${id}::text for update`
    : await db`select * from fleet.nodes where id = ${id}::text`;
  return rows[0] ?? null;
}

export async function selectNodes(db: Db): Promise<Row[]> {
  return db`
    select * from fleet.nodes
    order by last_seen_at desc nulls last, first_seen_at desc, id`;
}

/** The row when the hash matches, compared in constant time. Any approval state. */
export async function selectNodeWithSecret(
  db: Db,
  id: string,
  secretHash: string
): Promise<Row | null> {
  const row = await selectNode(db, id, false);
  if (row === null) return null;
  const stored = Buffer.from(text(row, 'secret_hash'));
  const given = Buffer.from(secretHash);
  const same = stored.length === given.length && timingSafeEqual(stored, given);
  return same ? row : null;
}

/**
 * Insert, or replace the secret of a node that is registering again.
 * A rejected node stays rejected; any other node takes the new approval, so
 * a re-registration without the role token waits for a person again.
 */
export async function upsertNode(
  db: Db,
  input: RegisterInput
): Promise<{ row: Row; created: boolean }> {
  const approved = input.approval === 'approved';
  const approvedBy = approved ? input.enrolledVia : null;
  const rows = await db`
    insert into fleet.nodes as n
      (id, role, hostname, approval, secret_hash, enrolled_via, remote_addr, approved_at, approved_by)
    values (
      ${input.id}::text, ${input.role}::text, ${input.hostname}::text, ${input.approval}::text,
      ${input.secretHash}::text, ${input.enrolledVia}::text, ${input.remoteAddr}::text,
      case when ${approved}::boolean then now() end, ${approvedBy}::text
    )
    on conflict (id) do update set
      role = excluded.role,
      hostname = excluded.hostname,
      secret_hash = excluded.secret_hash,
      remote_addr = excluded.remote_addr,
      approval = case when n.approval = 'rejected' then n.approval else excluded.approval end,
      enrolled_via = case when n.approval = 'rejected' then n.enrolled_via else excluded.enrolled_via end,
      approved_at = case
        when n.approval = 'rejected' then n.approved_at
        when excluded.approval <> 'approved' then null
        when n.approval = 'approved' then n.approved_at
        else excluded.approved_at end,
      approved_by = case
        when n.approval = 'rejected' then n.approved_by
        when excluded.approval <> 'approved' then null
        when n.approval = 'approved' then n.approved_by
        else excluded.approved_by end,
      retired_at = case when n.approval = 'rejected' then n.retired_at else null end,
      offline_notified_at = case when n.approval = 'rejected' then n.offline_notified_at else null end
    returning n.*, (n.xmax = 0) as created`;
  const row = rows[0];
  if (row === undefined) throw new Error('node upsert returned no row');
  return { row, created: row['created'] === true };
}

export async function updatePatch(
  db: Db,
  id: string,
  patch: NodePatch
): Promise<Row | null> {
  const hasName = patch.displayName !== undefined;
  const hasNote = patch.note !== undefined;
  const labels = patch.labels === undefined ? null : [...patch.labels];
  const rows = await db`
    update fleet.nodes set
      display_name = case when ${hasName}::boolean then ${patch.displayName ?? null}::text else display_name end,
      note = case when ${hasNote}::boolean then ${patch.note ?? null}::text else note end,
      labels = case when ${labels !== null}::boolean then ${db.array(labels ?? [], 'TEXT')}::text[] else labels end
    where id = ${id}::text
    returning *`;
  return rows[0] ?? null;
}

export async function updateApproval(
  db: Db,
  id: string,
  approval: Approval,
  actor: string
): Promise<Row | null> {
  const rows = await db`
    update fleet.nodes set
      approval = ${approval}::text,
      approved_at = case when ${approval}::text = 'approved' then now() else approved_at end,
      approved_by = case when ${approval}::text = 'approved' then ${actor}::text else approved_by end,
      retired_at = case when ${approval}::text = 'retired' then now() else null end,
      offline_notified_at = null
    where id = ${id}::text
    returning *`;
  return rows[0] ?? null;
}

export async function deleteRow(db: Db, id: string): Promise<Row | null> {
  const rows =
    await db`delete from fleet.nodes where id = ${id}::text returning *`;
  return rows[0] ?? null;
}

export async function selectDue(
  db: Db,
  now: Date,
  seconds: number
): Promise<Row[]> {
  return db`
    select * from fleet.nodes
    where approval = 'approved'
      and offline_notified_at is null
      and coalesce(last_seen_at, approved_at, first_seen_at)
          < ${now.toISOString()}::timestamptz - (${seconds}::int * interval '1 second')
    order by id`;
}

export async function updateNotified(
  db: Db,
  id: string,
  at: Date | null
): Promise<void> {
  await db`
    update fleet.nodes set offline_notified_at = ${at?.toISOString() ?? null}::timestamptz
    where id = ${id}::text`;
}
