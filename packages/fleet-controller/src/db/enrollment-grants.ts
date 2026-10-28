import { randomBytes } from 'node:crypto';

import { keyIdOf, type BindingKey } from '../enrollment/binding';
import type { GrantRow, NewGrant } from '../enrollment/grants';
import type { GrantStore, Redemption, RevokeResult } from '../enrollment/store';
import { isActiveRole } from '../types';

import type { Db } from './client';
import { dateOf, dateOrNull, text, textOrNull, type Row } from './rows';

const KEY_NAME = 'enrollment-binding-key';

function toGrant(row: Row): GrantRow {
  const role = textOrNull(row, 'role');
  return {
    id: text(row, 'id'),
    role: isActiveRole(role) ? role : null,
    label: textOrNull(row, 'label'),
    createdBy: text(row, 'created_by'),
    createdAt: dateOf(row, 'created_at'),
    expiresAt: dateOf(row, 'expires_at'),
    usedAt: dateOrNull(row, 'used_at'),
    usedByNode: textOrNull(row, 'used_by_node'),
    revokedAt: dateOrNull(row, 'revoked_at'),
  };
}

/** `enrollment_grants` and `controller_secrets` in SQLite. */
export class SqliteGrants implements GrantStore {
  constructor(private readonly db: Db) {}

  async create(grant: NewGrant): Promise<GrantRow> {
    const rows = await this.db`
      insert into enrollment_grants (id, token_hash, role, label, created_by, created_at, expires_at)
      values (${grant.id}, ${grant.tokenHash}, ${grant.role}, ${grant.label}, ${grant.createdBy},
              ${grant.createdAt}, ${grant.expiresAt})
      returning *`;
    return toGrant(rows[0]!);
  }

  async list(limit: number): Promise<readonly GrantRow[]> {
    const rows = await this
      .db`select * from enrollment_grants order by created_at desc, id desc limit ${limit}`;
    return rows.map(toGrant);
  }

  async find(id: string): Promise<GrantRow | null> {
    const rows = await this
      .db`select * from enrollment_grants where id = ${id}`;
    return rows[0] === undefined ? null : toGrant(rows[0]);
  }

  async findByHash(tokenHash: string): Promise<GrantRow | null> {
    const rows = await this
      .db`select * from enrollment_grants where token_hash = ${tokenHash}`;
    return rows[0] === undefined ? null : toGrant(rows[0]);
  }

  async redeem(
    tokenHash: string,
    nodeId: string,
    now: Date
  ): Promise<Redemption> {
    // One conditional UPDATE is the single-use gate: SQLite serializes writers,
    // so of any number of concurrent presentations exactly one changes the row.
    const won = await this.db`
      update enrollment_grants set used_at = ${now}, used_by_node = ${nodeId}
      where token_hash = ${tokenHash} and used_at is null and revoked_at is null
        and expires_at > ${now}
      returning *`;
    if (won[0] !== undefined)
      return { outcome: 'redeemed', grant: toGrant(won[0]) };
    const grant = await this.findByHash(tokenHash);
    if (grant === null) return { outcome: 'unknown' };
    if (grant.revokedAt !== null) return { outcome: 'revoked', grant };
    if (grant.expiresAt.getTime() <= now.getTime())
      return { outcome: 'expired', grant };
    return {
      outcome: grant.usedByNode === nodeId ? 'resumed' : 'reused',
      grant,
    };
  }

  async release(id: string, nodeId: string): Promise<void> {
    await this.db`
      update enrollment_grants set used_at = null, used_by_node = null
      where id = ${id} and used_by_node = ${nodeId}`;
  }

  async revoke(id: string, now: Date): Promise<RevokeResult> {
    const changed = await this.db`
      update enrollment_grants set revoked_at = ${now}
      where id = ${id} and revoked_at is null returning *`;
    if (changed[0] !== undefined)
      return { ok: true, grant: toGrant(changed[0]), changed: true };
    const grant = await this.find(id);
    return grant === null ? { ok: false } : { ok: true, grant, changed: false };
  }

  async bindingKey(): Promise<BindingKey> {
    const secret = randomBytes(32).toString('hex');
    // Insert-if-absent, then read: concurrent first calls agree on one secret.
    await this.db`
      insert or ignore into controller_secrets (name, value) values (${KEY_NAME}, ${secret})`;
    const rows = await this
      .db`select value from controller_secrets where name = ${KEY_NAME}`;
    const stored = text(rows[0]!, 'value');
    return { keyId: keyIdOf(stored), secret: stored };
  }
}
