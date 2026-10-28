import type { AuditQuery } from '../store';
import type { AuditInput, AuditRow } from '../types';

import type { Db } from './client';
import { toAuditRow } from './rows';

export async function insertAudit(db: Db, entry: AuditInput): Promise<void> {
  await db`
    insert into audit_log (actor, actor_role, action, target_kind, target_id, outcome, request_id, detail)
    values (
      ${entry.actor}, ${entry.actorRole ?? null}, ${entry.action}, ${entry.targetKind},
      ${entry.targetId ?? null}, ${entry.outcome ?? 'success'}, ${entry.requestId ?? null},
      ${JSON.stringify(entry.detail ?? {})}
    )`;
}

export async function selectAudit(
  db: Db,
  query: AuditQuery
): Promise<readonly AuditRow[]> {
  const rows = await db`
    select * from audit_log
    where (${query.targetKind ?? null} is null or target_kind = ${query.targetKind ?? null})
      and (${query.targetId ?? null} is null or target_id = ${query.targetId ?? null})
      and (${query.actor ?? null} is null or actor = ${query.actor ?? null})
      and (${query.beforeId ?? null} is null or id < ${query.beforeId ?? null})
    order by id desc
    limit ${query.limit}`;
  return rows.map(toAuditRow);
}
