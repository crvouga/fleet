import { describe, expect, test } from 'bun:test';

import { viewOf } from '../../src/domain/status';
import { summarize } from '../../src/domain/summary';
import { nodeRow, type NodeOptions } from '../../src/testing/fixtures';
import { FIXED_NOW } from '../../src/testing/test-deps';

const view = (options: NodeOptions) => viewOf(nodeRow(options), FIXED_NOW, 300);
const ago = (s: number) => new Date(FIXED_NOW.getTime() - s * 1000);

describe('summarize', () => {
  test('an empty fleet has zeroes everywhere', () => {
    const summary = summarize([]);
    expect(summary.total).toBe(0);
    expect(summary.byStatus.online).toBe(0);
    expect(summary.byRole.ci).toEqual({ total: 0, online: 0 });
    expect(summary.revisions).toEqual([]);
    expect(summary.runnerSlots).toEqual({ total: 0, busy: 0 });
    expect(summary.withFailedUnits).toBe(0);
    expect(summary.rolledBack).toBe(0);
  });

  test('counts statuses and roles, approved nodes only for roles', () => {
    const summary = summarize([
      view({ short: 'a001', role: 'ci', lastSeenAt: ago(10) }),
      view({ short: 'a002', role: 'ci', lastSeenAt: ago(200) }),
      view({ short: 'a003', role: 'web', lastSeenAt: ago(9000) }),
      view({
        short: 'a004',
        role: 'web',
        approval: 'pending',
        lastSeenAt: ago(5),
      }),
      view({
        short: 'a005',
        role: 'cache',
        approval: 'retired',
        lastSeenAt: ago(5),
      }),
      view({
        short: 'a006',
        role: 'cache',
        approval: 'rejected',
        lastSeenAt: ago(5),
      }),
    ]);
    expect(summary.total).toBe(6);
    expect(summary.byStatus).toEqual({
      online: 1,
      stale: 1,
      offline: 1,
      pending: 1,
      rejected: 1,
      retired: 1,
    });
    expect(summary.byRole.ci).toEqual({ total: 2, online: 1 });
    expect(summary.byRole.web).toEqual({ total: 1, online: 0 });
    expect(summary.byRole.cache).toEqual({ total: 0, online: 0 });
  });

  test('revisions skip retired nodes and unknown revisions, most common first', () => {
    const summary = summarize([
      view({ short: 'b001', lastSeenAt: ago(1), body: { revision: 'bbb' } }),
      view({ short: 'b002', lastSeenAt: ago(1), body: { revision: 'aaa' } }),
      view({ short: 'b003', lastSeenAt: ago(1), body: { revision: 'aaa' } }),
      view({
        short: 'b004',
        lastSeenAt: ago(1),
        body: { revision: 'ccc' },
        approval: 'retired',
      }),
      view({ short: 'b005', lastSeenAt: ago(1) }),
    ]);
    expect(summary.revisions).toEqual([
      { revision: 'aaa', count: 2 },
      { revision: 'bbb', count: 1 },
    ]);
  });

  test('runner slots count online and stale nodes, not offline ones', () => {
    const summary = summarize([
      view({
        short: 'c001',
        lastSeenAt: ago(1),
        body: { runners: { slots: 4, busy: 3 } },
      }),
      view({
        short: 'c002',
        lastSeenAt: ago(200),
        body: { runners: { slots: 2, busy: 9 } },
      }),
      view({
        short: 'c003',
        lastSeenAt: ago(99999),
        body: { runners: { slots: 8, busy: 1 } },
      }),
    ]);
    // busy is capped by slots so a bad report cannot exceed capacity
    expect(summary.runnerSlots).toEqual({ total: 6, busy: 5 });
  });

  test('failed units and rollbacks are counted per node', () => {
    const summary = summarize([
      view({
        short: 'd001',
        lastSeenAt: ago(1),
        body: { failedUnits: ['a', 'b'] },
      }),
      view({
        short: 'd002',
        lastSeenAt: ago(1),
        body: { sync: { rolledBack: true } },
      }),
      view({ short: 'd003', lastSeenAt: ago(1) }),
    ]);
    expect(summary.withFailedUnits).toBe(1);
    expect(summary.rolledBack).toBe(1);
  });

  test('a node whose stored facts are garbage does not break it', () => {
    const row = {
      ...nodeRow({ short: 'e001', lastSeenAt: ago(1) }),
      facts: { runners: 'nope', failedUnits: 7 },
    };
    const summary = summarize([viewOf(row, FIXED_NOW, 300)]);
    expect(summary.runnerSlots).toEqual({ total: 0, busy: 0 });
    expect(summary.withFailedUnits).toBe(0);
  });
});
