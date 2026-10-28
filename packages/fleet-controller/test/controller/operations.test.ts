import { describe, expect, test } from 'bun:test';

import { sweepOperations } from '../../src/operations/reconcile';
import { CI_ENROLLMENT_TOKEN } from '../support/controller';
import { adminConfirmed } from '../support/confirm';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

const label = (n: number) => `ci-${nodeIdOf(n).slice(0, 4)}`;

describeController('operations API', (ctx) => {
  const enroll = (n: number, token = CI_ENROLLMENT_TOKEN) =>
    ctx().h.register(n, { enrollmentToken: token });
  const path = (n: number, action: string) =>
    `/v1/nodes/${nodeIdOf(n)}/${action}`;
  const op = (id: string) => ctx().h.admin('GET', `/v1/operations/${id}`);

  /** A heartbeat that acknowledges the controller's current desired document. */
  async function beat(
    n: number,
    overrides: Parameters<typeof heartbeatBody>[1] = {}
  ) {
    const { h } = ctx();
    const first = await h.asNode(
      n,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(n, overrides)
    );
    const revision: string | undefined = first.body.desired?.revision;
    if (revision === undefined) return first;
    return h.asNode(
      n,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(n, {
        ...overrides,
        agent: { version: '2', desiredRevision: revision },
      })
    );
  }
  const settingsOf = async (n: number) =>
    (await ctx().store.getSettings(`node:${nodeIdOf(n)}`))?.value ?? {};

  describe('drain and undrain', () => {
    test('records a cordon as desired state and proves the drain from reports', async () => {
      const { h, store } = ctx();
      await enroll(1);
      await beat(1);
      const started = await h.admin('POST', path(1, 'drain'), {
        reason: 'rack move',
      });
      expect(started.status).toBe(202);
      const id: string = started.body.operation.id;
      expect(started.body.operation).toMatchObject({
        kind: 'drain',
        status: 'pending',
        requestedBy: 'admin-token',
      });
      expect(await settingsOf(1)).toEqual({ runners: { cordoned: true } });
      expect((await store.operations.lifecycle(nodeIdOf(1)))?.drainReason).toBe(
        'rack move'
      );
      h.clock.advance(30);
      // Busy: acknowledged but not drained yet.
      await beat(1, { runners: { slots: 4, busy: 2 } });
      expect((await op(id)).body.operation).toMatchObject({
        status: 'in_progress',
        progress: expect.stringContaining('2 runner slots are still busy'),
      });
      h.clock.advance(30);
      await beat(1, { runners: { slots: 4, busy: 0 } });
      const done = (await op(id)).body.operation;
      expect(done.status).toBe('succeeded');
      expect(done.completedAt).not.toBeNull();
      const events = (await h.admin('GET', '/v1/events?limit=50')).body.events;
      expect(events.map((e: { kind: string }) => e.kind)).toEqual(
        expect.arrayContaining([
          'operation_requested',
          'operation_started',
          'operation_succeeded',
        ])
      );
    });

    test('is idempotent by key and exclusive per node', async () => {
      const { h } = ctx();
      await enroll(1);
      const key = { 'Idempotency-Key': 'drain-rack-1' };
      const first = await h.call('POST', path(1, 'drain'), {
        headers: {
          Authorization: `Bearer ${'a-very-long-admin-token-for-tests-0123456789'}`,
          ...key,
        },
      });
      const again = await h.call('POST', path(1, 'drain'), {
        headers: {
          Authorization: `Bearer ${'a-very-long-admin-token-for-tests-0123456789'}`,
          ...key,
        },
      });
      expect(first.status).toBe(202);
      expect(again).toMatchObject({ status: 200, body: { replayed: true } });
      expect(again.body.operation.id).toBe(first.body.operation.id);
      const second = await h.admin('POST', path(1, 'drain'));
      expect(second).toMatchObject({
        status: 409,
        body: {
          error: 'operation_in_progress',
          operationId: first.body.operation.id,
        },
      });
      const other = await h.call('POST', path(1, 'restart'), {
        headers: {
          Authorization: `Bearer ${'a-very-long-admin-token-for-tests-0123456789'}`,
          ...key,
        },
        json: { confirm: label(1) },
      });
      expect(other).toMatchObject({
        status: 409,
        body: { error: 'idempotency_conflict' },
      });
    });

    test('undrain cancels the drain, removes the cordon and says if another scope still cordons', async () => {
      const { h } = ctx();
      await enroll(1);
      const started = await h.admin('POST', path(1, 'drain'));
      const undrained = await h.admin('POST', path(1, 'undrain'));
      expect(undrained).toMatchObject({
        status: 200,
        body: {
          ok: true,
          cancelled: [started.body.operation.id],
          stillCordoned: false,
        },
      });
      expect(await settingsOf(1)).toEqual({});
      expect((await op(started.body.operation.id)).body.operation.status).toBe(
        'cancelled'
      );
      await h.admin('PUT', '/v1/settings/fleet', {
        runners: { cordoned: true },
      });
      const again = await h.admin('POST', path(1, 'undrain'));
      expect(again.body.stillCordoned).toBe(true);
    });

    test('a node that is not approved cannot be drained; an unknown one is 404', async () => {
      const { h } = ctx();
      await h.register(1);
      expect((await h.admin('POST', path(1, 'drain'))).body.error).toBe(
        'not_approved'
      );
      expect((await h.admin('POST', path(9, 'drain'))).status).toBe(404);
      expect((await h.admin('POST', path(9, 'undrain'))).status).toBe(404);
    });

    test('rejects unknown keys and a malformed idempotency key', async () => {
      const { h } = ctx();
      await enroll(1);
      expect(
        (await h.admin('POST', path(1, 'drain'), { force: true })).status
      ).toBe(400);
      expect(
        (
          await h.call('POST', path(1, 'drain'), {
            headers: {
              Authorization:
                'Bearer a-very-long-admin-token-for-tests-0123456789',
              'Idempotency-Key': 'bad key!',
            },
          })
        ).status
      ).toBe(400);
      expect(
        (await h.admin('POST', path(1, 'drain'), { reason: 'x'.repeat(201) }))
          .status
      ).toBe(400);
    });
  });

  describe('destructive confirmation', () => {
    test.each(['restart', 'replace', 'decommission'])(
      '%s needs the node name and says what to type',
      async (action) => {
        const { h, store } = ctx();
        await enroll(1);
        const body = action === 'replace' ? { replacement: nodeIdOf(2) } : {};
        for (const confirm of [undefined, 'yes', 'wrong-name']) {
          const reply = await h.admin('POST', path(1, action), {
            ...body,
            ...(confirm === undefined ? {} : { confirm }),
          });
          expect(reply.status).toBe(400);
          expect(reply.body).toMatchObject({
            error: 'confirmation_required',
            expected: label(1),
          });
          expect(reply.body.message).toContain(label(1));
        }
        expect(await store.operations.list({ limit: 10 })).toEqual([]);
        const audit = await store.listAudit({
          limit: 10,
          targetId: nodeIdOf(1),
        });
        expect(
          audit.every(
            (e) => e.outcome === 'denied' && e.action === `node.${action}`
          )
        ).toBe(true);
        expect(audit).toHaveLength(3);
      }
    );

    test('reject, retire and delete need it too and change nothing without it', async () => {
      const { h, store } = ctx();
      await h.register(1);
      for (const [method, p] of [
        ['POST', path(1, 'reject')],
        ['POST', path(1, 'retire')],
        ['DELETE', `/v1/nodes/${nodeIdOf(1)}`],
      ] as const) {
        const reply = await h.admin(method, p, { confirm: 'nope' });
        expect(reply).toMatchObject({
          status: 400,
          body: { error: 'confirmation_required' },
        });
        expect((await h.admin(method, p)).body.error).toBe(
          'confirmation_required'
        );
      }
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('pending');
      expect(
        (await adminConfirmed(h, 'POST', path(1, 'reject'), 1)).status
      ).toBe(200);
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('rejected');
    });

    test('the display name or the hostname both confirm', async () => {
      const { h } = ctx();
      await enroll(1);
      await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, {
        displayName: 'Rack 1',
      });
      expect(
        (await h.admin('POST', path(1, 'restart'), { confirm: 'Rack 1' }))
          .status
      ).toBe(202);
      await h.admin(
        'POST',
        '/v1/operations/' +
          (await h.admin('GET', '/v1/operations')).body.operations[0].id +
          '/cancel'
      );
      expect(
        (await h.admin('POST', path(1, 'restart'), { confirm: label(1) }))
          .status
      ).toBe(202);
    });
  });

  describe('restart', () => {
    test('is complete only when a new boot after the request is observed', async () => {
      const { h } = ctx();
      await enroll(1);
      await beat(1, { bootId: 'boot-0', uptimeSeconds: 90_000 });
      h.clock.advance(60);
      const started = await h.admin('POST', path(1, 'restart'), {
        confirm: label(1),
      });
      expect(started.status).toBe(202);
      const id: string = started.body.operation.id;
      const restartAfter = Math.floor(h.clock.now().getTime() / 1000);
      expect(await settingsOf(1)).toEqual({ maintenance: { restartAfter } });
      expect(started.body.operation.detail).toMatchObject({
        bootIdAtRequest: 'boot-0',
        restartAfter,
      });
      h.clock.advance(30);
      await beat(1, {
        bootId: 'boot-0',
        uptimeSeconds: 90_090,
        runners: { slots: 4, busy: 1 },
      });
      expect((await op(id)).body.operation).toMatchObject({
        status: 'in_progress',
        progress: expect.stringContaining('Draining before the restart'),
      });
      h.clock.advance(120);
      await beat(1, { bootId: 'boot-1', uptimeSeconds: 40 });
      expect((await op(id)).body.operation).toMatchObject({
        status: 'succeeded',
      });
      const lifecycle = await ctx().store.operations.lifecycle(nodeIdOf(1));
      expect(lifecycle?.restartCompletedAt).not.toBeNull();
    });

    test('refuses while reboots are disabled, and a timeout fails with guidance and withdraws the request', async () => {
      const { h, deps } = ctx().h && { h: ctx().h, deps: ctx().h.deps };
      await enroll(1);
      await beat(1, { bootId: 'boot-0' });
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        reboot: { enabled: false },
      });
      expect(
        (await h.admin('POST', path(1, 'restart'), { confirm: label(1) })).body
          .error
      ).toBe('reboots_disabled');
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        reboot: { enabled: true },
      });
      const started = await h.admin('POST', path(1, 'restart'), {
        confirm: label(1),
      });
      h.clock.advance(3 * 3600 + 60);
      await sweepOperations(deps);
      const failed = (await op(started.body.operation.id)).body.operation;
      expect(failed.status).toBe('failed');
      expect(failed.failure).toContain('did not finish within 3 h');
      // A restart that did not happen must not happen later.
      expect((await settingsOf(1))['maintenance']).toBeUndefined();
      const audit = await ctx().store.listAudit({
        limit: 20,
        targetId: nodeIdOf(1),
      });
      expect(audit.map((e) => e.action)).toContain('operation.restart.failed');
    });
  });

  describe('decommission', () => {
    test('drains, proves it, then retires', async () => {
      const { h, store } = ctx();
      await enroll(1);
      await beat(1);
      const started = await h.admin('POST', path(1, 'decommission'), {
        confirm: label(1),
      });
      const id: string = started.body.operation.id;
      expect(await settingsOf(1)).toEqual({ runners: { cordoned: true } });
      h.clock.advance(30);
      await beat(1, { runners: { slots: 4, busy: 3 } });
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('approved');
      expect((await op(id)).body.operation.status).toBe('in_progress');
      h.clock.advance(30);
      await beat(1, { runners: { slots: 4, busy: 0 } });
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('retired');
      expect((await op(id)).body.operation.status).toBe('succeeded');
      const audit = await store.listAudit({ limit: 20, targetId: nodeIdOf(1) });
      expect(audit.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          'node.decommission',
          'node.retire',
          'operation.decommission.succeeded',
        ])
      );
    });

    test('an offline node needs force; force refuses a reachable one', async () => {
      const { h, store } = ctx();
      await enroll(1);
      await beat(1);
      expect(
        (
          await h.admin('POST', path(1, 'decommission'), {
            confirm: label(1),
            force: true,
          })
        ).body.error
      ).toBe('force_requires_unreachable');
      h.clock.advance(3600);
      expect(
        (await h.admin('POST', path(1, 'decommission'), { confirm: label(1) }))
          .body.error
      ).toBe('drain_unprovable');
      const forced = await h.admin('POST', path(1, 'decommission'), {
        confirm: label(1),
        force: true,
      });
      expect(forced.status).toBe(202);
      expect(forced.body.operation.status).toBe('succeeded');
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('retired');
    });

    test('a stuck drain fails at the timeout and leaves the node cordoned, not retired', async () => {
      const { h, store } = ctx();
      await enroll(1);
      await beat(1);
      const started = await h.admin('POST', path(1, 'decommission'), {
        confirm: label(1),
        timeoutSeconds: 600,
      });
      h.clock.advance(30);
      await beat(1, { runners: { slots: 4, busy: 1 } });
      h.clock.advance(700);
      await beat(1, { runners: { slots: 4, busy: 1 } });
      const failed = (await op(started.body.operation.id)).body.operation;
      expect(failed.status).toBe('failed');
      expect(failed.failure).toContain('force');
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('approved');
      expect(await settingsOf(1)).toEqual({ runners: { cordoned: true } });
    });
  });

  describe('replace', () => {
    test('hands the role to an approved replacement and succeeds when it has converged', async () => {
      const { h, store } = ctx();
      await enroll(1);
      await beat(1);
      await h.register(2);
      const started = await h.admin('POST', path(1, 'replace'), {
        confirm: label(1),
        replacement: nodeIdOf(2),
      });
      expect(started.status).toBe(202);
      const id: string = started.body.operation.id;
      expect((await store.operations.lifecycle(nodeIdOf(1)))?.replacedBy).toBe(
        nodeIdOf(2)
      );
      h.clock.advance(30);
      await h.asNode(2, 'POST', '/v1/heartbeat', heartbeatBody(2));
      expect((await op(id)).body.operation).toMatchObject({
        status: 'in_progress',
        detail: { stage: 'awaiting-approval' },
      });
      await h.admin('POST', path(2, 'approve'));
      h.clock.advance(30);
      await beat(2);
      expect((await store.findNode(nodeIdOf(2)))?.role).toBe('ci');
      h.clock.advance(30);
      await beat(2, {
        reconcile: { phase: 'converged', issues: [] },
        closure: 'ci',
      });
      expect((await op(id)).body.operation.status).toBe('succeeded');
      expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('approved');
    });

    test('invalid replacements are refused with a reason', async () => {
      const { h } = ctx();
      await enroll(1);
      await enroll(2, CI_ENROLLMENT_TOKEN);
      await h.admin('PATCH', `/v1/nodes/${nodeIdOf(2)}`, { role: 'devbox' });
      const refuse = async (replacement: string | undefined) =>
        (
          await h.admin('POST', path(1, 'replace'), {
            confirm: label(1),
            ...(replacement === undefined ? {} : { replacement }),
          })
        ).body;
      expect((await refuse(undefined)).error).toBe('invalid_request');
      expect((await refuse(nodeIdOf(1))).error).toBe('invalid_replacement');
      expect((await refuse(nodeIdOf(9))).error).toBe('invalid_replacement');
      expect((await refuse(nodeIdOf(2))).error).toBe('invalid_replacement');
    });
  });

  describe('listing, cancelling and the audit trail', () => {
    test('lists newest first with filters and cursor paging; 400 on bad filters', async () => {
      const { h } = ctx();
      await enroll(1);
      await enroll(2);
      h.clock.advance(1);
      await h.admin('POST', path(1, 'drain'));
      h.clock.advance(1);
      await h.admin('POST', path(2, 'drain'));
      h.clock.advance(1);
      await h.admin('POST', path(2, 'restart'), { confirm: label(2) });
      const all = (await h.admin('GET', '/v1/operations')).body;
      expect(all.operations.map((o: { kind: string }) => o.kind)).toEqual([
        'restart',
        'drain',
        'drain',
      ]);
      const page = (await h.admin('GET', '/v1/operations?limit=2')).body;
      expect(page.operations).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
      const rest = (
        await h.admin(
          'GET',
          `/v1/operations?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`
        )
      ).body;
      expect(rest.operations).toHaveLength(1);
      expect(rest.nextCursor).toBeNull();
      expect(
        (await h.admin('GET', `/v1/operations?node=${nodeIdOf(1)}`)).body
          .operations
      ).toHaveLength(1);
      expect(
        (await h.admin('GET', '/v1/operations?kind=restart&active=1')).body
          .operations
      ).toHaveLength(1);
      expect((await h.admin('GET', '/v1/operations?kind=bogus')).status).toBe(
        400
      );
      expect((await h.admin('GET', '/v1/operations/nope')).status).toBe(404);
      expect((await h.call('GET', '/v1/operations')).status).toBe(401);
    });

    test('cancel returns the node to its previous settings and is final', async () => {
      const { h } = ctx();
      await enroll(1);
      const started = await h.admin('POST', path(1, 'restart'), {
        confirm: label(1),
      });
      const id: string = started.body.operation.id;
      expect(await settingsOf(1)).not.toEqual({});
      const cancelled = await h.admin('POST', `/v1/operations/${id}/cancel`);
      expect(cancelled.body.operation.status).toBe('cancelled');
      expect(await settingsOf(1)).toEqual({});
      expect(
        (await h.admin('POST', `/v1/operations/${id}/cancel`)).status
      ).toBe(409);
      expect((await h.admin('POST', '/v1/operations/nope/cancel')).status).toBe(
        404
      );
    });

    test('every admin node action is audited with its actor, including denials', async () => {
      const { h, store } = ctx();
      await h.register(1);
      await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { note: 'hello' });
      await h.admin('POST', path(1, 'approve'));
      await h.admin('POST', path(1, 'retire'));
      await adminConfirmed(h, 'POST', path(1, 'retire'), 1);
      await adminConfirmed(h, 'DELETE', `/v1/nodes/${nodeIdOf(1)}`, 1);
      await adminConfirmed(h, 'DELETE', `/v1/nodes/${nodeIdOf(1)}`, 1);
      const rows = [...(await store.listAudit({ limit: 50 }))].reverse();
      expect(rows.map((r) => [r.action, r.outcome])).toEqual([
        ['node.patch', 'success'],
        ['node.approve', 'success'],
        ['node.retire', 'denied'],
        ['node.retire', 'success'],
        ['node.delete', 'success'],
        ['node.delete', 'failed'],
      ]);
      expect(new Set(rows.map((r) => r.actor))).toEqual(
        new Set(['admin-token'])
      );
      expect(JSON.stringify(rows)).not.toContain('secret');
    });

    test('GET /v1/audit pages and filters, for administrators', async () => {
      const { h } = ctx();
      await enroll(1);
      await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, { note: 'x' });
      await h.admin('POST', path(1, 'drain'));
      await h.admin('POST', path(1, 'undrain'));
      const all = (await h.admin('GET', '/v1/audit?limit=2')).body;
      expect(all.entries).toHaveLength(2);
      expect(all.entries[0].action).toBe('node.undrain');
      expect(all.nextBefore).not.toBeNull();
      const older = (
        await h.admin('GET', `/v1/audit?before=${String(all.nextBefore)}`)
      ).body;
      expect(older.entries[0].action).toBe('node.patch');
      expect(
        (
          await h.admin(
            'GET',
            `/v1/audit?target=${nodeIdOf(1)}&kind=node&actor=admin-token`
          )
        ).body.entries.length
      ).toBeGreaterThan(0);
      expect(
        (await h.admin('GET', '/v1/audit?actor=nobody')).body.entries
      ).toEqual([]);
      expect((await h.admin('GET', '/v1/audit?limit=abc')).status).toBe(400);
      expect((await h.call('GET', '/v1/audit')).status).toBe(401);
    });
  });

  describe('heartbeat safety', () => {
    test('a failing operations store never fails a heartbeat', async () => {
      const { h, store } = ctx();
      await enroll(1);
      const original = store.operations.listActiveFor.bind(store.operations);
      store.operations.listActiveFor = async () => {
        throw new Error('database is busy');
      };
      try {
        expect((await beat(1)).status).toBe(200);
      } finally {
        store.operations.listActiveFor = original;
      }
      expect(h).toBeDefined();
    });
  });
});

describe('operation fixtures', () => {
  test('describeController provides a harness', () => {
    expect(label(1)).toMatch(/^ci-[0-9a-f]{4}$/);
  });
});
