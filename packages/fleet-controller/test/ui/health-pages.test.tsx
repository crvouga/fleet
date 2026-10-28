import { expect, test } from 'bun:test';

import { deriveIncidents } from '../../src/domain/incidents';
import { restartHistory } from '../../src/domain/restart-history';
import {
  IncidentsBody,
  NodeIncidentsPanel,
  RestartHistoryPanel,
} from '../../src/ui/pages/incidents';
import { HealthSnapshot } from '../../src/ui/pages/telemetry-health';
import { healthTelemetry, telemetry } from '../support/telemetry';

const NOW = new Date('2026-10-14T12:00:30Z');
const render = (node: unknown) => String(node);

test('the dashboard says "not reported" for older agents and labels every family it has', () => {
  const old = render(<HealthSnapshot sample={telemetry()} stale={false} />);
  expect(old).toContain('Not reported by this agent.');
  expect(old).not.toContain('data-provenance');
  const fresh = render(
    <HealthSnapshot sample={healthTelemetry()} stale={false} />
  );
  expect(fresh).toContain('data-provenance="measured"');
  expect(fresh).toContain('data-provenance="estimated"');
  const stale = render(<HealthSnapshot sample={healthTelemetry()} stale />);
  expect(stale).toContain('data-provenance="stale"');
  expect(stale).not.toContain('data-provenance="measured"');
  const unsupported = render(
    <HealthSnapshot
      sample={healthTelemetry({
        gpus: {
          status: 'unsupported',
          reason: 'No GPU detected.',
          devices: [],
        },
      })}
      stale={false}
    />
  );
  expect(unsupported).toContain('data-provenance="unsupported"');
  expect(unsupported).toContain('No GPU detected.');
});

test('node-controlled names, reasons and details are escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const markup = render(
    <HealthSnapshot
      stale={false}
      sample={healthTelemetry({
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
      })}
    />
  );
  expect(markup).not.toContain(evil);
  expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('the incident and restart panels render empty states and escape text', () => {
  const empty = render(
    <IncidentsBody
      incidents={[]}
      openOnly={false}
      openCount={0}
      nextBefore={null}
      truncated={false}
      now={NOW}
    />
  );
  expect(empty).toContain('No incidents.');
  const incidents = deriveIncidents(
    [
      {
        id: 3,
        at: NOW,
        nodeId: 'a'.repeat(64),
        nodeLabel: null,
        kind: 'offline',
        severity: 'error',
        message: '<i>x</i>',
        data: {},
      },
    ],
    NOW
  );
  const panel = render(<NodeIncidentsPanel incidents={incidents} now={NOW} />);
  expect(panel).toContain('&lt;i&gt;x&lt;/i&gt;');
  expect(panel).toContain('/report-issue?kind=node&amp;event=3');
  const none = render(
    <RestartHistoryPanel
      history={restartHistory([], { bootId: null, uptimeSeconds: null }, NOW)}
      now={NOW}
    />
  );
  expect(none).toContain('No boot events recorded.');
  expect(none).toContain('unavailable');
});
