import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DISK_ALERT_PERCENT,
  deriveReportEvents,
} from '../../src/domain/heartbeat-events';
import type { NodeRow } from '../../src/types';
import {
  T0,
  heartbeatBody,
  nodeIdOf,
  type HeartbeatOverrides,
} from '../support/fixtures';

function previous(
  report: HeartbeatOverrides = {},
  overrides: Partial<NodeRow> = {}
): NodeRow {
  const { events: _events, ...facts } = heartbeatBody(1, report);
  return {
    id: nodeIdOf(1),
    role: 'ci',
    hostname: 'ci-1',
    approval: 'approved',
    displayName: null,
    note: null,
    labels: [],
    facts,
    revision: facts.revision,
    agentVersion: '1',
    configRevision: null,
    heartbeatIntervalSeconds: 60,
    remoteAddr: null,
    enrolledVia: 'role-token',
    firstSeenAt: T0,
    lastSeenAt: T0,
    approvedAt: T0,
    approvedBy: 'role-token',
    retiredAt: null,
    offlineNotifiedAt: null,
    ...overrides,
  };
}

const derive = (
  before: NodeRow,
  report: HeartbeatOverrides = {},
  alert = DEFAULT_DISK_ALERT_PERCENT
) =>
  deriveReportEvents(before, heartbeatBody(1, report), alert).map((e) => [
    e.kind,
    e.severity,
  ]);

describe('deriveReportEvents', () => {
  test('a steady node produces nothing, report after report', () => {
    expect(derive(previous())).toEqual([]);
  });

  test('a new boot id is a boot, unless the node reported its own boot', () => {
    expect(derive(previous(), { bootId: 'boot-2' })).toEqual([
      ['boot', 'info'],
    ]);
    expect(
      derive(previous(), {
        bootId: 'boot-2',
        events: [{ kind: 'boot', severity: 'info', message: 'm' }],
      })
    ).toEqual([]);
    expect(derive(previous(), { bootId: null })).toEqual([]);
  });

  test('a node with no earlier boot id has not rebooted', () => {
    const before = previous();
    expect(derive({ ...before, facts: {} }, { bootId: 'boot-9' })).toEqual([]);
  });

  test('a changed revision is announced, a first revision is not', () => {
    expect(derive(previous(), { revision: 'f'.repeat(40) })).toEqual([
      ['revision', 'info'],
    ]);
    expect(
      derive(previous({}, { revision: null }), { revision: 'f'.repeat(40) })
    ).toEqual([]);
    expect(derive(previous(), { revision: null })).toEqual([]);
  });

  test('rolled back appears as an error and clears as info', () => {
    expect(derive(previous(), { sync: { rolledBack: true } })).toEqual([
      ['rollback', 'error'],
    ]);
    expect(
      derive(previous({ sync: { rolledBack: true } }), {
        sync: { rolledBack: true },
      })
    ).toEqual([]);
    expect(derive(previous({ sync: { rolledBack: true } }))).toEqual([
      ['rollback_cleared', 'info'],
    ]);
  });

  test('failed units: appeared, still failing, cleared', () => {
    expect(derive(previous(), { failedUnits: ['a'] })).toEqual([
      ['units_failed', 'warn'],
    ]);
    expect(
      derive(previous({ failedUnits: ['a'] }), { failedUnits: ['a'] })
    ).toEqual([]);
    expect(
      derive(previous({ failedUnits: ['a'] }), { failedUnits: ['a', 'b'] })
    ).toEqual([['units_failed', 'warn']]);
    expect(
      derive(previous({ failedUnits: ['a'] }), { failedUnits: ['b'] })
    ).toEqual([
      ['units_failed', 'warn'],
      ['units_recovered', 'info'],
    ]);
    expect(derive(previous({ failedUnits: ['a'] }))).toEqual([
      ['units_recovered', 'info'],
    ]);
  });

  test('disk: crossing the line is one event in each direction', () => {
    expect(derive(previous(), { disk: { nixUsedPercent: 89 } })).toEqual([]);
    expect(derive(previous(), { disk: { nixUsedPercent: 90 } })).toEqual([
      ['disk_high', 'warn'],
    ]);
    expect(
      derive(previous({ disk: { nixUsedPercent: 90 } }), {
        disk: { nixUsedPercent: 99 },
      })
    ).toEqual([]);
    expect(
      derive(previous({ disk: { nixUsedPercent: 95 } }), {
        disk: { nixUsedPercent: 20 },
      })
    ).toEqual([['disk_ok', 'info']]);
  });

  test('disk: each mount is judged on its own, against the configured percent', () => {
    expect(
      derive(
        previous(),
        { disk: { nixUsedPercent: 85, bootUsedPercent: 85 } },
        80
      )
    ).toEqual([
      ['disk_high', 'warn'],
      ['disk_high', 'warn'],
    ]);
  });

  test('disk: an unknown reading neither raises nor clears the alert', () => {
    expect(
      derive(previous({ disk: { nixUsedPercent: 95 } }), {
        disk: { nixUsedPercent: null },
      })
    ).toEqual([]);
  });

  test('recovery after an offline notice', () => {
    expect(derive(previous({}, { offlineNotifiedAt: T0 }))).toEqual([
      ['recovered', 'info'],
    ]);
  });

  test('several changes at once come out in a stable order', () => {
    const kinds = derive(previous({}, { offlineNotifiedAt: T0 }), {
      bootId: 'boot-2',
      revision: 'a'.repeat(40),
      sync: { rolledBack: true },
      failedUnits: ['x'],
      disk: { nixUsedPercent: 99 },
    }).map(([kind]) => kind);
    expect(kinds).toEqual([
      'recovered',
      'boot',
      'revision',
      'rollback',
      'units_failed',
      'disk_high',
    ]);
  });

  test('tolerates damaged stored facts', () => {
    const odd = previous(
      {},
      { facts: { failedUnits: 'nope', disk: 7, sync: [], bootId: 5 } }
    );
    expect(derive(odd, { failedUnits: ['a'] })).toEqual([
      ['units_failed', 'warn'],
    ]);
  });
});
