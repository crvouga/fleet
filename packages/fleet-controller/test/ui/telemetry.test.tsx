/** @jsxImportSource react */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { NodeTelemetry } from '../../src/console/node-telemetry';
import { chartData } from '../../src/console/chart-data';
import { loadFleet } from '../../src/ui/lib/fleet-data';
import { runLink } from '../../src/ui/lib/telemetry';
import { nodeRow } from '../../src/testing/fixtures';
import { telemetry } from '../support/telemetry';
import { setup } from './helpers';

test('dashboard respects role and node offline thresholds just like the REST API', async () => {
  const { deps } = setup();
  const row = nodeRow({
    short: 'ff00',
    lastSeenAt: new Date(deps.now().getTime() - 200_000),
  });
  deps.store.seedNode(row);
  await deps.store.putSettings(
    'role:ci',
    { alerts: { offlineAfterSeconds: 180 } },
    'test'
  );
  expect((await loadFleet(deps)).entries[0]?.view.status).toBe('offline');
  await deps.store.putSettings(
    `node:${row.id}`,
    { alerts: { offlineAfterSeconds: 600 } },
    'test'
  );
  expect((await loadFleet(deps)).entries[0]?.view.status).toBe('stale');
});
test('hardware panels label stale snapshots, preserve zeroes, escape names and link only to GitHub', async () => {
  const { deps } = setup();
  const sample = telemetry({
    cpuUsagePercent: 0,
    runnerSlots: [
      { ...telemetry().runnerSlots[0]!, jobName: '<script>alert(1)</script>' },
    ],
  });
  deps.store.seedNode(
    nodeRow({
      short: 'ff00',
      lastSeenAt: deps.now(),
      body: { telemetry: sample },
    })
  );
  const entry = (await loadFleet(deps)).entries[0]!;
  const html = renderToStaticMarkup(
    <MantineProvider>
      <NodeTelemetry entry={entry} now={new Date('2026-10-14T12:10:00Z')} />
    </MantineProvider>
  );
  expect(html).toContain('Stale sample');
  expect(html).toContain('0.0%');
  expect(html).toContain('0.00 W');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('https://github.com/example/project/actions/runs/123');
  expect(html).toContain('authenticated job logs');
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(runLink('https://evil.test/secret', '123')).toBeNull();
  expect(runLink('example/project', 'javascript:alert(1)')).toBeNull();
  expect(runLink('../project', '123')).toBeNull();
});
test('hardware charts preserve missing samples as gaps and measured zero', () => {
  const at = new Date('2026-10-14T12:00:00Z');
  const data = chartData(
    [
      {
        at: new Date(at.getTime() - 1000),
        uptimeSeconds: null,
        load1: null,
        memUsedPercent: null,
        diskPercent: null,
        slots: null,
        busySlots: null,
        telemetry: telemetry(),
      },
    ],
    at
  );
  expect(data.at(-1)).toMatchObject({
    cpu: 0,
    temperature: 42.5,
    power: 0,
    disk: null,
  });
  expect(data[0]).toMatchObject({ cpu: null, temperature: null, power: null });
});
