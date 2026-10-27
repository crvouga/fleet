import type { AppEnv } from '../deps';
import type { Role } from '../types';

import { safeEqual, sha256Hex } from './hash';

const MAX_TOKEN_LENGTH = 512;
const NO_HASH = '0'.repeat(64);

/**
 * True when `token` is the shared token for `role`. The comparison runs even
 * when the role has no token so the time taken does not reveal which roles
 * are configured.
 */
export function roleTokenValid(
  hashes: AppEnv['roleTokenHashes'],
  role: Role,
  token: string | undefined
): boolean {
  const expected = hashes[role];
  const presented = typeof token === 'string' ? token : '';
  const same = safeEqual(sha256Hex(presented), expected ?? NO_HASH);
  return (
    same &&
    expected !== undefined &&
    presented.length > 0 &&
    presented.length <= MAX_TOKEN_LENGTH
  );
}
