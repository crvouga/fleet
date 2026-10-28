import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DISK_ALERT_PERCENT,
  deriveReportEvents,
} from '../../src/domain/heartbeat-events';
import { HEALTH_THRESHOLDS } from '../../src/domain/health-events';
import type { Telemetry } from '../../src/telemetry';
import type { NodeRow } from '../../src/types';
import { T0, heartbeatBody, nodeIdOf } from '../support/fixtures';
import { healthTelemetry } from '../support/telemetry';

function previous(sample?: Telemetry): NodeRow {
  const { events: _events, ...facts } = heartbeatBody(
    1,
    sample ? { telemetry: sample } : {}
  );
  return {
    id: nodeIdOf(1),
    role: 'ci',
    observedRole: 'ci',
    observedClosure: 'ci',
    ageRecipient: null,
    hardware: null,
    reconcile: null,
    hostname: 'ci-1',
    approval: 'approved',
    displayName: null,
    note: null,
    labels: [],
    facts,
    revision: facts.revision,
    agentVersion: '1',
    appliedRevision: null,
    heartbeatIntervalSeconds: 60,
    remoteAddr: null,
    enrolledVia: 'enrollment-token',
    firstSeenAt: T0,
    lastSeenAt: T0,
    approvedAt: T0,
    approvedBy: 'enrollment-token',
    retiredAt: null,
    offlineNotifiedAt: null,
  };
}
const derive = (before?: Telemetry, now?: Telemetry) =>
  deriveReportEvents(
    previous(before),
    heartbeatBody(1, now ? { telemetry: now } : {}),
    DEFAULT_DISK_ALERT_PERCENT
  ).map((event) => [event.kind, event.severity]);

const disk = (state: 'ok' | 'warning' | 'failing' | 'unknown'): Telemetry =>
  healthTelemetry({
    diskHealth: {
      status: 'measured',
      reason: null,
      devices: [
        {
          name: 'sda',
          state,
          source: 'smartctl',
          temperatureCelsius: null,
          wearPercent: null,
          powerOnHours: null,
          detail: null,
        },
      ],
    },
  });
const gpuAt = (celsius: number | null): Telemetry =>
  healthTelemetry({
    gpus: {
      status: 'measured',
      reason: null,
      devices: [
        {
          name: 'g',
          vendor: 'nvidia',
          utilizationPercent: 1,
          memoryUsedBytes: null,
          memoryTotalBytes: null,
          temperatureCelsius: celsius,
          powerWatts: null,
        },
      ],
    },
  });
const throttle = (
  status: 'measured' | 'estimated' | 'unsupported',
  throttled: boolean | null
): Telemetry =>
  healthTelemetry({
    throttling: {
      status,
      reason: null,
      throttled,
      events: null,
      basis: status === 'estimated' ? 'frequency' : 'thermal_throttle',
    },
  });
const memory = (some: number | null, full: number | null): Telemetry =>
  healthTelemetry({
    pressure: {
      status: 'measured',
      reason: null,
      cpu: null,
      memory: {
        someAvg10: null,
        someAvg60: some,
        fullAvg10: null,
        fullAvg60: full,
      },
      io: null,
    },
  });

describe('health events', () => {
  test('a healthy, steady report produces nothing', () => {
    expect(derive(healthTelemetry(), healthTelemetry())).toEqual([]);
  });

  test('disk health: degraded once, escalated once, ok once', () => {
    expect(derive(disk('ok'), disk('warning'))).toEqual([
      ['disk_health_degraded', 'warn'],
    ]);
    expect(derive(disk('warning'), disk('warning'))).toEqual([]);
    expect(derive(disk('warning'), disk('failing'))).toEqual([
      ['disk_health_degraded', 'error'],
    ]);
    expect(derive(disk('failing'), disk('failing'))).toEqual([]);
    expect(derive(disk('failing'), disk('warning'))).toEqual([]);
    expect(derive(disk('failing'), disk('ok'))).toEqual([
      ['disk_health_ok', 'info'],
    ]);
  });

  test('unknown or unsupported never raises or clears an alert', () => {
    expect(derive(disk('warning'), disk('unknown'))).toEqual([]);
    expect(derive(disk('ok'), disk('unknown'))).toEqual([]);
    expect(
      derive(
        disk('warning'),
        healthTelemetry({
          diskHealth: { status: 'unsupported', reason: 'none', devices: [] },
        })
      )
    ).toEqual([]);
    expect(derive(disk('warning'), undefined)).toEqual([]);
    expect(derive(undefined, disk('warning'))).toEqual([
      ['disk_health_degraded', 'warn'],
    ]);
  });

  test('GPU temperature at the threshold raises gpu_hot once and clears with gpu_ok', () => {
    const hot = HEALTH_THRESHOLDS.gpuHotCelsius;
    expect(derive(gpuAt(hot - 1), gpuAt(hot))).toEqual([['gpu_hot', 'warn']]);
    expect(derive(gpuAt(hot), gpuAt(hot + 5))).toEqual([]);
    expect(derive(gpuAt(hot), gpuAt(hot - 1))).toEqual([['gpu_ok', 'info']]);
    expect(derive(gpuAt(hot), gpuAt(null))).toEqual([]);
    expect(
      derive(
        gpuAt(hot),
        healthTelemetry({
          gpus: { status: 'unsupported', reason: 'x', devices: [] },
        })
      )
    ).toEqual([]);
  });

  test('only measured throttling raises an event; frequency estimates never do', () => {
    expect(
      derive(throttle('measured', false), throttle('measured', true))
    ).toEqual([['throttling', 'warn']]);
    expect(
      derive(throttle('measured', true), throttle('measured', true))
    ).toEqual([]);
    expect(
      derive(throttle('measured', true), throttle('measured', false))
    ).toEqual([['throttling_ok', 'info']]);
    expect(
      derive(throttle('estimated', false), throttle('estimated', true))
    ).toEqual([]);
    expect(
      derive(throttle('measured', true), throttle('measured', null))
    ).toEqual([]);
    expect(
      derive(throttle('measured', true), throttle('unsupported', null))
    ).toEqual([]);
  });

  test('memory pressure uses the 60 s some and full averages', () => {
    const some = HEALTH_THRESHOLDS.memorySomeAvg60Percent;
    const full = HEALTH_THRESHOLDS.memoryFullAvg60Percent;
    expect(derive(memory(0, 0), memory(some, 0))).toEqual([
      ['memory_pressure_high', 'warn'],
    ]);
    expect(derive(memory(0, 0), memory(0, full))).toEqual([
      ['memory_pressure_high', 'warn'],
    ]);
    expect(derive(memory(some, 0), memory(some + 10, 5))).toEqual([]);
    expect(derive(memory(some, 0), memory(1, 1))).toEqual([
      ['memory_pressure_ok', 'info'],
    ]);
    expect(derive(memory(some, 0), memory(null, null))).toEqual([]);
  });

  test('an event the node reported itself is not duplicated', () => {
    const body = heartbeatBody(1, {
      telemetry: gpuAt(95),
      events: [{ kind: 'gpu_hot', severity: 'warn', message: 'node says hot' }],
    });
    expect(
      deriveReportEvents(
        previous(gpuAt(40)),
        body,
        DEFAULT_DISK_ALERT_PERCENT
      ).filter((event) => event.kind === 'gpu_hot')
    ).toEqual([]);
  });

  test('failed units and disk fullness carry structured identity for incident pairing', () => {
    const before = previous();
    const report = heartbeatBody(1, {
      failedUnits: ['a.service', 'b.service'],
      disk: { nixUsedPercent: 95, bootUsedPercent: 10 },
    });
    const events = deriveReportEvents(
      before,
      report,
      DEFAULT_DISK_ALERT_PERCENT
    );
    expect(events.find((event) => event.kind === 'units_failed')?.data).toEqual(
      {
        units: ['a.service', 'b.service'],
      }
    );
    expect(events.find((event) => event.kind === 'disk_high')?.data).toEqual({
      mount: '/nix',
    });
  });
});
