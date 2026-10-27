import { expect, test } from 'bun:test';
import {
  boundedHistory,
  compactTelemetry,
  MAX_HISTORY_POINTS,
} from '../../src/domain/heartbeat-history';
import type { HeartbeatPoint } from '../../src/types';
import { maximumTelemetry } from '../support/telemetry';
import { telemetryOf } from '../../src/domain/telemetry-validation';

test('maximum telemetry collections produce a compact immutable metric summary', () => {
  const full = maximumTelemetry();
  expect(telemetryOf(full)).toEqual(full);
  expect(JSON.stringify(full).length).toBeGreaterThan(10_000);
  const compact = compactTelemetry(full);
  expect(JSON.stringify(compact).length).toBeLessThan(1200);
  expect(compact.temperatures).toEqual([full.temperatures.at(-1)!]);
  expect(compact.power).toEqual([full.power.at(-1)!]);
  for (const key of [
    'filesystems',
    'network',
    'runnerSlots',
    'logs',
    'issues',
  ] as const)
    expect(compact[key]).toEqual([]);
  expect(compact.swap).toBeNull();
  expect(compact.cpuUsagePercent).toBe(0);
  expect(full.logs).toHaveLength(40);
  expect(full.runnerSlots).toHaveLength(64);
});
test('high-frequency history keeps latest samples across the window without inventing reports in gaps', () => {
  const start = new Date('2026-10-14T00:00:00Z');
  const points: HeartbeatPoint[] = Array.from(
    { length: MAX_HISTORY_POINTS * 12 },
    (_, index) => ({
      at: new Date(start.getTime() + index * 5000),
      uptimeSeconds: null,
      load1: index,
      memUsedPercent: null,
      diskPercent: null,
      slots: null,
      busySlots: null,
    })
  ).filter(
    (point) => point.at.getUTCHours() < 4 || point.at.getUTCHours() >= 20
  );
  const result = boundedHistory(points, start);
  expect(result.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS);
  expect(result.at(-1)).toEqual(points.at(-1));
  expect(
    result.every(
      (point) => point.at.getUTCHours() < 4 || point.at.getUTCHours() >= 20
    )
  ).toBe(true);
  expect(result[0]!.at.getTime() - start.getTime()).toBeLessThan(61_000);
});
