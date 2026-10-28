import { randomBytes } from 'node:crypto';

import { keyIdOf, type BindingKey } from './binding';
import type { GrantRow, NewGrant } from './grants';
import type { GrantStore, Redemption, RevokeResult } from './store';

interface Stored {
  row: GrantRow;
  readonly tokenHash: string;
}

/** An in-memory GrantStore with the same semantics as SQLite, for fixtures and unit tests. */
export class MemoryGrants implements GrantStore {
  private readonly grants = new Map<string, Stored>();
  private key: BindingKey | null = null;

  async create(grant: NewGrant): Promise<GrantRow> {
    const row: GrantRow = {
      id: grant.id,
      role: grant.role,
      label: grant.label,
      createdBy: grant.createdBy,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      usedAt: null,
      usedByNode: null,
      revokedAt: null,
    };
    this.grants.set(grant.id, { row, tokenHash: grant.tokenHash });
    return row;
  }

  async list(limit: number): Promise<readonly GrantRow[]> {
    return [...this.grants.values()]
      .map((stored) => stored.row)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async find(id: string): Promise<GrantRow | null> {
    return this.grants.get(id)?.row ?? null;
  }

  async findByHash(tokenHash: string): Promise<GrantRow | null> {
    return (
      [...this.grants.values()].find((s) => s.tokenHash === tokenHash)?.row ??
      null
    );
  }

  async redeem(
    tokenHash: string,
    nodeId: string,
    now: Date
  ): Promise<Redemption> {
    const stored = [...this.grants.values()].find(
      (s) => s.tokenHash === tokenHash
    );
    if (stored === undefined) return { outcome: 'unknown' };
    const { row } = stored;
    if (row.revokedAt !== null) return { outcome: 'revoked', grant: row };
    if (row.expiresAt.getTime() <= now.getTime())
      return { outcome: 'expired', grant: row };
    if (row.usedAt === null) {
      stored.row = { ...row, usedAt: now, usedByNode: nodeId };
      return { outcome: 'redeemed', grant: stored.row };
    }
    return {
      outcome: row.usedByNode === nodeId ? 'resumed' : 'reused',
      grant: row,
    };
  }

  async release(id: string, nodeId: string): Promise<void> {
    const stored = this.grants.get(id);
    if (stored !== undefined && stored.row.usedByNode === nodeId)
      stored.row = { ...stored.row, usedAt: null, usedByNode: null };
  }

  async revoke(id: string, now: Date): Promise<RevokeResult> {
    const stored = this.grants.get(id);
    if (stored === undefined) return { ok: false };
    if (stored.row.revokedAt !== null)
      return { ok: true, grant: stored.row, changed: false };
    stored.row = { ...stored.row, revokedAt: now };
    return { ok: true, grant: stored.row, changed: true };
  }

  async bindingKey(): Promise<BindingKey> {
    if (this.key === null) {
      const secret = randomBytes(32).toString('hex');
      this.key = { keyId: keyIdOf(secret), secret };
    }
    return this.key;
  }
}
