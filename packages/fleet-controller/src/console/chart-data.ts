import type { HeartbeatPoint } from '../types';
import { bucketizeWindow } from '../ui/lib/series';
import {
  memoryPressure,
  peakDiskBusy,
  peakGpuTemperature,
  peakGpuUtilization,
  peakPower,
  peakTemperature,
} from '../ui/lib/telemetry';

export interface ChartPoint {
  time: string;
  load: number | null;
  memory: number | null;
  disk: number | null;
  busy: number | null;
  cpu: number | null;
  temperature: number | null;
  power: number | null;
  gpuUtilization: number | null;
  gpuTemperature: number | null;
  diskBusy: number | null;
  memoryPressure: number | null;
}
type Picker = (point: HeartbeatPoint) => number | null;

/** Each charted series and how to read it from a history point. */
const SERIES: Record<Exclude<keyof ChartPoint, 'time'>, Picker> = {
  load: (point) => point.load1,
  memory: (point) => point.memUsedPercent,
  disk: (point) => point.diskPercent,
  busy: (point) => point.busySlots,
  cpu: (point) => point.telemetry?.cpuUsagePercent ?? null,
  temperature: (point) => peakTemperature(point.telemetry),
  power: (point) => peakPower(point.telemetry),
  gpuUtilization: (point) => peakGpuUtilization(point.telemetry),
  gpuTemperature: (point) => peakGpuTemperature(point.telemetry),
  diskBusy: (point) => peakDiskBusy(point.telemetry),
  memoryPressure: (point) => memoryPressure(point.telemetry),
};

/**
 * Bucketed chart rows over the last `windowHours` (24 by default). An unknown
 * value stays null, so a gap is a gap and never a zero.
 */
export function chartData(
  points: readonly HeartbeatPoint[],
  now: Date,
  windowHours = 24
): ChartPoint[] {
  const keys = Object.keys(SERIES) as (keyof typeof SERIES)[];
  const columns = Object.fromEntries(
    keys.map((key) => [
      key,
      bucketizeWindow(points, SERIES[key], { end: now, windowHours }),
    ])
  ) as Record<keyof typeof SERIES, ReturnType<typeof bucketizeWindow>>;
  return columns.load.map((bucket, index) => ({
    time: new Date(bucket.start).toLocaleString(
      [],
      windowHours <= 24
        ? { hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: '2-digit' }
    ),
    ...(Object.fromEntries(
      keys.map((key) => [key, columns[key][index]?.value ?? null])
    ) as Record<keyof typeof SERIES, number | null>),
  }));
}
