import type { HeartbeatPoint } from '../types';
import { bucketize } from '../ui/lib/series';
import { peakTemperature, peakPower } from '../ui/lib/telemetry';

export interface ChartPoint {
  time: string;
  load: number | null;
  memory: number | null;
  disk: number | null;
  busy: number | null;
  cpu: number | null;
  temperature: number | null;
  power: number | null;
}
export function chartData(
  points: readonly HeartbeatPoint[],
  now: Date
): ChartPoint[] {
  const load = bucketize(points, (point) => point.load1, now);
  const memory = bucketize(points, (point) => point.memUsedPercent, now);
  const disk = bucketize(points, (point) => point.diskPercent, now);
  const busy = bucketize(points, (point) => point.busySlots, now);
  const cpu = bucketize(
    points,
    (point) => point.telemetry?.cpuUsagePercent ?? null,
    now
  );
  const temperature = bucketize(
    points,
    (point) => peakTemperature(point.telemetry),
    now
  );
  const power = bucketize(points, (point) => peakPower(point.telemetry), now);
  return load.map((bucket, index) => ({
    time: new Date(bucket.start).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    load: bucket.value,
    memory: bucketValue(memory, index),
    disk: bucketValue(disk, index),
    busy: bucketValue(busy, index),
    cpu: bucketValue(cpu, index),
    temperature: bucketValue(temperature, index),
    power: bucketValue(power, index),
  }));
}

function bucketValue(
  buckets: readonly { value: number | null }[],
  index: number
): number | null {
  return buckets[index]?.value ?? null;
}
