import { expect, test } from 'bun:test';

import { sweepOperations } from '../../src/operations/reconcile';
import { adminConfirmed } from '../support/confirm';
import { ADMIN_TOKEN, type Harness } from '../support/controller';
import { heartbeatBody, nodeIdOf, secretOf, sha256 } from '../support/fixtures';

import { countOf, eventKinds } from './support/probe';
import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode } from './support/sim-node';

const ID = nodeIdOf(1);
const NAME = `ci-${ID.slice(0, 4)}`;
const path = (action: string, n = 1) => `/v1/nodes/${nodeIdOf(n)}/${action}`;
const NEXT = sha256('next-secret-a');
const NEXT_B = sha256('next-secret-b');

const adminHeaders = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${ADMIN_TOKEN}`,
  ...extra,
});

const operationOf = async (h: Harness, id: string) =>
  (await h.admin('GET', `/v1/operations/${id}`)).body.operation;

/** The node authenticates with an arbitrary secret (the harness only knows secretOf(n)). */
/** POSTs to `url` as node 1 holding `secret`, with a JSON body. */
const post = (h: Harness, secret: string, url: string, json: unknown) =>
  h.call('POST', url, {
    headers: { Authorization: `Bearer ${ID}.${secret}` },
    json,
  });
const beatAs = (h: Harness, secret: string) =>
  post(h, secret, '/v1/heartbeat', heartbeatBody(1));
const offer = (h: Harness, secret: string, next: string) =>
  post(h, secret, '/v1/credential/rotate', { nextSecretHash: sha256(next) });

describeRig(
  'Resilience (Req 11): operations under timeout, duplication and races',
  (rig) => {
    async function enrolled() {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const node = simNode(1);
      await node.settle(p.h, { bootId: 'boot-0', uptimeSeconds: 90_000 });
      return { p, node };
    }

    test('a drain on a silent node times out with guidance, audits it and leaves the cordon in place', async () => {
      const { p } = await enrolled();
      const started = await p.h.admin('POST', path('drain'), {
        timeoutSeconds: 600,
      });
      const id: string = started.body.operation.id;
      rig().clock.advance(601);
      expect(await sweepOperations(p.h.deps)).toBe(1);
      const failed = await operationOf(p.h, id);
      expect(failed.status).toBe('failed');
      expect(failed.failure).toEqual(expect.any(String));
      expect(failed.failure.length).toBeGreaterThan(10);
      expect(failed.completedAt).not.toBeNull();
      // The failed drain leaves the cordon; undrain returns the node to service.
      const settings = (await p.store.getSettings(`node:${ID}`))?.value;
      expect(settings).toEqual({ runners: { cordoned: true } });
      expect((await p.h.admin('POST', path('undrain'))).body.ok).toBe(true);
      expect((await p.store.getSettings(`node:${ID}`))?.value).toEqual({});
      // Sweeping again changes nothing: final is final.
      expect(await sweepOperations(p.h.deps)).toBe(0);
      expect(countOf(await eventKinds(p.store, ID), 'operation_failed')).toBe(
        1
      );
    });

    test('a restart succeeds only on a new boot id that began after the request', async () => {
      const { p, node } = await enrolled();
      const { clock } = rig();
      clock.advance(60);
      const started = await adminConfirmed(p.h, 'POST', path('restart'), 1);
      const id: string = started.body.operation.id;
      const progress = async () => (await operationOf(p.h, id)).status;
      clock.advance(30);
      await node.settle(p.h, { bootId: 'boot-0', uptimeSeconds: 90_090 });
      expect(await progress()).toBe('in_progress');
      // A different boot id whose boot began long before the request proves nothing.
      await node.beat(p.h, { bootId: 'boot-older', uptimeSeconds: 500_000 });
      expect(await progress()).toBe('in_progress');
      // The same boot id with a larger uptime is the same boot.
      await node.beat(p.h, { bootId: 'boot-0', uptimeSeconds: 90_200 });
      expect(await progress()).toBe('in_progress');
      // The node comes back from a real reboot.
      clock.advance(120);
      await node.settle(p.h, { bootId: 'boot-1', uptimeSeconds: 40 });
      expect(await progress()).toBe('succeeded');
      // Later reports, even more reboots, never reopen or repeat it.
      clock.advance(600);
      await node.beat(p.h, { bootId: 'boot-2', uptimeSeconds: 10 });
      expect(await progress()).toBe('succeeded');
      const kinds = await eventKinds(p.store, ID);
      expect(countOf(kinds, 'operation_succeeded')).toBe(1);
      // The request is not re-issued: its time is the original one, so a node
      // that already booted after it (its durable marker) never reboots again.
      const requestedAt = Math.floor(
        new Date(started.body.operation.requestedAt).getTime() / 1000
      );
      expect(
        (
          (await p.store.getSettings(`node:${ID}`))?.value as {
            maintenance?: { restartAfter?: number };
          }
        ).maintenance?.restartAfter
      ).toBe(requestedAt);
    });

    test('the same Idempotency-Key sent six times at once yields one operation', async () => {
      const { p } = await enrolled();
      const send = () =>
        p.h.call('POST', path('drain'), {
          headers: adminHeaders({ 'Idempotency-Key': 'rack-move-1' }),
        });
      const replies = await Promise.all(Array.from({ length: 6 }, send));
      expect(replies.filter((r) => r.status === 202)).toHaveLength(1);
      expect(
        replies.filter((r) => r.status === 200 && r.body.replayed === true)
      ).toHaveLength(5);
      expect(new Set(replies.map((r) => r.body.operation.id)).size).toBe(1);
      expect(await p.store.operations.list({ limit: 20 })).toHaveLength(1);
      expect(
        countOf(await eventKinds(p.store, ID), 'operation_requested')
      ).toBe(1);
    });

    test('distinct concurrent requests keep at most one active operation per node and kind', async () => {
      const { p } = await enrolled();
      const confirmed = { confirm: NAME };
      const results = await Promise.all([
        p.h.admin('POST', path('drain')),
        p.h.admin('POST', path('drain')),
        p.h.admin('POST', path('restart'), confirmed),
        p.h.admin('POST', path('restart'), confirmed),
        p.h.admin('POST', path('decommission'), confirmed),
      ]);
      const accepted = results.filter((r) => r.status === 202);
      for (const reply of results.filter((r) => r.status !== 202))
        expect(reply.body.error).toBe('operation_in_progress');
      const active = (await p.h.admin('GET', '/v1/operations?active=1')).body
        .operations;
      const keys = active.map(
        (o: { kind: string; nodeId: string }) => `${o.nodeId}:${o.kind}`
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(active).toHaveLength(accepted.length);
      // A decommission excludes a restart beside it.
      const kinds: string[] = active.map((o: { kind: string }) => o.kind);
      expect(kinds.includes('decommission') && kinds.includes('restart')).toBe(
        false
      );
    });

    test('two concurrent cancels of one operation: one succeeds, the other is already_finished', async () => {
      const { p } = await enrolled();
      const id: string = (await p.h.admin('POST', path('drain'))).body.operation
        .id;
      const replies = await Promise.all([
        p.h.admin('POST', `/v1/operations/${id}/cancel`),
        p.h.admin('POST', `/v1/operations/${id}/cancel`),
      ]);
      expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await operationOf(p.h, id)).status).toBe('cancelled');
    });

    test('deleting a node fails its active operation on the next sweep, with no orphaned cordon row', async () => {
      const { p } = await enrolled();
      const id: string = (await p.h.admin('POST', path('drain'))).body.operation
        .id;
      await adminConfirmed(p.h, 'DELETE', `/v1/nodes/${ID}`, 1);
      await sweepOperations(p.h.deps);
      expect((await operationOf(p.h, id)).status).toBe('failed');
      expect(await p.store.getSettings(`node:${ID}`)).toBeNull();
    });

    test('a forced decommission of an unreachable node retires it, locks it out and a re-register is pending', async () => {
      const { p } = await enrolled();
      rig().clock.advance(3600);
      const refused = await adminConfirmed(
        p.h,
        'POST',
        path('decommission'),
        1
      );
      expect(refused.body.error).toBe('drain_unprovable');
      const forced = await p.h.admin('POST', path('decommission'), {
        confirm: NAME,
        force: true,
      });
      expect(forced.body.operation.status).toBe('succeeded');
      const refusedBeat = await beatAs(p.h, secretOf(1));
      expect(refusedBeat).toMatchObject({
        status: 403,
        body: { error: 'retired' },
      });
      expect((await p.h.register(1)).body.status).toBe('pending');
      const audit = await p.store.listAudit({ limit: 50, targetId: ID });
      expect(
        audit.find(
          (a) => a.action === 'node.decommission' && a.outcome === 'success'
        )?.detail
      ).toMatchObject({ force: true });
    });
  }
);

describeRig(
  'Resilience (Req 11): credential rotation crash windows and revocation',
  (rig) => {
    async function requested() {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      await p.h.admin('POST', path('rotate-credential'));
      return p;
    }
    const ageRequest = (seconds: number) =>
      rig().db.sql.unsafe(
        `update node_lifecycle set rotate_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${seconds} seconds')`
      );

    test('offered but never used, across a controller restart: the old secret keeps working and the node offers again', async () => {
      const first = await requested();
      expect((await beatAs(first.h, secretOf(1))).body.credential).toEqual({
        rotate: true,
      });
      expect((await offer(first.h, secretOf(1), NEXT)).status).toBe(200);
      await first.crash();
      const second = await rig().boot();
      expect((await beatAs(second.h, secretOf(1))).status).toBe(200);
      expect((await offer(second.h, secretOf(1), NEXT)).status).toBe(200); // identical: idempotent
      expect((await second.store.credentialStatus(ID))?.rotationPending).toBe(
        true
      );
      expect((await beatAs(second.h, NEXT)).status).toBe(200); // promoted
      expect((await beatAs(second.h, secretOf(1))).status).toBe(401);
      expect((await second.store.credentialStatus(ID))?.rotationPending).toBe(
        false
      );
    });

    test('first use of the next secret by many requests at once promotes exactly once', async () => {
      const p = await requested();
      await offer(p.h, secretOf(1), NEXT);
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => beatAs(p.h, NEXT))
      );
      expect(replies.every((r) => r.status === 200)).toBe(true);
      expect(countOf(await eventKinds(p.store, ID), 'credential_rotated')).toBe(
        1
      );
      const audit = await p.store.listAudit({ limit: 50, targetId: ID });
      expect(
        audit.filter((a) => a.action === 'credential.rotated')
      ).toHaveLength(1);
      expect((await beatAs(p.h, secretOf(1))).status).toBe(401);
      expect((await beatAs(p.h, NEXT)).status).toBe(200);
    });

    test('racing the old secret against promotion never leaves the node with two working credentials', async () => {
      const p = await requested();
      await offer(p.h, secretOf(1), NEXT);
      const mixed = await Promise.all([
        beatAs(p.h, secretOf(1)),
        beatAs(p.h, NEXT),
        beatAs(p.h, secretOf(1)),
        beatAs(p.h, NEXT),
      ]);
      for (const reply of mixed) expect([200, 401]).toContain(reply.status);
      expect(mixed[1]?.status).toBe(200);
      const after = await Promise.all([
        beatAs(p.h, secretOf(1)),
        beatAs(p.h, NEXT),
      ]);
      expect(after.map((r) => r.status)).toEqual([401, 200]);
    });

    test('two different offers: the last replaces the first, and the discarded secret never works', async () => {
      const p = await requested();
      await offer(p.h, secretOf(1), NEXT);
      await offer(p.h, secretOf(1), NEXT_B);
      expect((await beatAs(p.h, NEXT)).status).toBe(401);
      expect((await beatAs(p.h, NEXT_B)).status).toBe(200);
    });

    test('the grace expires: the next secret is refused, the old one works, and the open request lets the node offer again', async () => {
      const p = await requested();
      await offer(p.h, secretOf(1), NEXT);
      await ageRequest(72 * 3600 + 120);
      expect((await beatAs(p.h, NEXT)).status).toBe(401);
      const old = await beatAs(p.h, secretOf(1));
      expect(old.status).toBe(200);
      expect(old.body.credential).toEqual({ rotate: true });
      expect((await offer(p.h, secretOf(1), NEXT)).status).toBe(200);
      expect((await beatAs(p.h, NEXT)).status).toBe(200);
    });

    test('revoking during a pending rotation rejects both secrets at once; a re-register is pending and clears the rotation', async () => {
      const p = await requested();
      await offer(p.h, secretOf(1), NEXT);
      const revoked = await p.h.admin('POST', path('revoke-credential'), {
        confirm: NAME,
        reason: 'stolen',
      });
      expect(revoked.status).toBe(200);
      expect((await beatAs(p.h, secretOf(1))).status).toBe(401);
      expect((await beatAs(p.h, NEXT)).status).toBe(401);
      expect((await offer(p.h, secretOf(1), NEXT_B)).status).toBe(401);
      // The revoked node is not told it is rejected or retired: it is simply unknown.
      const reply = await beatAs(p.h, NEXT);
      expect(reply.body.error).toBe('unauthorized');
      const back = await p.h.register(1, {
        enrollmentToken: 'ci-enrollment-token-shared-secret',
      });
      expect(back.body.status).toBe('pending');
      const status = await p.store.credentialStatus(ID);
      expect(status).toMatchObject({
        revokedAt: null,
        rotationPending: false,
        rotateRequestedAt: null,
      });
      expect((await beatAs(p.h, NEXT)).status).toBe(401);
      expect((await beatAs(p.h, secretOf(1))).status).toBe(200);
    });

    test('a revocation survives a controller restart and a rotation cannot be requested for a revoked node', async () => {
      const first = await requested();
      await first.h.admin('POST', path('revoke-credential'), { confirm: NAME });
      await first.crash();
      const second = await rig().boot();
      expect((await beatAs(second.h, secretOf(1))).status).toBe(401);
      expect(
        (await second.h.admin('POST', path('rotate-credential'))).status
      ).toBe(409);
    });

    test('no response of the rotation APIs ever contains a secret or a hash', async () => {
      const p = await requested();
      const replies = [
        await offer(p.h, secretOf(1), NEXT),
        await p.h.admin('GET', path('credential')),
        await p.h.admin('POST', path('rotate-credential')),
        await p.h.admin('POST', path('revoke-credential'), { confirm: NAME }),
        await p.h.admin('GET', `/v1/nodes/${ID}`),
      ];
      const everything = replies.map((r) => r.text).join('\n');
      for (const secret of [
        secretOf(1),
        sha256(secretOf(1)),
        NEXT,
        sha256(NEXT),
      ]) {
        expect(everything).not.toContain(secret);
      }
      expect(everything).not.toMatch(/secret_hash|secretHash|revoked:/);
    });
  }
);

void (undefined as unknown as ControllerProcess);
