type Source = Readonly<Record<string, string | undefined>>;

/**
 * Which old replica generations the current owner may delete. Both limits
 * must hold: a generation is removed only when it is older than the window
 * AND more than `keepGenerations` behind the current one.
 */
export interface RetentionPolicy {
  /** Previous generations always kept, in addition to the current one. */
  readonly keepGenerations: number;
  /** A generation younger than this (by its newest object) is never deleted. */
  readonly retainMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepGenerations: 2,
  retainMs: 7 * 24 * 60 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function integer(
  source: Source,
  key: string,
  range: readonly [number, number],
  problems: string[]
): number | undefined {
  const raw = source[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= range[0] && value <= range[1])
    return value;
  problems.push(`${key} must be an integer from ${range[0]} to ${range[1]}`);
  return undefined;
}

/** Optional tuning of old-generation cleanup; invalid values fail startup. */
export function readRetentionPolicy(
  source: Source,
  problems: string[]
): RetentionPolicy {
  const days = integer(
    source,
    'FLEET_OWNERSHIP_RETAIN_DAYS',
    [1, 365],
    problems
  );
  const keep = integer(
    source,
    'FLEET_OWNERSHIP_RETAIN_GENERATIONS',
    [1, 20],
    problems
  );
  return {
    keepGenerations: keep ?? DEFAULT_RETENTION.keepGenerations,
    retainMs: days === undefined ? DEFAULT_RETENTION.retainMs : days * DAY_MS,
  };
}
