import { safeEqual } from './hash';

export interface AdminTokens {
  readonly adminToken: string;
  /** The next admin token while rotating without downtime. Accepted alongside the current one. */
  readonly adminTokenNext?: string | undefined;
}

/**
 * True when `presented` equals the current or the next admin token. Both
 * comparisons always run, in constant time, so neither result leaks.
 */
export function matchesAdminToken(
  presented: string,
  tokens: AdminTokens
): boolean {
  const current = safeEqual(presented, tokens.adminToken);
  const next =
    tokens.adminTokenNext !== undefined && tokens.adminTokenNext.length > 0
      ? safeEqual(presented, tokens.adminTokenNext)
      : false;
  return current || next;
}
