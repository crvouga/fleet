/** @jsxImportSource react */
import { expect, test } from 'bun:test';
import { MantineProvider } from '@mantine/core';
import { renderToStaticMarkup } from 'react-dom/server';

import { chartData } from '../../src/console/chart-data';
import { NodeTelemetry } from '../../src/console/node-telemetry';
import { TelemetryHealth } from '../../src/console/telemetry-health';
import { nodeRow } from '../../src/testing/fixtures';
import { loadFleet } from '../../src/ui/lib/fleet-data';
import { provenanceBadge } from '../../src/ui/lib/telemetry';
import { healthTelemetry, telemetry } from '../support/telemetry';
import { get, html, setup } from './helpers';

test('provenance badges never present a stale or unsupported value as a current measurement', () => {
  expect(provenanceBadge('measured', false)).toBe('measured');
  expect(provenanceBadge('measured', true)).toBe('stale');
  expect(provenanceBadge('estimated', false)).toBe('estimated');
  expect(provenanceBadge('estimated', true)).toBe('stale');
  expect(provenanceBadge('unsupported', false)).toBe('unsupported');
  expect(provenanceBadge('unsupported', true)).toBe('unsupported');
});

test('the console labels measured, estimated, unsupported and stale families and keeps zeroes', () => {
  const sample = healthTelemetry({
    gpus: {
      status: 'unsupported',
      reason: 'No GPU with readable metrics was detected.',
      devices: [],
    },
  });
  const fresh = renderToStaticMarkup(
    <MantineProvider>
      <TelemetryHealth sample={sample} stale={false} />
    </MantineProvider>
  );
  expect(fresh).toContain('data-provenance="measured"');
  expect(fresh).toContain('data-provenance="estimated"');
  expect(fresh).toContain('data-provenance="unsupported"');
  expect(fresh).not.toContain('data-provenance="stale"');
  expect(fresh).toContain('No GPU with readable metrics was detected.');
  expect(fresh).toContain('Inferred from frequency.');
  expect(fresh).toContain('12.5 ms');
  expect(fresh).toContain('0%'); // measured zero memory pressure
  const stale = renderToStaticMarkup(
    <MantineProvider>
      <TelemetryHealth sample={sample} stale />
    </MantineProvider>
  );
  expect(stale).toContain('data-provenance="stale"');
  expect(stale).toContain('data-provenance="unsupported"');
  expect(stale).not.toContain('data-provenance="measured"');
});

test('older agents show "not reported", not zero, in both interfaces', () => {
  const markup = renderToStaticMarkup(
    <MantineProvider>
      <TelemetryHealth sample={telemetry()} stale={false} />
    </MantineProvider>
  );
  expect(markup).toContain('Not reported by this agent.');
  expect(markup).not.toContain('data-provenance');
});

test('node-controlled names and reasons are escaped in both interfaces', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const sample = healthTelemetry({
    gpus: {
      status: 'estimated',
      reason: evil,
      devices: [
        {
          name: evil,
          vendor: 'amd',
          utilizationPercent: 1,
          memoryUsedBytes: null,
          memoryTotalBytes: null,
          temperatureCelsius: null,
          powerWatts: null,
        },
      ],
    },
    diskHealth: {
      status: 'measured',
      reason: null,
      devices: [
        {
          name: evil,
          state: 'warning',
          source: 'sysfs',
          temperatureCelsius: null,
          wearPercent: null,
          powerOnHours: null,
          detail: evil,
        },
      ],
    },
  });
  const react = renderToStaticMarkup(
    <MantineProvider>
      <TelemetryHealth sample={sample} stale={false} />
    </MantineProvider>
  );
  expect(react).not.toContain(evil);
  expect(react).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('the full node telemetry panel (console) includes the health families with the right stale state', async () => {
  const { deps } = setup();
  deps.store.seedNode(
    nodeRow({
      short: 'ff00',
      lastSeenAt: deps.now(),
      body: { telemetry: healthTelemetry() },
    })
  );
  const entry = (await loadFleet(deps)).entries[0]!;
  const markup = renderToStaticMarkup(
    <MantineProvider>
      <NodeTelemetry entry={entry} now={new Date('2026-10-14T12:10:00Z')} />
    </MantineProvider>
  );
  expect(markup).toContain('Disk health');
  expect(markup).toContain('Pressure (PSI)');
  expect(markup).toContain('data-provenance="stale"');
});

test('the dashboard node page renders the health families, restarts and incidents', async () => {
  const { app, deps } = setup();
  const row = nodeRow({
    short: 'ff00',
    lastSeenAt: deps.now(),
    body: { telemetry: healthTelemetry() },
  });
  deps.store.seedNode(row);
  await deps.store.addEvent({
    nodeId: row.id,
    nodeLabel: 'n',
    kind: 'boot',
    severity: 'info',
    message: 'node started',
    data: { key: 'boot:aaa' },
  });
  await deps.store.addEvent({
    nodeId: row.id,
    nodeLabel: 'n',
    kind: 'offline',
    severity: 'error',
    message: 'down',
  });
  const page = await html(app, `/nodes/${row.id}`);
  expect(page).toContain('Disk health');
  expect(page).toContain('data-provenance=');
  expect(page).toContain('Restarts and uptime');
  expect(page).toContain('Incidents');
  expect(page).toContain('/report-issue?kind=node&amp;event=');
});

test('the incidents page lists open and resolved incidents and escapes labels', async () => {
  const { app, deps } = setup();
  await deps.store.addEvent({
    nodeId: 'f'.repeat(64),
    nodeLabel: '<b>x</b>',
    kind: 'gpu_hot',
    severity: 'warn',
    message: 'GPU temperature: <script>1</script>',
  });
  const page = await html(app, '/incidents');
  expect(page).toContain('<title>Incidents');
  expect(page).toContain('GPU too hot');
  expect(page).toContain('open');
  expect(page).toContain('Report issue');
  expect(page).not.toContain('<script>1</script>');
  expect(page).not.toContain('<b>x</b>');
  const filtered = await html(app, '/incidents?open=true&limit=5');
  expect(filtered).toContain('GPU too hot');
  expect((await get(app, '/incidents', null)).status).toBe(303);
});

test('charts carry the new series and keep unknown values as gaps', () => {
  const at = new Date('2026-10-14T12:00:00Z');
  const point = (telemetryValue: ReturnType<typeof healthTelemetry>) => ({
    at: new Date(at.getTime() - 1000),
    uptimeSeconds: null,
    load1: null,
    memUsedPercent: null,
    diskPercent: null,
    slots: null,
    busySlots: null,
    telemetry: telemetryValue,
  });
  expect(chartData([point(healthTelemetry())], at).at(-1)).toMatchObject({
    gpuUtilization: 0,
    gpuTemperature: 61,
    diskBusy: 12.5,
    memoryPressure: 0,
  });
  expect(chartData([point(telemetry())], at).at(-1)).toMatchObject({
    gpuUtilization: null,
    gpuTemperature: null,
    diskBusy: null,
    memoryPressure: null,
  });
  const long = chartData([point(healthTelemetry())], at, 24 * 30);
  expect(long).toHaveLength(96);
  expect(long.at(-1)).toMatchObject({ gpuTemperature: 61 });
});
