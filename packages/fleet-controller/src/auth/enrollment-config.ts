import { isActiveRole } from '../types';

import type { EnrollmentTokenEntry } from './enrollment-token';

type EnvSource = Readonly<Record<string, string | undefined>>;

const KEY = 'FLEET_ENROLLMENT_TOKENS';
const MAX_ENTRIES = 16;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function entryOf(
  value: unknown,
  index: number,
  problems: string[]
): EnrollmentTokenEntry | null {
  const where = `${KEY}[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${where} must be an object { "sha256", "role" }`);
    return null;
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== 'sha256' && key !== 'role'
  );
  if (unknown.length > 0)
    problems.push(`${where} may only have the keys sha256 and role`);
  const hash = record['sha256'];
  const role = record['role'] ?? null;
  if (typeof hash !== 'string' || !SHA256_HEX.test(hash.toLowerCase())) {
    problems.push(`${where}.sha256 must be 64 hex characters`);
    return null;
  }
  if (role !== null && !isActiveRole(role)) {
    problems.push(`${where}.role must be an active role or null`);
    return null;
  }
  return { sha256: hash.toLowerCase(), role };
}

/**
 * `FLEET_ENROLLMENT_TOKENS`: a JSON array of `{ sha256, role }`, default `[]`.
 * The retired `FLEET_ROLE_TOKEN_HASHES` refuses startup and names the
 * replacement. Problems name variables, never values.
 */
export function readEnrollmentTokens(
  source: EnvSource,
  problems: string[]
): readonly EnrollmentTokenEntry[] {
  const legacy = source['FLEET_ROLE_TOKEN_HASHES'];
  if (typeof legacy === 'string' && legacy.trim().length > 0)
    problems.push(
      `FLEET_ROLE_TOKEN_HASHES is no longer supported; move each hash to ${KEY} as { "sha256": "<hash>", "role": "<role>" } and unset it`
    );
  const raw = source[KEY]?.trim() ?? '';
  if (raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    problems.push(`${KEY} must be a JSON array of { "sha256", "role" }`);
    return [];
  }
  if (parsed.length > MAX_ENTRIES) {
    problems.push(`${KEY} may have at most ${MAX_ENTRIES} entries`);
    return [];
  }
  const entries = parsed
    .map((value, index) => entryOf(value, index, problems))
    .filter((entry): entry is EnrollmentTokenEntry => entry !== null);
  if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length)
    problems.push(`${KEY} has the same sha256 more than once`);
  return entries;
}
