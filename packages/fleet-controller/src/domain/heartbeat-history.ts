import type { Telemetry } from '../telemetry';
import type { HeartbeatPoint } from '../types';

/** About one sample/minute over a day, even when an agent reports every 5s. */
export const MAX_HISTORY_POINTS = 1440;

function largest<T>(
  values: readonly T[],
  measure: (value: T) => number
): T | null {
  return values.reduce<T | null>(
    (best, value) =>
      best === null || measure(value) > measure(best) ? value : best,
    null
  );
}

/** History is a chart summary, never a repeated archive of logs/job metadata. */
export function compactTelemetry(sample: Telemetry): Telemetry {
  const temperature = largest(sample.temperatures, (item) => item.celsius);
  const power = largest(sample.power, (item) => item.watts);
  return {
    sampledAt: sample.sampledAt,
    cpuUsagePercent: sample.cpuUsagePercent,
    temperatures: temperature ? [{ ...temperature }] : [],
    power: power ? [{ ...power }] : [],
    filesystems: [],
    swap: null,
    network: [],
    runnerSlots: [],
    logs: [],
    issues: [],
  };
}

export function boundedHistory(
  points: readonly HeartbeatPoint[],
  since: Date
): HeartbeatPoint[] {
  const ordered = points
    .map((point) => ({
      ...point,
      ...(point.telemetry
        ? { telemetry: compactTelemetry(point.telemetry) }
        : {}),
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (ordered.length <= MAX_HISTORY_POINTS) return ordered;
  const latest = ordered.at(-1)!.at.getTime();
  const width = Math.max(
    1000,
    (latest - since.getTime()) / (MAX_HISTORY_POINTS - 1)
  );
  const buckets = new Map<number, HeartbeatPoint>();
  for (const point of ordered)
    buckets.set(
      Math.floor((point.at.getTime() - since.getTime()) / width),
      point
    );
  return [...buckets.values()];
}
