import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { LeaseState } from './lease';

/** Names the status file the supervisor shares with the worker; set only under the supervisor. */
export const OWNERSHIP_STATUS_ENV = 'FLEET_OWNERSHIP_STATUS_FILE';

/** What the supervisor knows about ownership; the worker serves it to monitoring. */
export interface OwnershipStatus {
  readonly state: LeaseState;
  readonly generation: number;
  /** This instance's id: random per process, safe to expose. */
  readonly holder: string;
  /** Wall-clock ms of the last successful renewal. */
  readonly renewedAtWall: number;
  /** Wall-clock ms when the replica was last known to hold everything the database committed; null before the first sync. */
  readonly lastSyncAtWall: number | null;
  /** The authoritative replica generation recorded in object storage; null before the first renewal. */
  readonly replicaGeneration: number | null;
}

/** Supervisor side: atomically replaces the status file (never partially written). */
export function writeOwnershipStatus(
  path: string,
  status: OwnershipStatus
): void {
  const temporary = `${path}.next`;
  writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
  renameSync(temporary, path);
}

const STATES: readonly string[] = ['held', 'handover', 'lost'];
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCountOrNull = (value: unknown): value is number | null =>
  value === null || isCount(value);

function isStatusShape(record: Record<string, unknown>): boolean {
  const { state, holder } = record;
  return (
    typeof state === 'string' &&
    STATES.includes(state) &&
    typeof holder === 'string' &&
    holder.length > 0 &&
    isCount(record['generation']) &&
    isCount(record['renewedAtWall']) &&
    isCountOrNull(record['lastSyncAtWall']) &&
    isCountOrNull(record['replicaGeneration'])
  );
}

/** Null for anything that is not a complete status: never guess a state. */
export function parseOwnershipStatus(text: string): OwnershipStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isStatusShape(record)) return null;
  return {
    state: record['state'] as LeaseState,
    generation: record['generation'] as number,
    holder: record['holder'] as string,
    renewedAtWall: record['renewedAtWall'] as number,
    lastSyncAtWall: record['lastSyncAtWall'] as number | null,
    replicaGeneration: record['replicaGeneration'] as number | null,
  };
}

/** What a reader sees: not supervised, supervised with no readable status, or the status. */
export type OwnershipView =
  | { readonly supervised: false }
  | { readonly supervised: true; readonly status: OwnershipStatus | null };

const CACHE_MS = 1000;
const cache = new Map<string, { at: number; status: OwnershipStatus | null }>();

/** Forgets cached reads; tests that rewrite the file call it. */
export function resetOwnershipStatusCache(): void {
  cache.clear();
}

/**
 * Worker side: the supervisor's status, cached for a second. Absent unless
 * the process runs under the supervisor (tests, fixtures and dev have none).
 */
export function readOwnershipView(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => number = Date.now
): OwnershipView {
  const path = env[OWNERSHIP_STATUS_ENV];
  if (!path) return { supervised: false };
  const hit = cache.get(path);
  if (hit !== undefined && now() - hit.at < CACHE_MS && now() >= hit.at)
    return { supervised: true, status: hit.status };
  let status: OwnershipStatus | null = null;
  try {
    status = parseOwnershipStatus(readFileSync(path, 'utf8'));
  } catch {
    status = null;
  }
  cache.set(path, { at: now(), status });
  return { supervised: true, status };
}
