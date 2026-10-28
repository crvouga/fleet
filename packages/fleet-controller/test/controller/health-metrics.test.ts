import { expect, test } from 'bun:test';

import { viewOf } from '../../src/domain/node-view';
import { renderMetrics } from '../../src/routes/metrics';
import { nodeRow } from '../../src/testing/fixtures';
import { healthTelemetry, telemetry } from '../support/telemetry';

const now = new Date('2026-10-14T12:00:30Z');
function metrics(
  sample: ReturnType<typeof healthTelemetry>,
  at: Date = now
): string[] {
  const row = nodeRow({
    short: 'ff00',
    lastSeenAt: at,
    body: { telemetry: sample, readiness: { issues: [] }, revision: 'abc123' },
  });
  return renderMetrics(
    [viewOf(row, at, { alerts: { offlineAfterSeconds: 300 } })],
    at
  )
    .split('\n')
    .filter((line) => !line.startsWith('#'));
}
const find = (lines: string[], name: string) =>
  lines.filter((line) => line.startsWith(`${name}{`));

test('health series are exported with real values, zeroes included, and a provenance for each family', () => {
  const lines = metrics(healthTelemetry());
  expect(find(lines, 'fleet_node_gpu_utilization_percent')[0]).toEndWith(' 0');
  expect(find(lines, 'fleet_node_gpu_temperature_celsius')[0]).toEndWith(' 61');
  expect(find(lines, 'fleet_node_disk_busy_percent')[0]).toEndWith(' 12.5');
  expect(find(lines, 'fleet_node_disk_health_state')[0]).toEndWith(' 0');
  expect(find(lines, 'fleet_node_cpu_frequency_mhz')).toHaveLength(3);
  expect(
    find(lines, 'fleet_node_pressure_percent').some(
      (line) => line.includes('resource="memory"') && line.endsWith(' 0')
    )
  ).toBe(true);
  expect(find(lines, 'fleet_node_controller_latency_ms')[0]).toEndWith(' 12.5');
  expect(find(lines, 'fleet_node_restarts_observed')[0]).toEndWith(' 2');
  const throttled = find(lines, 'fleet_node_cpu_throttled')[0]!;
  expect(throttled).toContain('provenance="estimated"');
  expect(throttled).toEndWith(' 0');
  const provenance = find(lines, 'fleet_node_metric_provenance');
  expect(
    provenance.some(
      (line) =>
        line.includes('family="throttling"') &&
        line.includes('provenance="estimated"')
    )
  ).toBe(true);
  expect(
    provenance.some(
      (line) =>
        line.includes('family="gpus"') && line.includes('provenance="measured"')
    )
  ).toBe(true);
});

test('unsupported families and unknown values are omitted, never exported as zero', () => {
  const lines = metrics(
    healthTelemetry({
      gpus: { status: 'unsupported', reason: 'No GPU', devices: [] },
      diskIo: {
        status: 'measured',
        reason: 'warming up',
        devices: [
          {
            name: 'sda',
            readBytesPerSecond: null,
            writeBytesPerSecond: null,
            iops: null,
            busyPercent: null,
          },
        ],
      },
      diskHealth: {
        status: 'measured',
        reason: null,
        devices: [
          {
            name: 'sda',
            state: 'unknown',
            source: 'sysfs',
            temperatureCelsius: null,
            wearPercent: null,
            powerOnHours: null,
            detail: null,
          },
        ],
      },
      throttling: {
        status: 'unsupported',
        reason: 'none',
        throttled: null,
        events: null,
        basis: null,
      },
      pressure: {
        status: 'unsupported',
        reason: 'no PSI',
        cpu: null,
        memory: null,
        io: null,
      },
      connectivity: {
        status: 'unsupported',
        reason: 'none yet',
        controllerLatencyMs: null,
        consecutiveFailures: null,
      },
    })
  );
  for (const name of [
    'fleet_node_gpu_utilization_percent',
    'fleet_node_disk_io_bytes_per_second',
    'fleet_node_disk_busy_percent',
    'fleet_node_disk_health_state',
    'fleet_node_cpu_throttled',
    'fleet_node_pressure_percent',
    'fleet_node_controller_latency_ms',
  ])
    expect([name, find(lines, name)]).toEqual([name, []]);
  expect(
    find(lines, 'fleet_node_metric_provenance').some((line) =>
      line.includes('provenance="unsupported"')
    )
  ).toBe(true);
});

test('stale samples export no health series at all, only the freshness gauge', () => {
  const later = new Date(now.getTime() + 400_000);
  const lines = metrics(
    healthTelemetry({ sampledAt: '2026-10-14T12:00:00Z' }),
    later
  );
  const row = nodeRow({
    short: 'ff00',
    lastSeenAt: now,
    body: { telemetry: healthTelemetry({ sampledAt: '2026-10-14T12:00:00Z' }) },
  });
  const stale = renderMetrics(
    [viewOf(row, later, { alerts: { offlineAfterSeconds: 300 } })],
    later
  )
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  expect(lines.length).toBeGreaterThan(0);
  expect(
    stale.filter((line) =>
      /^fleet_node_(gpu|disk_|cpu_f|cpu_t|pressure|controller|metric_prov|uptime|restarts|heartbeat)/.test(
        line
      )
    )
  ).toEqual([]);
  expect(
    stale.some(
      (line) =>
        line.startsWith('fleet_node_telemetry_fresh{') && line.endsWith(' 0')
    )
  ).toBe(true);
});

test('agents without health data export none of these series', () => {
  const row = nodeRow({
    short: 'ff00',
    lastSeenAt: now,
    body: { telemetry: telemetry() },
  });
  const lines = renderMetrics(
    [viewOf(row, now, { alerts: { offlineAfterSeconds: 300 } })],
    now
  )
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  expect(
    lines.filter((line) =>
      /^fleet_node_(gpu|disk_(io|busy|health|temp|wear)|cpu_frequency|cpu_throttle|pressure|controller|metric_prov|restarts)/.test(
        line
      )
    )
  ).toEqual([]);
});

test('network error counts are exported only when the agent reported them', () => {
  const withCounts = healthTelemetry({
    network: [
      {
        name: 'eth0',
        receivedBytes: 1,
        transmittedBytes: 1,
        receiveBytesPerSecond: null,
        transmitBytesPerSecond: null,
        receiveErrors: 0,
        transmitErrors: null,
        receiveDropped: 4,
        transmitDropped: 0,
      },
    ],
  });
  const lines = metrics(withCounts);
  expect(
    find(lines, 'fleet_node_network_errors_since_last_sample')
  ).toHaveLength(1);
  expect(
    find(lines, 'fleet_node_network_dropped_since_last_sample')
  ).toHaveLength(2);
  expect(
    find(
      metrics(healthTelemetry()),
      'fleet_node_network_errors_since_last_sample'
    )
  ).toEqual([]);
});
