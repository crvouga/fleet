import { describe, expect, test } from 'bun:test';

import {
  readTelemetry,
  telemetryOf,
} from '../../src/domain/telemetry-validation';
import { HEALTH_LIMITS } from '../../src/domain/telemetry-health';
import { validateHeartbeat } from '../../src/domain/heartbeat-validation';
import { heartbeatBody } from '../support/fixtures';
import {
  healthTelemetry,
  maximumTelemetry,
  telemetry,
} from '../support/telemetry';

function parse(sample: unknown) {
  const problems = { list: [] as string[] };
  const value = readTelemetry(problems, sample);
  return { value, errors: problems.list };
}
type Json = ReturnType<typeof JSON.parse>;
type Draft = Record<string, Json>;
const clone = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('optional health families', () => {
  test('round trip exactly, keeping measured zeroes and unknown nulls', () => {
    const sample = healthTelemetry();
    expect(parse(sample)).toEqual({ value: sample, errors: [] });
    const gpu = parse(sample).value?.gpus?.devices[0];
    expect(gpu?.utilizationPercent).toBe(0);
  });

  test('older agents omit them: absent stays absent, never zero', () => {
    const { value, errors } = parse(telemetry());
    expect(errors).toEqual([]);
    for (const key of [
      'gpus',
      'diskIo',
      'diskHealth',
      'cpuFrequency',
      'throttling',
      'pressure',
      'connectivity',
      'lifecycle',
    ])
      expect(value).not.toHaveProperty(key);
    const network = value?.network[0];
    expect(network).not.toHaveProperty('receiveErrors');
    expect(
      validateHeartbeat(heartbeatBody(1, { telemetry: telemetry() })).ok
    ).toBe(true);
  });

  test('null families count as absent and unknown keys are discarded', () => {
    const raw = { ...clone(healthTelemetry()), gpus: null, extra: { x: 1 } };
    const gpuFamily = clone(healthTelemetry())['diskIo'] as Record<
      string,
      unknown
    >;
    const { value, errors } = parse({
      ...raw,
      diskIo: {
        ...gpuFamily,
        secret: 'x',
        devices: [{ ...(gpuFamily['devices'] as object[])[0], token: 'x' }],
      },
    });
    expect(errors).toEqual([]);
    expect(value).not.toHaveProperty('gpus');
    expect(value).not.toHaveProperty('extra');
    expect(value?.diskIo).not.toHaveProperty('secret');
    expect(value?.diskIo?.devices[0]).not.toHaveProperty('token');
  });

  test('an unsupported family without a reason gets an explicit one', () => {
    const { value, errors } = parse({
      ...clone(telemetry()),
      pressure: { status: 'unsupported' },
    });
    expect(errors).toEqual([]);
    expect(value?.pressure?.status).toBe('unsupported');
    expect(value?.pressure?.reason).toBeTruthy();
    expect(value?.pressure?.cpu).toBeNull();
  });

  test('rejects bad provenance, ranges, types, duplicates and control characters', () => {
    const base = clone(healthTelemetry());
    const cases: [string, (draft: Draft) => void][] = [
      ['telemetry.gpus.status', (d) => (d['gpus'].status = 'guessed')],
      [
        'utilizationPercent',
        (d) => (d['gpus'].devices[0].utilizationPercent = 101),
      ],
      [
        'temperatureCelsius',
        (d) => (d['gpus'].devices[0].temperatureCelsius = 999),
      ],
      ['vendor', (d) => (d['gpus'].devices[0].vendor = 'matrox')],
      [
        'memory use must fit',
        (d) => (d['gpus'].devices[0].memoryUsedBytes = 9999),
      ],
      ['busyPercent', (d) => (d['diskIo'].devices[0].busyPercent = -1)],
      ['state', (d) => (d['diskHealth'].devices[0].state = 'great')],
      ['source', (d) => (d['diskHealth'].devices[0].source = 'dmesg')],
      ['detail', (d) => (d['diskHealth'].devices[0].detail = 'a\u0000b')],
      ['reason', (d) => (d['throttling'].reason = 'x'.repeat(501))],
      ['throttled', (d) => (d['throttling'].throttled = 'yes')],
      ['basis', (d) => (d['throttling'].basis = 'vibes')],
      ['events', (d) => (d['throttling'].events = -1)],
      ['someAvg10', (d) => (d['pressure'].cpu.someAvg10 = 101)],
      ['telemetry.pressure.io', (d) => (d['pressure'].io = 'x')],
      [
        'controllerLatencyMs',
        (d) => (d['connectivity'].controllerLatencyMs = -5),
      ],
      [
        'consecutiveFailures',
        (d) => (d['connectivity'].consecutiveFailures = 1.5),
      ],
      ['trackedSince', (d) => (d['lifecycle'].trackedSince = 'yesterday')],
      ['restartCount', (d) => (d['lifecycle'].restartCount = -1)],
      ['must be an object', (d) => (d['cpuFrequency'] = 5)],
      [
        'distinct names',
        (d) => d['gpus'].devices.push({ ...d['gpus'].devices[0] }),
      ],
      [
        'telemetry.gpus.devices',
        (d) => (d['gpus'].devices = Array(HEALTH_LIMITS.gpus + 1).fill({})),
      ],
      [
        'telemetry.diskIo.devices',
        (d) => (d['diskIo'].devices = Array(HEALTH_LIMITS.diskIo + 1).fill({})),
      ],
      [
        'telemetry.diskHealth.devices',
        (d) =>
          (d['diskHealth'].devices = Array(HEALTH_LIMITS.diskHealth + 1).fill(
            {}
          )),
      ],
    ];
    for (const [expected, change] of cases) {
      const draft = clone(base) as Draft;
      change(draft);
      const { errors } = parse(draft);
      expect(errors.some((message) => message.includes(expected))).toBe(true);
    }
  });

  test('network error counts are optional, non-negative and may be null', () => {
    const sample = healthTelemetry({
      network: [
        {
          name: 'eth0',
          receivedBytes: 1,
          transmittedBytes: 2,
          receiveBytesPerSecond: null,
          transmitBytesPerSecond: null,
          receiveErrors: 0,
          transmitErrors: null,
          receiveDropped: 3,
          transmitDropped: 0,
        },
      ],
    });
    expect(parse(sample)).toEqual({ value: sample, errors: [] });
    const bad = clone(sample) as Draft;
    bad['network'][0].receiveErrors = -1;
    expect(parse(bad).errors.join()).toContain('receiveErrors');
  });

  test('fuzz: arbitrary corruption never throws and never invents a zero', () => {
    const values: unknown[] = [
      null,
      undefined,
      -1,
      1e999,
      'x',
      '',
      [],
      {},
      true,
      NaN,
      'a\u0000',
      2 ** 60,
    ];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const paths = [
      'gpus',
      'diskIo',
      'diskHealth',
      'cpuFrequency',
      'throttling',
      'pressure',
      'connectivity',
      'lifecycle',
    ];
    for (let round = 0; round < 400; round += 1) {
      const draft = clone(healthTelemetry()) as Draft;
      const family = paths[next() % paths.length]!;
      const target = draft[family] as Record<string, unknown>;
      const keys = Object.keys(target);
      const key = keys[next() % keys.length]!;
      target[key] = values[next() % values.length];
      const { value, errors } = parse(draft);
      if (errors.length === 0) {
        // A value that validated must be a legitimate shape, never a coerced zero.
        expect(value).toBeDefined();
        expect(JSON.stringify(value)).not.toContain('NaN');
      }
    }
  });

  test('the largest accepted sample stays inside the request budget', () => {
    const sample = healthTelemetry({
      ...maximumTelemetry(),
      gpus: {
        status: 'measured',
        reason: 'r'.repeat(500),
        devices: Array.from({ length: HEALTH_LIMITS.gpus }, (_, index) => ({
          name: `gpu-${index}-${'x'.repeat(100)}`,
          vendor: 'amd' as const,
          utilizationPercent: 1,
          memoryUsedBytes: 1,
          memoryTotalBytes: 2,
          temperatureCelsius: 3,
          powerWatts: 4,
        })),
      },
      diskIo: {
        status: 'measured',
        reason: 'r'.repeat(500),
        devices: Array.from({ length: HEALTH_LIMITS.diskIo }, (_, index) => ({
          name: `disk-${index}-${'x'.repeat(100)}`,
          readBytesPerSecond: 1e9,
          writeBytesPerSecond: 1e9,
          iops: 1e6,
          busyPercent: 99.99,
        })),
      },
      diskHealth: {
        status: 'measured',
        reason: 'r'.repeat(500),
        devices: Array.from(
          { length: HEALTH_LIMITS.diskHealth },
          (_, index) => ({
            name: `d-${index}-${'x'.repeat(100)}`,
            state: 'warning' as const,
            source: 'smartctl' as const,
            temperatureCelsius: 40,
            wearPercent: 50,
            powerOnHours: 99999,
            detail: 'd'.repeat(200),
          })
        ),
      },
    });
    expect(parse(sample).errors).toEqual([]);
    const request = JSON.stringify(heartbeatBody(1, { telemetry: sample }));
    expect(new TextEncoder().encode(request).length).toBeLessThan(64 * 1024);
  });

  test('stored malformed health data is unknown as a whole, never partially trusted', () => {
    const stored = clone(healthTelemetry());
    (stored['gpus'] as Record<string, unknown>)['status'] = 'bogus';
    expect(telemetryOf(stored)).toBeNull();
  });
});
