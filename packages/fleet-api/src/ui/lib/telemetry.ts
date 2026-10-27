import { sampleIsFresh } from '../../domain/telemetry-validation';
import type { Telemetry } from '../../telemetry';
import type { FleetEntry } from './fleet-data';

export function telemetryFresh(entry: FleetEntry, now: Date): boolean {
  return (
    entry.view.status === 'online' &&
    entry.facts.telemetry !== null &&
    sampleIsFresh(
      entry.facts.telemetry,
      now,
      entry.view.heartbeatIntervalSeconds
    )
  );
}
export function maxSample(values: readonly number[]): number | null {
  return values.length ? Math.max(...values) : null;
}
export function peakTemperature(sample?: Telemetry | null): number | null {
  return maxSample(sample?.temperatures.map((item) => item.celsius) ?? []);
}
export function peakPower(sample?: Telemetry | null): number | null {
  return maxSample(sample?.power.map((item) => item.watts) ?? []);
}
export function runLink(
  repository: string | null,
  runId: string | null
): string | null {
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !runId ||
    !/^[1-9][0-9]{0,19}$/.test(runId)
  )
    return null;
  const parts = repository.split('/');
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return `https://github.com/${parts.map(encodeURIComponent).join('/')}/actions/runs/${runId}`;
}
export function bytes(value: number | null): string {
  if (value === null) return 'Unavailable';
  if (value < 1024) return `${value} B`;
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
