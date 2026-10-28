import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_TIMEOUT_SECONDS,
  EXCLUDES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  TRANSITIONS,
  canTransition,
  confirmationFor,
  confirmationMatches,
  isActive,
  isTerminal,
  pathTo,
  planRequest,
  timeoutSecondsOf,
  type RequestContext,
} from '../../src/domain/operations';
import { operation } from '../support/operations';

describe('operation state machines', () => {
  test('terminal states are final for every kind', () => {
    for (const kind of OPERATION_KINDS)
      for (const from of OPERATION_STATUSES.filter(isTerminal))
        for (const to of OPERATION_STATUSES)
          expect(canTransition(kind, from, to)).toBe(false);
  });

  test('every active state can still reach every terminal state it should', () => {
    for (const kind of OPERATION_KINDS) {
      expect(pathTo(kind, 'in_progress', 'succeeded')).toEqual(['succeeded']);
      expect(pathTo(kind, 'pending', 'failed')).toEqual(['failed']);
      expect(pathTo(kind, 'pending', 'cancelled')).toEqual(['cancelled']);
      expect(pathTo(kind, 'in_progress', 'pending')).toBeNull();
      expect(pathTo(kind, 'succeeded', 'failed')).toBeNull();
      expect(pathTo(kind, 'failed', 'failed')).toEqual([]);
    }
  });

  test('a step that jumps ahead goes through in_progress, except a forced decommission', () => {
    expect(pathTo('drain', 'pending', 'succeeded')).toEqual([
      'in_progress',
      'succeeded',
    ]);
    expect(pathTo('restart', 'pending', 'succeeded')).toEqual([
      'in_progress',
      'succeeded',
    ]);
    expect(pathTo('decommission', 'pending', 'succeeded')).toEqual([
      'succeeded',
    ]);
    expect(canTransition('drain', 'pending', 'succeeded')).toBe(false);
  });

  test('every table entry names only known statuses and never loops back', () => {
    for (const kind of OPERATION_KINDS)
      for (const from of OPERATION_STATUSES)
        for (const to of TRANSITIONS[kind][from]) {
          expect(OPERATION_STATUSES).toContain(to);
          expect(to).not.toBe(from);
          expect(isActive(from)).toBe(true);
        }
  });

  test('timeouts default per kind and honour a bounded override', () => {
    for (const kind of OPERATION_KINDS)
      expect(timeoutSecondsOf(operation(kind))).toBe(
        DEFAULT_TIMEOUT_SECONDS[kind]
      );
    expect(
      timeoutSecondsOf(operation('drain', { detail: { timeoutSeconds: 600 } }))
    ).toBe(600);
    expect(
      timeoutSecondsOf(operation('drain', { detail: { timeoutSeconds: 5 } }))
    ).toBe(DEFAULT_TIMEOUT_SECONDS.drain);
  });
});

const node = (over: Partial<RequestContext['node']> = {}) => ({
  id: 'a'.repeat(64),
  approval: 'approved' as const,
  status: 'online' as const,
  role: 'ci' as const,
  rebootEnabled: true,
  ...over,
});

const REPLACEMENT = {
  id: 'b'.repeat(64),
  approval: 'pending' as const,
  role: null,
};

describe('request invariants', () => {
  const cases: {
    name: string;
    ctx: RequestContext;
    expected: { ok: true; immediate?: boolean } | { ok: false; code: string };
  }[] = [
    {
      name: 'drain an online node',
      ctx: { kind: 'drain', node: node(), active: [], force: false },
      expected: { ok: true },
    },
    {
      name: 'drain a pending node',
      ctx: {
        kind: 'drain',
        node: node({ approval: 'pending' }),
        active: [],
        force: false,
      },
      expected: { ok: false, code: 'not_approved' },
    },
    {
      name: 'drain a retired node',
      ctx: {
        kind: 'drain',
        node: node({ approval: 'retired' }),
        active: [],
        force: false,
      },
      expected: { ok: false, code: 'not_approved' },
    },
    {
      name: 'a second drain',
      ctx: {
        kind: 'drain',
        node: node(),
        active: [operation('drain')],
        force: false,
      },
      expected: { ok: false, code: 'operation_in_progress' },
    },
    {
      name: 'drain while decommissioning',
      ctx: {
        kind: 'drain',
        node: node(),
        active: [operation('decommission')],
        force: false,
      },
      expected: { ok: false, code: 'operation_in_progress' },
    },
    {
      name: 'drain beside a restart is fine',
      ctx: {
        kind: 'drain',
        node: node(),
        active: [operation('restart')],
        force: false,
      },
      expected: { ok: true },
    },
    {
      name: 'restart',
      ctx: { kind: 'restart', node: node(), active: [], force: false },
      expected: { ok: true },
    },
    {
      name: 'restart with reboots disabled',
      ctx: {
        kind: 'restart',
        node: node({ rebootEnabled: false }),
        active: [],
        force: false,
      },
      expected: { ok: false, code: 'reboots_disabled' },
    },
    {
      name: 'a second restart',
      ctx: {
        kind: 'restart',
        node: node(),
        active: [operation('restart', { status: 'in_progress' })],
        force: false,
      },
      expected: { ok: false, code: 'operation_in_progress' },
    },
    {
      name: 'restart a node being decommissioned',
      ctx: {
        kind: 'restart',
        node: node(),
        active: [operation('decommission')],
        force: false,
      },
      expected: { ok: false, code: 'operation_in_progress' },
    },
    {
      name: 'replace with a pending machine',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: REPLACEMENT,
      },
      expected: { ok: true },
    },
    {
      name: 'replace without naming one',
      ctx: { kind: 'replace', node: node(), active: [], force: false },
      expected: { ok: false, code: 'invalid_replacement' },
    },
    {
      name: 'replace with an unknown machine',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: null,
      },
      expected: { ok: false, code: 'invalid_replacement' },
    },
    {
      name: 'replace a node with itself',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: { ...REPLACEMENT, id: node().id },
      },
      expected: { ok: false, code: 'invalid_replacement' },
    },
    {
      name: 'replace with a rejected machine',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: { ...REPLACEMENT, approval: 'rejected' },
      },
      expected: { ok: false, code: 'invalid_replacement' },
    },
    {
      name: 'replace with a machine of another role',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: { ...REPLACEMENT, role: 'devbox' },
      },
      expected: { ok: false, code: 'invalid_replacement' },
    },
    {
      name: 'replace with a machine already holding the role',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: { ...REPLACEMENT, role: 'ci' },
      },
      expected: { ok: true },
    },
    {
      name: 'replace with a machine another replace uses',
      ctx: {
        kind: 'replace',
        node: node(),
        active: [],
        force: false,
        replacement: REPLACEMENT,
        replacementsInUse: [REPLACEMENT.id],
      },
      expected: { ok: false, code: 'invalid_replacement' },
    },
    {
      name: 'replace a roleless node',
      ctx: {
        kind: 'replace',
        node: node({ role: null }),
        active: [],
        force: false,
        replacement: REPLACEMENT,
      },
      expected: { ok: false, code: 'no_role' },
    },
    {
      name: 'decommission an online node drains first',
      ctx: { kind: 'decommission', node: node(), active: [], force: false },
      expected: { ok: true, immediate: false },
    },
    {
      name: 'decommission a stale node',
      ctx: {
        kind: 'decommission',
        node: node({ status: 'stale' }),
        active: [],
        force: false,
      },
      expected: { ok: true, immediate: false },
    },
    {
      name: 'decommission an offline node without force',
      ctx: {
        kind: 'decommission',
        node: node({ status: 'offline' }),
        active: [],
        force: false,
      },
      expected: { ok: false, code: 'drain_unprovable' },
    },
    {
      name: 'forced decommission of an offline node',
      ctx: {
        kind: 'decommission',
        node: node({ status: 'offline' }),
        active: [],
        force: true,
      },
      expected: { ok: true, immediate: true },
    },
    {
      name: 'force on a reachable node',
      ctx: { kind: 'decommission', node: node(), active: [], force: true },
      expected: { ok: false, code: 'force_requires_unreachable' },
    },
    {
      name: 'decommission during a restart',
      ctx: {
        kind: 'decommission',
        node: node(),
        active: [operation('restart')],
        force: false,
      },
      expected: { ok: false, code: 'operation_in_progress' },
    },
    {
      name: 'decommission after a drain adopts the cordon',
      ctx: {
        kind: 'decommission',
        node: node(),
        active: [operation('drain')],
        force: false,
      },
      expected: { ok: true, immediate: false },
    },
  ];
  for (const { name, ctx, expected } of cases)
    test(name, () => {
      const plan = planRequest(ctx);
      if (expected.ok) {
        expect(plan).toEqual({
          ok: true,
          immediate: expected.immediate ?? false,
        });
      } else {
        expect(plan).toMatchObject({ ok: false, code: expected.code });
        if (!plan.ok) expect(plan.message.length).toBeGreaterThan(20);
      }
    });

  test('the refusal names the conflicting operation', () => {
    const plan = planRequest({
      kind: 'restart',
      node: node(),
      active: [operation('restart', { id: 'abc' })],
      force: false,
    });
    expect(plan).toMatchObject({ ok: false, conflictId: 'abc' });
  });

  test('the exclusion table is symmetric except that a decommission adopts an earlier drain', () => {
    for (const a of OPERATION_KINDS)
      for (const b of EXCLUDES[a])
        if (!(a === 'drain' && b === 'decommission'))
          expect(EXCLUDES[b]).toContain(a);
    expect(EXCLUDES.decommission).not.toContain('drain');
  });
});

describe('typed confirmation', () => {
  const named = { hostname: 'ci-a3f9', displayName: 'Rack 1' };
  test('accepts the label or the hostname, trimmed, and nothing else', () => {
    expect(confirmationFor(named)).toBe('Rack 1');
    expect(confirmationFor({ hostname: 'ci-a3f9', displayName: null })).toBe(
      'ci-a3f9'
    );
    expect(confirmationMatches('Rack 1', named)).toBe(true);
    expect(confirmationMatches(' ci-a3f9 ', named)).toBe(true);
    expect(confirmationMatches('rack 1', named)).toBe(false);
    expect(confirmationMatches('yes', named)).toBe(false);
    expect(confirmationMatches('', named)).toBe(false);
    expect(confirmationMatches(undefined, named)).toBe(false);
    expect(confirmationMatches(true, named)).toBe(false);
  });
});
