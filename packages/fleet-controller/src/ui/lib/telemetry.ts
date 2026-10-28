import { sampleIsFresh } from '../../domain/telemetry-validation';
import type { PressureSample, Provenance, Telemetry } from '../../telemetry';
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

/** What a badge says: a stale sample never claims to be a current measurement. */
export type ProvenanceBadge = Provenance | 'stale';
export function provenanceBadge(
  status: Provenance,
  stale: boolean
): ProvenanceBadge {
  if (status === 'unsupported') return 'unsupported';
  return stale ? 'stale' : status;
}
/** A value known to be a number, with its unit; null is unknown, never "0". */
export function measured(
  value: number | null | undefined,
  unit: string,
  digits = 1
): string {
  return value === null || value === undefined
    ? 'Unavailable'
    : `${Number.isInteger(value) ? value : value.toFixed(digits)}${unit}`;
}
export function perSecond(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'Unavailable'
    : `${bytes(value)}/s`;
}
function peakOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.max(...known) : null;
}
export function peakGpuUtilization(sample?: Telemetry | null): number | null {
  const gpus = sample?.gpus;
  return gpus && gpus.status !== 'unsupported'
    ? peakOf(gpus.devices.map((item) => item.utilizationPercent))
    : null;
}
export function peakGpuTemperature(sample?: Telemetry | null): number | null {
  const gpus = sample?.gpus;
  return gpus && gpus.status !== 'unsupported'
    ? peakOf(gpus.devices.map((item) => item.temperatureCelsius))
    : null;
}
export function peakDiskBusy(sample?: Telemetry | null): number | null {
  const disks = sample?.diskIo;
  return disks && disks.status !== 'unsupported'
    ? peakOf(disks.devices.map((item) => item.busyPercent))
    : null;
}
/** PSI "some" over 60 s: the share of time at least one task stalled on memory. */
export function memoryPressure(sample?: Telemetry | null): number | null {
  const line: PressureSample | null | undefined = sample?.pressure?.memory;
  return sample?.pressure?.status === 'unsupported'
    ? null
    : (line?.someAvg60 ?? null);
}
