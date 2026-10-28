import { randomBytes, randomUUID } from 'node:crypto';

import { sha256Hex } from '../auth/hash';
import type { Role } from '../types';

/** An enrollment grant is issued per "download installer" action. See docs/installer-enrollment.md. */
export type GrantState = 'pending' | 'used' | 'expired' | 'revoked';

export interface GrantRow {
  readonly id: string;
  /** Assigned and auto-approved at registration when set; null leaves approval to a person. */
  readonly role: Role | null;
  readonly label: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  /** The node that redeemed it first; the grant is bound to this id from then on. */
  readonly usedByNode: string | null;
  readonly revokedAt: Date | null;
}

/** A row plus its derived state. Never carries the token or its hash. */
export interface GrantView extends GrantRow {
  readonly state: GrantState;
}

export interface NewGrant {
  readonly id: string;
  /** sha256 of the token, hex. The token itself is never stored. */
  readonly tokenHash: string;
  readonly role: Role | null;
  readonly label: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Visible prefix: lets registration tell a grant from a static token without a lookup. */
export const GRANT_PREFIX = 'fgr_';
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const MIN_TTL_SECONDS = 5 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LABEL = 80;

/** 32 random bytes, base64url: 47 characters within the enrollment token alphabet. */
export function newGrantToken(): string {
  return GRANT_PREFIX + randomBytes(32).toString('base64url');
}

export function newGrantId(): string {
  return randomUUID();
}

export function hashGrantToken(token: string): string {
  return sha256Hex(token);
}

export function looksLikeGrant(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith(GRANT_PREFIX);
}

export function stateOf(row: GrantRow, now: Date): GrantState {
  if (row.revokedAt !== null) return 'revoked';
  if (row.usedAt !== null) return 'used';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}

export function viewOfGrant(row: GrantRow, now: Date): GrantView {
  return { ...row, state: stateOf(row, now) };
}

/** An integer number of seconds inside the allowed window, else null. */
export function validTtl(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TTL_SECONDS &&
    value <= MAX_TTL_SECONDS
    ? value
    : null;
}
