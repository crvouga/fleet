import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_TIMEOUT_SECONDS,
  OPERATION_KINDS,
  isTerminal,
  pathTo,
  type Operation,
  type OperationKind,
} from '../../src/domain/operations';
import {
  CLOCK_SKEW_SECONDS,
  reconcileOperation,
  type NodeObservation,
  type ReplacementObservation,
  type Step,
} from '../../src/domain/operations-reconcile';
import {
  T0,
  later,
  observed,
  operation,
  replacementObserved,
} from '../support/operations';

const run = (
  op: Operation,
  node: Partial<NodeObservation> = {},
  replacement: ReplacementObservation | null = null,
  now = later(120)
): Step => reconcileOperation({ op, node: observed(node), replacement, now });

describe('drain', () => {
  const op = operation('drain');
  test('waits until the node reports after the request', () => {
    const step = run(op, { lastSeenAt: later(-10), appliedRevision: 'old' });
    expect(step).toMatchObject({ status: 'pending' });
    expect(step.progress).toContain('report');
  });
  test('waits for the node to apply the revision that holds the cordon', () => {
    const step = run(op, { appliedRevision: 'rev-1' });
    expect(step.status).toBe('pending');
    expect(step.progress).toContain('rev-1');
  });
  test('is in progress while jobs are running and admits no new ones', () => {
    const step = run(op, { busySlots: 2 });
    expect(step.status).toBe('in_progress');
    expect(step.progress).toContain('2 runner slots are still busy');
    expect(step.effects).toEqual([{ type: 'ensure-cordon' }]);
  });
  test('is in progress while the gate is not yet closed', () => {
    expect(run(op, { gateClosed: false }).status).toBe('in_progress');
  });
  test('succeeds only when acknowledged, idle and the gate is closed', () => {
    expect(run(op).status).toBe('succeeded');
    expect(run(op, { busySlots: null, gateClosed: null }).status).toBe(
      'succeeded'
    );
  });
  test('re-applies a cordon somebody removed', () => {
    const step = run(op, { cordoned: false });
    expect(step.status).not.toBe('succeeded');
    expect(step.effects).toEqual([{ type: 'ensure-cordon' }]);
  });
  test('fails after the timeout with the next step named', () => {
    const step = run(
      operation('drain', { status: 'in_progress' }),
      { busySlots: 1 },
      null,
      later(DEFAULT_TIMEOUT_SECONDS.drain + 1)
    );
    expect(step.status).toBe('failed');
    expect(step.failure).toContain('did not finish within 6 h');
    expect(step.failure).toContain('cancel this drain');
  });
});

describe('restart', () => {
  const op = operation('restart', {
    detail: { bootIdAtRequest: 'boot-0', restartAfter: T0.getTime() / 1000 },
  });
  test('does not count the old boot', () => {
    const step = run(op, { bootId: 'boot-0', uptimeSeconds: 90_000 });
    expect(step.status).toBe('in_progress');
    expect(step.progress).toContain('idle');
  });
  test('shows draining while a job runs', () => {
    const step = run(op, { bootId: 'boot-0', busySlots: 3 });
    expect(step.progress).toContain('3 runner slots are still busy');
    expect(step.detail).toEqual({ stage: 'draining' });
  });
  test('waits for the node to apply the request first', () => {
    expect(run(op, { bootId: 'boot-0', appliedRevision: 'x' }).status).toBe(
      'pending'
    );
  });
  test('succeeds on a new boot that started after the request', () => {
    const step = run(op, {
      bootId: 'boot-1',
      uptimeSeconds: 30,
      lastSeenAt: later(200),
    });
    expect(step.status).toBe('succeeded');
  });
  test('a new boot id that started well before the request is not proof', () => {
    const step = run(op, {
      bootId: 'boot-1',
      uptimeSeconds: 100_000,
      lastSeenAt: later(200),
    });
    expect(step.status).not.toBe('succeeded');
  });
  test('tolerates clock skew in the boot start', () => {
    const step = run(op, {
      bootId: 'boot-1',
      lastSeenAt: later(200),
      uptimeSeconds: 200 + CLOCK_SKEW_SECONDS - 1,
    });
    expect(step.status).toBe('succeeded');
  });
  test('without a boot id at request time, uptime is the proof', () => {
    const unknown = operation('restart', { detail: {} });
    expect(
      run(unknown, { uptimeSeconds: 20, lastSeenAt: later(300) }).status
    ).toBe('succeeded');
    expect(run(unknown, { uptimeSeconds: 50_000 }).status).not.toBe(
      'succeeded'
    );
  });
  test('fails at once when reboots were turned off', () => {
    const step = run(op, { rebootEnabled: false });
    expect(step.status).toBe('failed');
    expect(step.failure).toContain('reboot.enabled');
  });
  test('an offline node fails at the timeout with guidance', () => {
    const step = run(op, { lastSeenAt: later(-5) }, null, later(3 * 3600 + 5));
    expect(step.status).toBe('failed');
    expect(step.failure).toContain('Check power and network');
  });
});

describe('decommission', () => {
  const op = operation('decommission');
  test('drains before it retires', () => {
    const step = run(op, { busySlots: 1 });
    expect(step.status).toBe('in_progress');
    expect(step.effects).toEqual([{ type: 'ensure-cordon' }]);
    expect(step.detail).toEqual({ stage: 'draining' });
  });
  test('retires once drained', () => {
    const step = run(op);
    expect(step.effects).toEqual([{ type: 'retire-node' }]);
    expect(step.detail).toEqual({ stage: 'retiring' });
  });
  test('never retires on an unacknowledged cordon', () => {
    const step = run(op, { appliedRevision: 'old' });
    expect(step.effects.map((e) => e.type)).not.toContain('retire-node');
  });
  test('is done when somebody else already retired the node', () => {
    expect(run(op, { approval: 'retired' }).status).toBe('succeeded');
  });
  test('names the forced route when the drain times out', () => {
    const step = run(op, { busySlots: 4 }, null, later(7 * 3600));
    expect(step.status).toBe('failed');
    expect(step.failure).toContain('force');
  });
});

describe('replace', () => {
  const op = operation('replace', {
    detail: { replacement: 'b'.repeat(64), role: 'ci' },
  });
  test('waits for the replacement to be approved', () => {
    const step = run(
      op,
      {},
      replacementObserved({ approval: 'pending', role: null })
    );
    expect(step.status).toBe('in_progress');
    expect(step.detail).toEqual({ stage: 'awaiting-approval' });
  });
  test('hands the old role to an approved replacement without one', () => {
    const step = run(
      op,
      { cordoned: true },
      replacementObserved({ role: null, converged: false })
    );
    expect(step.effects).toContainEqual({
      type: 'assign-role',
      nodeId: 'b'.repeat(64),
      role: 'ci',
    });
  });
  test('succeeds when the replacement has the role and converged', () => {
    expect(run(op, {}, replacementObserved()).status).toBe('succeeded');
  });
  test('shows the replacement’s own blocking issue', () => {
    const step = run(
      op,
      {},
      replacementObserved({
        converged: false,
        reconcileIssue: 'FLEET_SECRETS_RECIPIENT_MISSING',
      })
    );
    expect(step.progress).toContain('FLEET_SECRETS_RECIPIENT_MISSING');
  });
  test.each([
    ['deleted', null],
    ['rejected', replacementObserved({ approval: 'rejected' })],
    ['retired', replacementObserved({ approval: 'retired' })],
    ['given another role', replacementObserved({ role: 'devbox' })],
  ])('fails when the replacement is %s', (_name, replacement) => {
    const step = run(op, {}, replacement);
    expect(step.status).toBe('failed');
    expect(step.failure).not.toBeNull();
  });
  test('waits two weeks by default for hardware', () => {
    const step = run(
      op,
      {},
      replacementObserved({ approval: 'pending', role: null }),
      later(13 * 86400)
    );
    expect(step.status).toBe('in_progress');
    expect(
      run(
        op,
        {},
        replacementObserved({ approval: 'pending', role: null }),
        later(15 * 86400)
      ).status
    ).toBe('failed');
  });
});

describe('every kind', () => {
  test('a deleted node fails the operation', () => {
    for (const kind of OPERATION_KINDS) {
      const step = run(operation(kind), { exists: false });
      expect(step.status).toBe('failed');
      expect(step.failure).toContain('deleted');
    }
  });
  test('a rejected or retired node cancels it (a retired node completes a decommission)', () => {
    for (const kind of OPERATION_KINDS)
      for (const approval of ['rejected', 'retired'] as const) {
        const step = run(operation(kind), { approval });
        expect(step.status).toBe(
          kind === 'decommission' && approval === 'retired'
            ? 'succeeded'
            : 'cancelled'
        );
      }
  });
  test('reconciling is a pure function of its input', () => {
    for (const kind of OPERATION_KINDS) {
      const op = operation(kind, { detail: { replacement: 'b'.repeat(64) } });
      expect(run(op, {}, replacementObserved())).toEqual(
        run(op, {}, replacementObserved())
      );
    }
  });
});

/** mulberry32: a tiny seeded generator so a failure can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

function randomNode(random: () => number): NodeObservation {
  const revision = pick(random, ['rev-1', 'rev-2', null]);
  return {
    exists: random() > 0.04,
    approval: pick(random, [
      'approved',
      'approved',
      'approved',
      'pending',
      'retired',
      'rejected',
    ] as const),
    role: pick(random, ['ci', 'devbox', null] as const),
    lastSeenAt:
      random() > 0.1 ? later(Math.floor(random() * 4000) - 200) : null,
    bootId: pick(random, ['boot-0', 'boot-1', null]),
    uptimeSeconds: random() > 0.2 ? Math.floor(random() * 200_000) : null,
    busySlots: pick(random, [0, 0, 1, 3, null]),
    gateClosed: pick(random, [true, false, null]),
    appliedRevision: revision,
    desiredRevision: 'rev-2',
    cordoned: random() > 0.2,
    rebootEnabled: random() > 0.1,
    converged: random() > 0.5,
    reconcileIssue: random() > 0.8 ? 'ISSUE' : null,
  };
}

function randomReplacement(
  random: () => number
): ReplacementObservation | null {
  if (random() > 0.9) return null;
  return {
    exists: random() > 0.1,
    approval: pick(random, [
      'pending',
      'approved',
      'approved',
      'rejected',
      'retired',
    ] as const),
    role: pick(random, ['ci', 'devbox', null] as const),
    converged: random() > 0.4,
    lastSeenAt: random() > 0.1 ? later(Math.floor(random() * 3000)) : null,
    reconcileIssue: null,
  };
}

/** What the service does with a step: walks the table, never leaving a terminal state. */
function advance(op: Operation, step: Step): Operation {
  const hops = pathTo(op.kind, op.status, step.status) ?? [];
  const status = hops.at(-1) ?? op.status;
  return { ...op, status, progress: step.progress, failure: step.failure };
}

interface Proof {
  readonly drained: boolean;
  readonly live: boolean;
}

function acknowledged(op: Operation, node: NodeObservation): boolean {
  return (
    node.lastSeenAt !== null &&
    node.lastSeenAt >= op.requestedAt &&
    node.appliedRevision !== null &&
    node.appliedRevision === node.desiredRevision
  );
}

function proofOf(op: Operation, node: NodeObservation): Proof {
  const idle = node.busySlots === null || node.busySlots === 0;
  const gateOpen = node.busySlots !== null && node.gateClosed === false;
  return {
    drained: node.cordoned && acknowledged(op, node) && idle && !gateOpen,
    live:
      node.exists &&
      node.approval !== 'retired' &&
      node.approval !== 'rejected',
  };
}

function assertSafeEffects(op: Operation, proof: Proof, step: Step): void {
  // Safety: nothing is retired before it is provably drained.
  if (step.effects.some((e) => e.type === 'retire-node')) {
    expect(proof.drained && proof.live).toBe(true);
    expect(op.kind).toBe('decommission');
  }
  // Effects are only requested of a live node, except assign-role to its replacement.
  if (!proof.live)
    expect(step.effects.filter((e) => e.type !== 'assign-role')).toEqual([]);
}

function assertRestartProof(op: Operation, node: NodeObservation): void {
  expect(node.exists && node.bootId !== null).toBe(true);
  const before = op.detail['bootIdAtRequest'];
  if (typeof before === 'string') expect(node.bootId).not.toBe(before);
}

function assertSuccessProof(
  op: Operation,
  node: NodeObservation,
  replacement: ReplacementObservation | null,
  proof: Proof
): void {
  if (op.kind === 'restart') assertRestartProof(op, node);
  if (op.kind === 'drain') expect(proof.drained && proof.live).toBe(true);
  if (op.kind !== 'replace') return;
  expect(replacement?.converged).toBe(true);
  expect(replacement?.approval).toBe('approved');
  expect(replacement?.role).toBe(node.role);
}

function assertSound(
  op: Operation,
  node: NodeObservation,
  replacement: ReplacementObservation | null,
  step: Step
): void {
  const proof = proofOf(op, node);
  assertSafeEffects(op, proof, step);
  if (step.status === 'succeeded' && op.kind !== 'decommission')
    assertSuccessProof(op, node, replacement, proof);
  // A failure always says what to do.
  if (step.status === 'failed')
    expect((step.failure ?? '').length).toBeGreaterThan(20);
}

describe('randomized invariants', () => {
  const kinds: readonly OperationKind[] = OPERATION_KINDS;
  test('2000 random reconcile sequences keep every invariant', () => {
    const random = rng(0xf1ee7);
    for (let sequence = 0; sequence < 2000; sequence += 1) {
      const kind = pick(random, kinds);
      let op = operation(kind, {
        detail: {
          replacement: 'b'.repeat(64),
          role: 'ci',
          ...(random() > 0.3 ? { bootIdAtRequest: 'boot-0' } : {}),
        },
      });
      for (let tick = 0; tick < 12; tick += 1) {
        const node = randomNode(random);
        const replacement =
          kind === 'replace' ? randomReplacement(random) : null;
        const now = later(
          Math.floor(random() * DEFAULT_TIMEOUT_SECONDS[kind] * 1.5)
        );
        const step = reconcileOperation({ op, node, replacement, now });
        const again = reconcileOperation({ op, node, replacement, now });
        expect(again).toEqual(step);
        assertSound(op, node, replacement, step);
        const next = advance(op, step);
        if (isTerminal(op.status)) expect(next.status).toBe(op.status);
        op = next;
      }
    }
  });
});
