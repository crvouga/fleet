import { expect, test } from 'bun:test';

import {
  boundedHistory,
  compactTelemetry,
  MAX_HISTORY_POINTS,
} from '../../src/domain/heartbeat-history';
import { telemetryOf } from '../../src/domain/telemetry-validation';
import {
  memoryPressure,
  peakDiskBusy,
  peakGpuTemperature,
  peakGpuUtilization,
} from '../../src/ui/lib/telemetry';
import type { HeartbeatPoint } from '../../src/types';
import { healthTelemetry } from '../support/telemetry';

const gpu = (name: string, util: number | null, temp: number | null) => ({
  name,
  vendor: 'nvidia' as const,
  utilizationPercent: util,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  temperatureCelsius: temp,
  powerWatts: null,
});

test('history keeps the busiest and hottest GPU, the busiest disk and the pressure averages', () => {
  const sample = healthTelemetry({
    gpus: {
      status: 'measured',
      reason: null,
      devices: [gpu('a', 10, 90), gpu('b', 80, 50), gpu('c', 5, 40)],
    },
    diskIo: {
      status: 'measured',
      reason: null,
      devices: [
        {
          name: 'sda',
          readBytesPerSecond: 1,
          writeBytesPerSecond: 1,
          iops: 1,
          busyPercent: 5,
        },
        {
          name: 'sdb',
          readBytesPerSecond: null,
          writeBytesPerSecond: null,
          iops: null,
          busyPercent: 70,
        },
      ],
    },
  });
  const compact = compactTelemetry(sample);
  expect(compact.gpus?.devices.map((device) => device.name).sort()).toEqual([
    'a',
    'b',
  ]);
  expect(peakGpuUtilization(compact)).toBe(80);
  expect(peakGpuTemperature(compact)).toBe(90);
  expect(compact.diskIo?.devices.map((device) => device.name)).toEqual(['sdb']);
  expect(peakDiskBusy(compact)).toBe(70);
  expect(compact.pressure).toEqual(sample.pressure!);
  expect(memoryPressure(compact)).toBe(0);
  for (const key of [
    'diskHealth',
    'cpuFrequency',
    'throttling',
    'connectivity',
    'lifecycle',
  ] as const)
    expect(compact).not.toHaveProperty(key);
});

test('compaction is idempotent and the summary is itself valid telemetry', () => {
  const once = compactTelemetry(healthTelemetry());
  expect(compactTelemetry(once)).toEqual(once);
  expect(telemetryOf(JSON.parse(JSON.stringify(once)))).toEqual(once);
  expect(JSON.stringify(once).length).toBeLessThan(2500);
});

test('unsupported families and unknown values leave gaps, never zeroes', () => {
  const sample = healthTelemetry({
    gpus: { status: 'unsupported', reason: 'No GPU', devices: [] },
    diskIo: { status: 'unsupported', reason: 'No disks', devices: [] },
    pressure: {
      status: 'unsupported',
      reason: 'No PSI',
      cpu: null,
      memory: null,
      io: null,
    },
  });
  const compact = compactTelemetry(sample);
  expect(compact).not.toHaveProperty('gpus');
  expect(compact).not.toHaveProperty('diskIo');
  expect(compact).not.toHaveProperty('pressure');
  expect(peakGpuUtilization(compact)).toBeNull();
  expect(peakDiskBusy(compact)).toBeNull();
  expect(memoryPressure(compact)).toBeNull();
  const blank = healthTelemetry({
    gpus: { status: 'measured', reason: null, devices: [gpu('x', null, null)] },
  });
  expect(peakGpuUtilization(compactTelemetry(blank))).toBeNull();
  expect(peakGpuTemperature(compactTelemetry(blank))).toBeNull();
});

test('older points without health data still compact and chart as unknown', () => {
  const legacy = compactTelemetry(
    healthTelemetry({ gpus: undefined } as never)
  );
  expect(peakGpuUtilization(legacy)).toBeNull();
  expect(memoryPressure(null)).toBeNull();
});

test('the response cap of 1,440 points still holds with the new series', () => {
  const start = new Date('2026-10-14T00:00:00Z');
  const points: HeartbeatPoint[] = Array.from(
    { length: MAX_HISTORY_POINTS * 5 },
    (_, index) => ({
      at: new Date(start.getTime() + index * 15_000),
      uptimeSeconds: null,
      load1: null,
      memUsedPercent: null,
      diskPercent: null,
      slots: null,
      busySlots: null,
      telemetry: healthTelemetry(),
    })
  );
  const result = boundedHistory(points, start);
  expect(result.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS);
  expect(result.every((point) => point.telemetry?.logs.length === 0)).toBe(
    true
  );
  expect(
    result.every((point) => point.telemetry?.gpus?.devices.length === 1)
  ).toBe(true);
});
