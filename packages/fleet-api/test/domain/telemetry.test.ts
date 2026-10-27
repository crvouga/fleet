import { describe, expect, test } from 'bun:test';
import { validateHeartbeat } from '../../src/domain/heartbeat-validation';
import {
  readTelemetry,
  sampleIsFresh,
  telemetryOf,
} from '../../src/domain/telemetry-validation';
import { TELEMETRY_LIMITS } from '../../src/domain/telemetry-fields';
import { heartbeatBody } from '../support/fixtures';
import { telemetry } from '../support/telemetry';

function parse(sample: unknown) {
  const problems = { list: [] as string[] };
  const value = readTelemetry(problems, sample);
  return { value, errors: problems.list };
}
describe('bounded hardware telemetry', () => {
  test('round-trips measured zero and unavailable values with legacy heartbeats unchanged', () => {
    const sample = telemetry();
    expect(parse(sample)).toEqual({ value: sample, errors: [] });
    expect(validateHeartbeat(heartbeatBody(1, { telemetry: sample })).ok).toBe(
      true
    );
    expect(validateHeartbeat(heartbeatBody(1))).toEqual({
      ok: true,
      value: heartbeatBody(1),
    });
    expect(telemetryOf(undefined)).toBeNull();
  });
  test('rejects excessive lists before storing entries', () => {
    const sample = telemetry();
    for (const [key, limit] of Object.entries(TELEMETRY_LIMITS)) {
      const errors = parse({
        ...sample,
        [key]: Array(limit + 1).fill({}),
      }).errors;
      expect(
        errors.some((message) => message.includes(`telemetry.${key}`))
      ).toBe(true);
    }
  });
  test('rejects malformed timestamps, counters and impossible capacities', () => {
    expect(
      parse(telemetry({ sampledAt: '2026-02-30T12:00:00Z' })).errors
    ).not.toBeEmpty();
    expect(
      parse(telemetry({ sampledAt: '2026-10-14T12:00:00+00:00' })).errors
    ).not.toBeEmpty();
    expect(parse(telemetry({ cpuUsagePercent: 101 })).errors).not.toBeEmpty();
    expect(
      parse(
        telemetry({
          filesystems: [
            {
              mount: '/nix',
              totalBytes: 100,
              usedBytes: 60,
              availableBytes: 50,
            },
          ],
        })
      ).errors
    ).not.toBeEmpty();
    expect(
      parse(telemetry({ swap: { totalBytes: 1, usedBytes: 2 } })).errors
    ).not.toBeEmpty();
    expect(
      parse(
        telemetry({
          network: [
            {
              ...telemetry().network[0]!,
              receivedBytes: Number.MAX_SAFE_INTEGER + 1,
            },
          ],
        })
      ).errors
    ).not.toBeEmpty();
    expect(
      validateHeartbeat(heartbeatBody(1, { runners: { slots: 1, busy: 2 } })).ok
    ).toBe(false);
  });
  test('rejects ambiguous labels, unsafe run links and arbitrary diagnostic output', () => {
    const sample = telemetry();
    expect(
      parse({
        ...sample,
        runnerSlots: [{ ...sample.runnerSlots[0], slot: 'slot-65' }],
      }).errors
    ).not.toBeEmpty();
    expect(
      parse({ ...sample, power: [{ ...sample.power[0], source: 'estimate' }] })
        .errors
    ).not.toBeEmpty();
    expect(
      parse({
        ...sample,
        runnerSlots: [
          {
            ...sample.runnerSlots[0],
            repository: '../evil',
            runId: 'javascript:1',
          },
        ],
      }).errors
    ).not.toBeEmpty();
    expect(
      parse({
        ...sample,
        logs: [{ ...sample.logs[0], message: 'TOKEN=secret raw stdout' }],
      }).errors
    ).not.toBeEmpty();
    expect(
      parse({
        ...sample,
        temperatures: [sample.temperatures[0], sample.temperatures[0]],
      }).errors
    ).not.toBeEmpty();
    expect(
      parse({
        ...sample,
        runnerSlots: [
          { ...sample.runnerSlots[0], finishedAt: '2026-10-14T10:00:00Z' },
        ],
      }).errors
    ).not.toBeEmpty();
  });
  test('drops unknown telemetry keys and marks malformed stored facts unknown', () => {
    expect(
      JSON.stringify(
        parse({ ...telemetry(), secretNewField: 'not-stored' }).value
      )
    ).not.toContain('not-stored');
    expect(
      telemetryOf({ sampledAt: 'invalid', cpuUsagePercent: 0 })
    ).toBeNull();
  });
  test('accepts static diagnostics for escaped and non-service systemd units', () => {
    for (const unit of [
      'fleet-sync.timer',
      'nix.mount',
      'sys-devices-pci0000\\x3a00.device',
      'runner.slice',
    ]) {
      const sample = telemetry({
        logs: [
          {
            at: '2026-10-14T12:00:00Z',
            source: 'systemd',
            level: 'error',
            message: `Service ${unit} is failed.`,
          },
        ],
      });
      expect(parse(sample).errors).toEqual([]);
    }
  });
  test('freshness expires and rejects samples far in the future', () => {
    const sample = telemetry();
    expect(sampleIsFresh(sample, new Date('2026-10-14T12:01:00Z'), 60)).toBe(
      true
    );
    expect(sampleIsFresh(sample, new Date('2026-10-14T12:03:00Z'), 60)).toBe(
      false
    );
    expect(sampleIsFresh(sample, new Date('2026-10-14T11:00:00Z'), 60)).toBe(
      false
    );
  });
});
