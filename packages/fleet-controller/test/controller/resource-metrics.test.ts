import { expect, test } from 'bun:test';
import { renderMetrics } from '../../src/routes/metrics';
import { viewOf } from '../../src/domain/status';
import { nodeRow } from '../../src/testing/fixtures';
import { telemetry } from '../support/telemetry';
import { readFacts } from '../../src/ui/lib/facts';
import { integrationReady } from '../../src/domain/readiness';

test('the UI and readiness gauge refuse paused or rolled-back nodes', () => {
  const now = new Date('2026-10-14T12:00:30Z');
  for (const sync of [{ paused: true }, { rolledBack: true }]) {
    const row = nodeRow({
      short: 'ff00',
      lastSeenAt: now,
      body: { readiness: { issues: [] }, revision: 'abc123', sync },
    });
    const view = viewOf(row, now, 300);
    expect(integrationReady(view, readFacts(row))).toBe(false);
    const gauge = renderMetrics([view], now)
      .split('\n')
      .find((line) => line.startsWith('fleet_node_ready{'));
    expect(gauge?.endsWith(' 0')).toBe(true);
  }
});

test('resource metrics preserve zero, omit unknown rates and suppress stale measurements', () => {
  const now = new Date('2026-10-14T12:00:30Z');
  const row = nodeRow({
    short: 'ff00',
    lastSeenAt: now,
    body: {
      telemetry: telemetry(),
      readiness: { issues: [] },
      revision: 'abc123',
    },
  });
  const current = renderMetrics([viewOf(row, now, 300)], now);
  const measurements = current
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  expect(
    measurements.some(
      (line) =>
        line.startsWith('fleet_node_cpu_usage_percent{') && line.endsWith(' 0')
    )
  ).toBe(true);
  expect(
    measurements.some(
      (line) =>
        line.startsWith('fleet_node_power_watts{') && line.endsWith(' 0')
    )
  ).toBe(true);
  expect(
    measurements.some(
      (line) =>
        line.startsWith('fleet_node_network_bytes_per_second{') &&
        line.includes('direction="receive"')
    )
  ).toBe(false);
  const later = new Date(now.getTime() + 200_000);
  const stale = renderMetrics([viewOf(row, later, 300)], later)
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  expect(
    stale.some((line) => line.startsWith('fleet_node_cpu_usage_percent{'))
  ).toBe(false);
  expect(
    stale.some(
      (line) =>
        line.startsWith('fleet_node_telemetry_fresh{') && line.endsWith(' 0')
    )
  ).toBe(true);
  expect(
    stale.some(
      (line) => line.startsWith('fleet_node_ready{') && line.endsWith(' 0')
    )
  ).toBe(true);
});
