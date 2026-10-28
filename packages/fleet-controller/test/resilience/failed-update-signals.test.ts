import { expect, test } from 'bun:test';

import { recoveryView } from '../../src/domain/recovery';
import type { RecoveryFacts } from '../../src/types';
import { nodeIdOf } from '../support/fixtures';

import { countOf, eventKinds } from './support/probe';
import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode } from './support/sim-node';

const ID = nodeIdOf(1);
const ROLLED_BACK = {
  sync: {
    rolledBack: true,
    healthFailure: 'nginx failed its health check',
    paused: false,
  },
};
const HEALTHY = {
  sync: { rolledBack: false, healthFailure: null, paused: false },
};
const blocked = (...issues: string[]) => ({
  reconcile: { phase: 'blocked' as const, issues },
});
const phase = (name: 'converged' | 'progressing') => ({
  reconcile: { phase: name, issues: [] },
});

async function view(p: ControllerProcess) {
  return (await p.h.admin('GET', `/v1/nodes/${ID}`)).body.node;
}

async function gauge(
  p: ControllerProcess,
  name: string
): Promise<string | undefined> {
  const text = (await p.h.admin('GET', '/metrics')).text;
  return text
    .split('\n')
    .find((line) => line.startsWith(`${name}{`))
    ?.split(' ')
    .at(-1);
}

describeRig(
  'Resilience (Req 11): failed update, rollback and blocked reconcile signalling',
  (rig) => {
    async function enrolled() {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h, {
        readiness: { issues: [] },
        ...phase('converged'),
      });
      return { p, node };
    }

    test('a rollback is announced once however long it persists, cleared once, and a second rollback is a second event', async () => {
      const { p, node } = await enrolled();
      for (let i = 0; i < 6; i += 1) await node.beat(p.h, ROLLED_BACK);
      let kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'rollback')).toBe(1);
      const stored = await p.store.listEvents({ nodeId: ID, limit: 50 });
      const rollback = stored.find((e) => e.kind === 'rollback');
      expect(rollback).toMatchObject({ severity: 'error' });
      expect(rollback?.message).toContain('nginx failed its health check');
      for (let i = 0; i < 3; i += 1) await node.beat(p.h, HEALTHY);
      kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'rollback_cleared')).toBe(1);
      await node.beat(p.h, ROLLED_BACK);
      kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'rollback')).toBe(2);
      expect(countOf(kinds, 'rollback_cleared')).toBe(1);
    });

    test('a rollback the agent already described is not announced twice, even when resent', async () => {
      const { p, node } = await enrolled();
      const own = [
        {
          kind: 'rollback',
          severity: 'error' as const,
          message: 'rolled back: bad closure',
          key: 'rollback:abc',
        },
      ];
      for (let i = 0; i < 3; i += 1)
        await node.beat(p.h, { ...ROLLED_BACK, events: own });
      expect(countOf(await eventKinds(p.store, ID), 'rollback')).toBe(1);
    });

    test('the readiness gauge goes to 0 while rolled back or health failing and returns to 1 when the node is healthy', async () => {
      const { p, node } = await enrolled();
      const ready = { readiness: { issues: [] } };
      await node.beat(p.h, { ...ready, ...HEALTHY });
      expect(await gauge(p, 'fleet_node_ready')).toBe('1');
      await node.beat(p.h, { ...ready, ...ROLLED_BACK });
      expect(await gauge(p, 'fleet_node_ready')).toBe('0');
      await node.beat(p.h, { ...ready, ...HEALTHY });
      expect(await gauge(p, 'fleet_node_ready')).toBe('1');
      // A health failure without a rollback is surfaced as not ready but is not a rollback event.
      await node.beat(p.h, {
        ...ready,
        sync: {
          rolledBack: false,
          healthFailure: 'timer inactive',
          paused: false,
        },
      });
      expect(await gauge(p, 'fleet_node_ready')).toBe('0');
      // Still only the earlier real rollback: a health failure alone is not one.
      expect(countOf(await eventKinds(p.store, ID), 'rollback')).toBe(1);
    });

    test('blocked reconcile: one event per entry into blocked, convergence blocked, no spam while issues change', async () => {
      const { p, node } = await enrolled();
      expect((await view(p)).convergence).toBe('converged');
      expect(await gauge(p, 'fleet_node_converged')).toBe('1');
      await node.beat(
        p.h,
        blocked('role secrets: node is not a SOPS recipient')
      );
      await node.beat(
        p.h,
        blocked('role secrets: node is not a SOPS recipient')
      );
      await node.beat(p.h, blocked('a different issue now', 'and another'));
      const after = await view(p);
      expect(after.convergence).toBe('blocked');
      expect(after.reconcileIssues).toEqual([
        'a different issue now',
        'and another',
      ]);
      expect(await gauge(p, 'fleet_node_converged')).toBe('0');
      let kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'reconcile_blocked')).toBe(1);
      const event = (await p.store.listEvents({ nodeId: ID, limit: 50 })).find(
        (e) => e.kind === 'reconcile_blocked'
      );
      expect(event?.message).toContain('SOPS recipient');
      expect(event?.severity).toBe('warn');

      await node.beat(p.h, phase('progressing'));
      expect((await view(p)).convergence).toBe('progressing');
      await node.beat(p.h, phase('converged'));
      expect((await view(p)).convergence).toBe('converged');
      kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'reconcile_blocked')).toBe(1); // clearing is visible as convergence, not as an event
      await node.beat(p.h, blocked('again'));
      expect(countOf(await eventKinds(p.store, ID), 'reconcile_blocked')).toBe(
        2
      );
    });

    test('convergence is computed from today desired state, never stored: a settings change un-converges a converged node', async () => {
      const { p, node } = await enrolled();
      expect((await view(p)).convergence).toBe('converged');
      await p.h.admin('PUT', '/v1/settings/fleet', {
        disk: { alertPercent: 75 },
      });
      expect((await view(p)).convergence).toBe('progressing');
      await node.settle(p.h, phase('converged'));
      expect((await view(p)).convergence).toBe('converged');
      // Same revision, wrong closure: not converged.
      await node.beat(p.h, {
        closure: 'devbox',
        role: 'devbox',
        ...phase('converged'),
      });
      expect((await view(p)).convergence).toBe('progressing');
    });

    test('a healthy first report announces nothing; only approved nodes get derived events', async () => {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await p.h.register(2); // pending
      await simNode(1).beat(p.h, { ...HEALTHY, ...phase('converged') });
      const bad = {
        ...ROLLED_BACK,
        ...blocked('x'),
        failedUnits: ['a.service'],
      };
      await simNode(2).beat(p.h, bad);
      await simNode(2).beat(p.h, { ...HEALTHY, ...phase('converged') });
      await simNode(2).beat(p.h, bad);
      const kinds = await eventKinds(p.store);
      for (const derived of [
        'boot',
        'revision',
        'role_converged',
        'rollback',
        'rollback_cleared',
        'reconcile_blocked',
        'units_failed',
        'units_recovered',
      ]) {
        expect([derived, countOf(kinds, derived)]).toEqual([derived, 0]);
      }
    });

    // PROTOCOL.md says "The first report is a baseline and announces none of
    // these". The code applies that to boot, revision and role_converged only:
    // a first report that is already rolled back, blocked, or has failed units or
    // a full disk announces them (once). This pins the behaviour and the
    // once-only guarantee; the mismatch is reported in docs/verification.md.
    test('a first report that is already unhealthy announces each condition once and never again', async () => {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      const bad = {
        ...ROLLED_BACK,
        ...blocked('x'),
        failedUnits: ['a.service'],
        disk: { nixUsedPercent: 97, bootUsedPercent: 5 },
      };
      for (let i = 0; i < 4; i += 1) await node.beat(p.h, bad);
      const kinds = await eventKinds(p.store, ID);
      for (const derived of [
        'rollback',
        'reconcile_blocked',
        'units_failed',
        'disk_high',
      ]) {
        expect([derived, countOf(kinds, derived)]).toEqual([derived, 1]);
      }
      for (const never of ['boot', 'revision', 'role_converged']) {
        expect(countOf(kinds, never)).toBe(0);
      }
    });

    test('failed units are named once per change and recovered once', async () => {
      const { p, node } = await enrolled();
      for (let i = 0; i < 4; i += 1)
        await node.beat(p.h, { failedUnits: ['a.service', 'b.service'] });
      await node.beat(p.h, { failedUnits: ['b.service', 'c.service'] });
      await node.beat(p.h, { failedUnits: [] });
      await node.beat(p.h, { failedUnits: [] });
      const events = await p.store.listEvents({ nodeId: ID, limit: 50 });
      const failed = events
        .filter((e) => e.kind === 'units_failed')
        .map((e) => e.message);
      expect(failed).toEqual([
        'failed units: c.service',
        'failed units: a.service, b.service',
      ]);
      expect(events.filter((e) => e.kind === 'units_recovered')).toHaveLength(
        2
      );
    });

    test('disk alerts fire at the effective threshold once, and clear once', async () => {
      const { p, node } = await enrolled();
      await p.h.admin('PUT', '/v1/settings/fleet', {
        disk: { alertPercent: 80 },
      });
      for (const used of [79, 80, 95, 95, 85, 79, 79]) {
        await node.beat(p.h, {
          disk: { nixUsedPercent: used, bootUsedPercent: 10 },
        });
      }
      const kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'disk_high')).toBe(1);
      expect(countOf(kinds, 'disk_ok')).toBe(1);
    });

    test('quarantine and the admission gate are stored per report, resent quarantine events are kept once, and the recovery view follows', async () => {
      const { p, node } = await enrolled();
      const quarantined: RecoveryFacts = {
        boot: {
          previousClean: true,
          previousEndedAt: null,
          uncleanOfLast: [0, 3],
        },
        quarantine: {
          revision: 'a'.repeat(40),
          toplevel: null,
          at: '2026-10-14T11:00:00Z',
          reason: 'boot failed twice',
        },
        gate: { closed: true, reasons: ['update'] },
        outbox: 1,
      };
      const event = [
        {
          kind: 'update-quarantined',
          severity: 'error' as const,
          message: 'kernel quarantined',
          key: 'quarantine:aaaa',
        },
      ];
      for (let i = 0; i < 3; i += 1)
        await node.beat(p.h, { recovery: quarantined, events: event });
      expect(countOf(await eventKinds(p.store, ID), 'update-quarantined')).toBe(
        1
      );
      const stored = await p.store.findNode(ID);
      const events = await p.store.listEvents({ nodeId: ID, limit: 50 });
      const bad = recoveryView(
        stored?.facts ?? {},
        events,
        rig().clock.now(),
        'ci'
      );
      expect(bad.state).toBe('attention');
      expect(bad.items.find((i) => i.action === 'retry-update')).toBeDefined();
      expect(
        bad.items.find((i) => i.label === 'Runner admission')?.detail
      ).toContain('update is draining');

      const cleared: RecoveryFacts = {
        ...quarantined,
        quarantine: null,
        gate: { closed: false, reasons: [] },
        outbox: 0,
      };
      await node.beat(p.h, {
        recovery: cleared,
        events: [
          {
            kind: 'gate-reopened',
            severity: 'info',
            message: 'admission reopened',
            key: 'gate:1',
          },
        ],
      });
      await node.beat(p.h, {
        recovery: cleared,
        events: [
          {
            kind: 'gate-reopened',
            severity: 'info',
            message: 'admission reopened',
            key: 'gate:1',
          },
        ],
      });
      const after = await p.store.findNode(ID);
      const later = await p.store.listEvents({ nodeId: ID, limit: 50 });
      expect(
        countOf(
          later.map((e) => e.kind),
          'gate-reopened'
        )
      ).toBe(1);
      const good = recoveryView(
        after?.facts ?? {},
        later,
        rig().clock.now(),
        'ci'
      );
      expect(
        good.items.find((i) => i.action === 'retry-update')
      ).toBeUndefined();
      expect(good.state).not.toBe('attention');
    });
  }
);
