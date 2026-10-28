import { safeEqual } from '../auth/hash';

/**
 * Node credential lifecycle as a pure state machine, shared by the SQLite and
 * in-memory stores. Only sha256 hashes ever appear here.
 *
 *   idle --request--> requested --node posts next--> pending --first auth
 *     with next--> idle (rotated)          any state --revoke--> revoked
 *
 * While `pending` the controller accepts the current AND the next secret. The
 * first successful authentication with the next one promotes it and forgets
 * the old one. The pending window is bounded by ROTATION_GRACE_MS.
 */
export const ROTATION_GRACE_MS = 72 * 60 * 60 * 1000;

/** A hash no 64-digit sha256 can equal: a revoked node authenticates with nothing. */
export const REVOKED_PREFIX = 'revoked:';

export interface CredentialRecord {
  readonly currentHash: string;
  readonly nextHash: string | null;
  /** Set by an admin; refreshed when the node posts its next hash. Null when idle. */
  readonly rotateRequestedAt: Date | null;
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** What the API and the dashboard may show: never a hash. */
export interface CredentialStatus {
  readonly rotateRequestedAt: Date | null;
  /** The node has posted a next secret that the controller already accepts. */
  readonly rotationPending: boolean;
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
}

export type SecretMatch = 'current' | 'next' | 'none';

/** The next hash is honoured only while a rotation is in flight and inside the grace window. */
export function nextIsLive(record: CredentialRecord, now: Date): boolean {
  return (
    record.nextHash !== null &&
    record.rotateRequestedAt !== null &&
    now.getTime() - record.rotateRequestedAt.getTime() <= ROTATION_GRACE_MS
  );
}

/** Both comparisons always run, in constant time. A revoked node matches nothing. */
export function matchSecret(
  record: CredentialRecord,
  presentedHash: string,
  now: Date
): SecretMatch {
  if (record.revokedAt !== null) return 'none';
  const current = safeEqual(presentedHash, record.currentHash);
  const next =
    record.nextHash !== null && nextIsLive(record, now)
      ? safeEqual(presentedHash, record.nextHash)
      : false;
  if (current) return 'current';
  return next ? 'next' : 'none';
}

export function statusOf(
  record: CredentialRecord,
  now: Date
): CredentialStatus {
  return {
    rotateRequestedAt: record.rotateRequestedAt,
    rotationPending: nextIsLive(record, now),
    rotatedAt: record.rotatedAt,
    revokedAt: record.revokedAt,
  };
}

/** Whether the heartbeat tells the node to rotate: requested, not revoked. */
export function rotationWanted(record: CredentialRecord): boolean {
  return record.rotateRequestedAt !== null && record.revokedAt === null;
}

export type RequestOutcome =
  | {
      readonly ok: true;
      readonly record: CredentialRecord;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: 'revoked' };

/** Idempotent: asking again while a rotation is in flight changes nothing. */
export function requestRotation(
  record: CredentialRecord,
  now: Date
): RequestOutcome {
  if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
  const inFlight = record.rotateRequestedAt !== null;
  const stale = record.nextHash !== null && !nextIsLive(record, now);
  if (inFlight && !stale) return { ok: true, record, changed: false };
  return {
    ok: true,
    changed: true,
    record: { ...record, rotateRequestedAt: now, nextHash: null },
  };
}

export type AcceptOutcome =
  | {
      readonly ok: true;
      readonly record: CredentialRecord;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'revoked' | 'not_requested' | 'same_secret';
    };

/**
 * The node, authenticated with its current secret, offers the hash of its
 * next one. Re-sending the same hash is a no-op; a different one replaces it,
 * which is safe because a node that held the old next secret would already
 * have authenticated with it and been promoted.
 */
export function acceptNext(
  record: CredentialRecord,
  nextHash: string,
  now: Date
): AcceptOutcome {
  if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (record.rotateRequestedAt === null)
    return { ok: false, reason: 'not_requested' };
  if (safeEqual(nextHash, record.currentHash))
    return { ok: false, reason: 'same_secret' };
  const same =
    record.nextHash !== null &&
    safeEqual(nextHash, record.nextHash) &&
    nextIsLive(record, now);
  if (same) return { ok: true, record, changed: false };
  return {
    ok: true,
    changed: true,
    record: { ...record, nextHash, rotateRequestedAt: now },
  };
}

/** The first authentication with the next secret makes it the only one. */
export function promote(record: CredentialRecord, now: Date): CredentialRecord {
  if (record.nextHash === null) return record;
  return {
    currentHash: record.nextHash,
    nextHash: null,
    rotateRequestedAt: null,
    rotatedAt: now,
    revokedAt: null,
  };
}

/** Replaces the secret hash with an unusable value; `random` makes it unguessable and unique. */
export function revoke(
  record: CredentialRecord,
  now: Date,
  random: string
): CredentialRecord {
  return {
    currentHash: `${REVOKED_PREFIX}${random}`,
    nextHash: null,
    rotateRequestedAt: null,
    rotatedAt: record.rotatedAt,
    revokedAt: now,
  };
}

/** A fresh registration brings its own secret: any pending rotation or revocation is over. */
export function registered(
  record: CredentialRecord,
  newHash: string
): CredentialRecord {
  return {
    ...record,
    currentHash: newHash,
    nextHash: null,
    rotateRequestedAt: null,
    revokedAt: null,
  };
}

/** The shape a node posts; the hash only, never the secret. */
export const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The outcome of a credential operation; `changed` is false for an idempotent repeat. */
export type CredentialResult<Reason extends string = never> =
  | {
      readonly ok: true;
      readonly status: CredentialStatus;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: Reason | 'unknown_node' };
