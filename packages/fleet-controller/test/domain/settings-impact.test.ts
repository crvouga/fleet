import { describe, expect, test } from 'bun:test';

import type { FleetConfig, Scope } from '../../src/config/schema';
import {
  analyzeSettingsChange,
  unacknowledged,
  type ImpactSubject,
} from '../../src/domain/settings-impact';
import type { SettingsRow } from '../../src/types';

const node = (n: number, over: Partial<ImpactSubject> = {}): ImpactSubject => ({
  id: n.toString(16).padStart(64, '0'),
  role: 'ci',
  approval: 'approved',
  hardware: null,
  hostname: `ci-${n}`,
  displayName: null,
  ...over,
});
const row = (scope: Scope, value: FleetConfig): SettingsRow => ({
  scope,
  value: value as Record<string, unknown>,
  updatedAt: new Date(0),
  updatedBy: null,
  revision: 1,
});
const analyze = (
  proposed: FleetConfig,
  nodes: ImpactSubject[],
  rows: SettingsRow[] = [],
  scope: Scope = 'fleet'
) => analyzeSettingsChange({ scope, proposed, rows, nodes });
const codes = (impact: ReturnType<typeof analyze>) =>
  impact.issues.map((issue) => issue.code);

describe('settings impact', () => {
  test('an identical document changes no node and raises nothing', () => {
    const impact = analyze(
      { disk: { alertPercent: 80 } },
      [node(1)],
      [row('fleet', { disk: { alertPercent: 80 } })]
    );
    expect(impact.changes).toEqual([]);
    expect(impact.issues).toEqual([]);
  });

  test('lists exactly the nodes whose desired revision changes, with both revisions', () => {
    const nodes = [node(1), node(2), node(3, { role: 'devbox' })];
    const impact = analyze(
      { runners: { enabled: true } },
      nodes,
      [],
      'role:ci'
    );
    expect(impact.changes.map((c) => c.nodeId)).toEqual([
      nodes[0]!.id,
      nodes[1]!.id,
    ]);
    for (const change of impact.changes) {
      expect(change.before.revision).not.toBe(change.after.revision);
      expect(change.after.values).toEqual({ runners: { enabled: true } });
    }
  });

  test('rejected and retired nodes receive nothing and are not counted', () => {
    const impact = analyze({ disk: { alertPercent: 70 } }, [
      node(1),
      node(2, { approval: 'rejected' }),
      node(3, { approval: 'retired' }),
    ]);
    expect(impact.totalNodes).toBe(1);
    expect(impact.changes).toHaveLength(1);
  });

  test('fleet-wide pause, cordon, runner disable, throttle and reboot-off need acknowledgement', () => {
    const nodes = [node(1), node(2), node(3, { role: 'devbox' })];
    const cases: [FleetConfig, string][] = [
      [{ sync: { paused: true } }, 'fleet_sync_paused'],
      [{ runners: { cordoned: true } }, 'ci_runners_cordoned'],
      [{ runners: { enabled: false } }, 'ci_runners_disabled'],
      [{ capacity: { slotMax: 1 } }, 'ci_capacity_throttled'],
      [{ reboot: { enabled: false } }, 'fleet_reboot_disabled'],
    ];
    for (const [value, code] of cases) {
      const impact = analyze(value, nodes);
      expect([code, codes(impact).includes(code)]).toEqual([code, true]);
      expect(unacknowledged(impact.issues, []).map((i) => i.code)).toContain(
        code
      );
      expect(
        unacknowledged(impact.issues, [code]).map((i) => i.code)
      ).not.toContain(code);
    }
  });

  test('a partial change is not fleet-wide: one node override does not raise', () => {
    const nodes = [node(1), node(2)];
    const impact = analyze(
      { sync: { paused: true } },
      nodes,
      [],
      `node:${nodes[0]!.id}`
    );
    expect(codes(impact)).toEqual([]);
  });

  test('CI-only rules ignore a fleet without CI nodes; a node override can break the "all" condition', () => {
    expect(
      codes(
        analyze({ runners: { cordoned: true } }, [node(1, { role: 'devbox' })])
      )
    ).toEqual([]);
    const nodes = [node(1), node(2)];
    const rows = [
      row(`node:${nodes[1]!.id}`, { runners: { cordoned: false } }),
    ];
    expect(
      codes(analyze({ runners: { cordoned: true } }, nodes, rows))
    ).toEqual([]);
  });

  test('re-saving an already fleet-wide condition does not raise it again', () => {
    const rows = [row('fleet', { sync: { paused: true } })];
    const impact = analyze(
      { sync: { paused: true }, disk: { alertPercent: 90 } },
      [node(1)],
      rows
    );
    expect(codes(impact)).not.toContain('fleet_sync_paused');
  });

  test('a reboot delay beyond an hour is flagged per node, an hour is fine', () => {
    expect(
      codes(analyze({ reboot: { delayMaxSeconds: 3601 } }, [node(1)]))
    ).toContain('reboot_delay_excessive');
    expect(
      codes(analyze({ reboot: { delayMaxSeconds: 3600 } }, [node(1)]))
    ).not.toContain('reboot_delay_excessive');
  });

  test('a change that touches every node is reported, but is informational', () => {
    const impact = analyze({ disk: { alertPercent: 70 } }, [node(1), node(2)]);
    const wide = impact.issues.find((i) => i.code === 'fleet_wide_change');
    expect(wide?.blocking).toBe(false);
    expect(unacknowledged(impact.issues, [])).toEqual([]);
  });
});
