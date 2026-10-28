import { DEFAULT_TIMING, type OwnershipTiming } from './acquire';

type Source = Readonly<Record<string, string | undefined>>;

function seconds(
  source: Source,
  key: string,
  range: readonly [number, number],
  problems: string[]
): number | undefined {
  const raw = source[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= range[0] && value <= range[1])
    return value * 1000;
  problems.push(
    `${key} must be an integer from ${range[0]} to ${range[1]} seconds`
  );
  return undefined;
}

/**
 * Optional tuning of writer ownership. The holder fences itself at two thirds
 * of the expiry, timed from before its last successful request, so at least
 * five seconds separate fencing from the earliest possible takeover.
 */
export function readOwnershipTiming(
  source: Source,
  problems: string[]
): OwnershipTiming {
  const renewMs =
    seconds(source, 'FLEET_OWNERSHIP_RENEW_SECONDS', [1, 60], problems) ??
    DEFAULT_TIMING.renewMs;
  const expireMs =
    seconds(source, 'FLEET_OWNERSHIP_EXPIRE_SECONDS', [15, 600], problems) ??
    DEFAULT_TIMING.expireMs;
  if (expireMs < renewMs * 6)
    problems.push(
      'FLEET_OWNERSHIP_EXPIRE_SECONDS must be at least six times FLEET_OWNERSHIP_RENEW_SECONDS'
    );
  return {
    renewMs,
    expireMs,
    fenceMs: Math.floor((expireMs * 2) / 3),
    pollMs: Math.min(DEFAULT_TIMING.pollMs, renewMs),
  };
}
