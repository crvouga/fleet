/** How long heartbeat history is kept: operator-configurable, bounded, never silently clamped. */
export const DEFAULT_HEARTBEAT_RETENTION_DAYS = 30;
export const MIN_HEARTBEAT_RETENTION_DAYS = 1;
export const MAX_HEARTBEAT_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_HEARTBEAT_RETENTION_MS =
  DEFAULT_HEARTBEAT_RETENTION_DAYS * DAY_MS;

export function retentionMs(days: number | undefined): number {
  const value = days ?? DEFAULT_HEARTBEAT_RETENTION_DAYS;
  const bounded =
    Number.isInteger(value) &&
    value >= MIN_HEARTBEAT_RETENTION_DAYS &&
    value <= MAX_HEARTBEAT_RETENTION_DAYS
      ? value
      : DEFAULT_HEARTBEAT_RETENTION_DAYS;
  return bounded * DAY_MS;
}

/**
 * FLEET_HEARTBEAT_RETENTION_DAYS: whole days from 1 to 365, default 30. Events,
 * settings history and the audit log are not pruned by it. The message names the
 * variable, never its value.
 */
export function readHeartbeatRetentionDays(
  source: Readonly<Record<string, string | undefined>>,
  problems: string[]
): { heartbeatRetentionDays?: number } {
  const raw = source['FLEET_HEARTBEAT_RETENTION_DAYS']?.trim();
  if (raw === undefined || raw === '') return {};
  const days = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    days >= MIN_HEARTBEAT_RETENTION_DAYS &&
    days <= MAX_HEARTBEAT_RETENTION_DAYS
  )
    return { heartbeatRetentionDays: days };
  problems.push(
    `FLEET_HEARTBEAT_RETENTION_DAYS must be a whole number of days from ${MIN_HEARTBEAT_RETENTION_DAYS} to ${MAX_HEARTBEAT_RETENTION_DAYS} (default ${DEFAULT_HEARTBEAT_RETENTION_DAYS})`
  );
  return {};
}
