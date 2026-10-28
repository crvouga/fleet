import { randomBytes } from 'node:crypto';

import {
  matchSecret,
  promote,
  type CredentialRecord,
} from '../domain/credential-rotation';

import { insertAudit } from './audit-queries';
import type { Db } from './client';
import { insertEvent } from './event-queries';
import { dateOrNull, textOrNull, type Row } from './rows';

/** Loads the credential record of a node (its row plus the lifecycle columns). */
export async function loadCredential(
  db: Db,
  id: string
): Promise<CredentialRecord | null> {
  const rows = await db`
    select n.secret_hash as secret_hash, l.next_secret_hash as next_secret_hash,
           l.rotate_requested_at as rotate_requested_at, l.rotated_at as rotated_at,
           l.revoked_at as revoked_at
    from nodes n left join node_lifecycle l on l.node_id = n.id
    where n.id = ${id}`;
  const row: Row | undefined = rows[0];
  if (row === undefined) return null;
  return {
    currentHash: String(row['secret_hash']),
    nextHash: textOrNull(row, 'next_secret_hash'),
    rotateRequestedAt: dateOrNull(row, 'rotate_requested_at'),
    rotatedAt: dateOrNull(row, 'rotated_at'),
    revokedAt: dateOrNull(row, 'revoked_at'),
  };
}

/** Writes only the credential columns, so other lifecycle columns are never touched. */
export async function saveCredential(
  db: Db,
  id: string,
  record: CredentialRecord
): Promise<void> {
  await db`update nodes set secret_hash = ${record.currentHash} where id = ${id}`;
  await db`
    insert into node_lifecycle (node_id, next_secret_hash, rotate_requested_at, rotated_at, revoked_at)
    values (${id}, ${record.nextHash}, ${record.rotateRequestedAt}, ${record.rotatedAt}, ${record.revokedAt})
    on conflict (node_id) do update set
      next_secret_hash = excluded.next_secret_hash,
      rotate_requested_at = excluded.rotate_requested_at,
      rotated_at = excluded.rotated_at,
      revoked_at = excluded.revoked_at`;
}

export function unusableSecret(): string {
  return randomBytes(16).toString('hex');
}

const shortId = (id: string): string => id.slice(0, 4);

/**
 * Inside a write transaction: when `hash` is the live next secret, promote it,
 * and record the event and the audit row. Returns whether it promoted.
 */
export async function promoteIfNext(
  tx: Db,
  id: string,
  hash: string,
  now: Date
): Promise<boolean> {
  const record = await loadCredential(tx, id);
  if (record === null || matchSecret(record, hash, now) !== 'next')
    return false;
  await saveCredential(tx, id, promote(record, now));
  await insertEvent(
    tx,
    {
      nodeId: id,
      nodeLabel: null,
      kind: 'credential_rotated',
      severity: 'info',
      message: 'Node credential rotated: the node now uses its new secret.',
    },
    null
  );
  await insertAudit(tx, {
    actor: `node:${shortId(id)}`,
    action: 'credential.rotated',
    targetKind: 'node',
    targetId: id,
    detail: {},
  });
  return true;
}

/** Whether the node was revoked (and so must re-register as pending). */
export async function isRevoked(db: Db, id: string): Promise<boolean> {
  const rows = await db`
    select revoked_at from node_lifecycle where node_id = ${id} and revoked_at is not null`;
  return rows.length > 0;
}

/**
 * After a registration wrote a new secret: forget a pending rotation and a
 * revocation. A revoked node came back as `pending` and needs a person.
 */
export async function settleRegistration(
  db: Db,
  id: string,
  wasRevoked: boolean
): Promise<void> {
  await db`
    update node_lifecycle set next_secret_hash = null, rotate_requested_at = null, revoked_at = null
    where node_id = ${id}`;
  if (!wasRevoked) return;
  await insertEvent(
    db,
    {
      nodeId: id,
      nodeLabel: null,
      kind: 'credential_reregistered',
      severity: 'warn',
      message:
        'A node with a revoked credential registered again. It waits for a person to approve it: check that it is the machine you expect.',
    },
    null
  );
  await insertAudit(db, {
    actor: `node:${shortId(id)}`,
    action: 'credential.reregistered',
    targetKind: 'node',
    targetId: id,
    detail: { forcedApproval: 'pending' },
  });
}
