import type { Role } from '../types';

import { safeEqual, sha256Hex } from './hash';

/** One `FLEET_ENROLLMENT_TOKENS` entry: the token's sha256 and the role it assigns. */
export interface EnrollmentTokenEntry {
  readonly sha256: string;
  /** Assigned when the node has no role yet; null approves without assigning. */
  readonly role: Role | null;
}

export const ENROLLMENT_TOKEN_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;
const NO_HASH = '0'.repeat(64);

/**
 * The entry whose hash matches `token`, else null. Every entry is compared
 * (plus one dummy when there are none) with no early exit, so the time taken
 * does not reveal how many tokens are configured or which one matched.
 */
export function matchEnrollmentToken(
  entries: readonly EnrollmentTokenEntry[],
  token: string | undefined
): EnrollmentTokenEntry | null {
  const wellFormed =
    typeof token === 'string' && ENROLLMENT_TOKEN_PATTERN.test(token);
  const found = compareAll(entries, sha256Hex(wellFormed ? token : ''));
  return wellFormed ? found : null;
}

/** Compares the digest with every entry; the first match wins, nothing exits early. */
function compareAll(
  entries: readonly EnrollmentTokenEntry[],
  digest: string
): EnrollmentTokenEntry | null {
  const candidates = entries.length > 0 ? entries : [{ sha256: NO_HASH }];
  let found: EnrollmentTokenEntry | null = null;
  for (const entry of candidates) {
    const same = safeEqual(digest, entry.sha256);
    if (same && 'role' in entry && found === null) found = entry;
  }
  return found;
}
