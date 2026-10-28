import {
  acceptNext,
  matchSecret,
  requestRotation,
  revoke,
  statusOf,
  type CredentialResult,
  type CredentialStatus,
} from '../domain/credential-rotation';

import {
  loadCredential,
  promoteIfNext,
  saveCredential,
  unusableSecret,
} from './credential-queries';
import type { Db } from './client';
import { selectNode } from './node-queries';
import type { Row } from './rows';

/**
 * The node row when the presented hash is its current secret, or its live next
 * secret (which is promoted on the spot). Any approval state.
 */
export async function verifySecret(
  db: Db,
  id: string,
  hash: string,
  now: Date
): Promise<Row | null> {
  const record = await loadCredential(db, id);
  if (record === null) return null;
  const match = matchSecret(record, hash, now);
  if (match === 'none') return null;
  if (match === 'next')
    await db.begin(async (tx) => {
      await promoteIfNext(tx, id, hash, now);
    });
  // After a promotion the next secret is the current one; otherwise unchanged.
  return selectNode(db, id, false);
}

export async function statusFor(
  db: Db,
  id: string,
  now: Date
): Promise<CredentialStatus | null> {
  const record = await loadCredential(db, id);
  return record === null ? null : statusOf(record, now);
}

export function requestFor(
  db: Db,
  id: string,
  now: Date
): Promise<CredentialResult<'revoked'>> {
  return db.begin(async (tx) => {
    const record = await loadCredential(tx, id);
    if (record === null) return { ok: false, reason: 'unknown_node' };
    const outcome = requestRotation(record, now);
    if (!outcome.ok) return outcome;
    if (outcome.changed) await saveCredential(tx, id, outcome.record);
    return {
      ok: true,
      changed: outcome.changed,
      status: statusOf(outcome.record, now),
    };
  });
}

export function submitNextFor(
  db: Db,
  id: string,
  nextHash: string,
  now: Date
): Promise<CredentialResult<'revoked' | 'not_requested' | 'same_secret'>> {
  return db.begin(async (tx) => {
    const record = await loadCredential(tx, id);
    if (record === null) return { ok: false, reason: 'unknown_node' };
    const outcome = acceptNext(record, nextHash, now);
    if (!outcome.ok) return outcome;
    if (outcome.changed) await saveCredential(tx, id, outcome.record);
    return {
      ok: true,
      changed: outcome.changed,
      status: statusOf(outcome.record, now),
    };
  });
}

export function revokeFor(
  db: Db,
  id: string,
  now: Date
): Promise<CredentialResult> {
  return db.begin(async (tx) => {
    const record = await loadCredential(tx, id);
    if (record === null) return { ok: false, reason: 'unknown_node' };
    if (record.revokedAt !== null)
      return { ok: true, changed: false, status: statusOf(record, now) };
    const revoked = revoke(record, now, unusableSecret());
    await saveCredential(tx, id, revoked);
    return { ok: true, changed: true, status: statusOf(revoked, now) };
  });
}
