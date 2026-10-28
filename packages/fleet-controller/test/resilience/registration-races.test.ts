import { expect, test } from 'bun:test';

import { adminConfirmed } from '../support/confirm';
import {
  CI_ENROLLMENT_TOKEN,
  PLAIN_ENROLLMENT_TOKEN,
  type Harness,
} from '../support/controller';
import { heartbeatBody, nodeIdOf, secretOf, sha256 } from '../support/fixtures';

import { countOf, eventKinds } from './support/probe';
import { describeRig } from './support/rig';
import { simNode } from './support/sim-node';

const ID = nodeIdOf(1);
const OTHER_SECRET = sha256('the-other-machine');

const withToken = (token: string) => ({ enrollmentToken: token });

/** Registers node 1 with an arbitrary secret (the harness only knows secretOf(n)). */
function registerWith(
  h: Harness,
  secret: string,
  extra: Record<string, unknown> = {}
) {
  return h.call('POST', '/v1/nodes/register', {
    json: { nodeId: ID, hostname: `ci-${ID.slice(0, 4)}`, secret, ...extra },
  });
}
const beatWith = (h: Harness, secret: string) =>
  h.call('POST', '/v1/heartbeat', {
    headers: { Authorization: `Bearer ${ID}.${secret}` },
    json: heartbeatBody(1),
  });

describeRig(
  'Resilience (Req 11): registration under repetition, concurrency and cloning',
  (rig) => {
    test('twelve simultaneous registrations of one id leave one row, one created, eleven repeats', async () => {
      const { h, store } = await rig().boot();
      const replies = await Promise.all(
        Array.from({ length: 12 }, () => h.register(1))
      );
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 200)).toHaveLength(11);
      expect(new Set(replies.map((r) => r.body.status))).toEqual(
        new Set(['pending'])
      );
      expect((await store.listNodes()).filter((n) => n.id === ID)).toHaveLength(
        1
      );
      const kinds = await eventKinds(store, ID);
      expect(countOf(kinds, 'registered')).toBe(1);
      expect(countOf(kinds, 'reregistered')).toBe(11);
      expect(
        await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1))
      ).toMatchObject({ status: 200 });
    });

    test('concurrent token and token-less registrations end in one consistent, deterministic state', async () => {
      const { h, store } = await rig().boot();
      const attempts = [true, false, true, false, false, true, false];
      await Promise.all(
        attempts.map((token) =>
          h.register(1, token ? withToken(CI_ENROLLMENT_TOKEN) : {})
        )
      );
      const node = await store.findNode(ID);
      // The request processed last decides; the invariants hold whichever it was.
      expect(node?.approval).toBe('pending');
      expect(node?.enrolledVia).toBe('hello');
      expect(node?.approvedAt).toBeNull();
      // The role the token assigned once stays assigned.
      expect(node?.role).toBe('ci');
      const kinds = await eventKinds(store, ID);
      expect(countOf(kinds, 'role_assigned')).toBe(1);
      expect(countOf(kinds, 'registered')).toBe(1);
      expect(
        countOf(kinds, 'registered') + countOf(kinds, 'reregistered')
      ).toBe(attempts.length);
      // Every approval the token gave was followed by a demotion warning, never silently kept.
      const stored = await store.listEvents({ nodeId: ID, limit: 100 });
      const warned = stored.filter(
        (e) => e.kind === 'reregistered' && e.severity === 'warn'
      );
      expect(countOf(kinds, 'approved')).toBe(
        warned.length + (attempts.at(-1) ? 1 : 0)
      );
    });

    test('a reinstall replaces the secret: the old one is refused at once, the new one works, the role is kept', async () => {
      const { h, store } = await rig().boot();
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      expect((await beatWith(h, secretOf(1))).status).toBe(200);
      const again = await registerWith(h, OTHER_SECRET);
      expect(again).toMatchObject({
        status: 200,
        body: { status: 'pending', role: 'ci' },
      });
      expect((await beatWith(h, secretOf(1))).status).toBe(401);
      const fresh = await beatWith(h, OTHER_SECRET);
      expect(fresh.status).toBe(200);
      expect(fresh.body.status).toBe('pending');
      // A pending node is told to keep what it runs and nothing else.
      expect(fresh.body.desired).toMatchObject({ role: null, closure: null });
      const reregistered = (
        await store.listEvents({ nodeId: ID, limit: 20 })
      ).find((e) => e.kind === 'reregistered');
      expect(reregistered?.severity).toBe('warn');
    });

    test('a reinstall that presents the enrollment token stays approved, with its role', async () => {
      const { h } = await rig().boot();
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      const again = await registerWith(
        h,
        OTHER_SECRET,
        withToken(CI_ENROLLMENT_TOKEN)
      );
      expect(again.body).toMatchObject({ status: 'approved', role: 'ci' });
      expect((await beatWith(h, OTHER_SECRET)).body.desired).toMatchObject({
        closure: 'ci',
      });
    });

    test('cloned machines: the last registration wins, loses approval and the other clone is locked out', async () => {
      const { h, store } = await rig().boot();
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      await registerWith(h, OTHER_SECRET);
      expect((await store.findNode(ID))?.approval).toBe('pending');
      expect((await beatWith(h, secretOf(1))).status).toBe(401);
      expect((await beatWith(h, OTHER_SECRET)).status).toBe(200);
      // The first clone registers again: it wins back, still needing a person.
      await registerWith(h, secretOf(1));
      expect((await beatWith(h, OTHER_SECRET)).status).toBe(401);
      expect((await beatWith(h, secretOf(1))).status).toBe(200);
      expect((await store.listNodes()).filter((n) => n.id === ID)).toHaveLength(
        1
      );
    });

    test('two clones registering at once: the later request owns the secret and exactly one credential works', async () => {
      const { h } = await rig().boot();
      await Promise.all([
        registerWith(h, secretOf(1)),
        registerWith(h, OTHER_SECRET),
      ]);
      const results = await Promise.all([
        beatWith(h, secretOf(1)),
        beatWith(h, OTHER_SECRET),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(results[1]?.status).toBe(200);
    });

    test('approved without a token goes pending; rejected stays rejected even with a token; retired returns pending or approved', async () => {
      const { h, store } = await rig().boot();
      await h.register(1, withToken(PLAIN_ENROLLMENT_TOKEN));
      expect((await h.register(1)).body.status).toBe('pending');

      await adminConfirmed(h, 'POST', `/v1/nodes/${ID}/reject`, 1);
      for (const extra of [{}, withToken(CI_ENROLLMENT_TOKEN)]) {
        const reply = await h.register(1, extra);
        expect(reply.body.status).toBe('rejected');
      }
      const rejected = await store.findNode(ID);
      expect(rejected?.approval).toBe('rejected');
      expect(rejected?.role).toBeNull(); // a rejected node never takes a token's role
      // The rejected node's current secret learns it is rejected; no 2xx anywhere.
      expect(
        (await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1))).status
      ).toBe(403);

      await h.admin('POST', `/v1/nodes/${ID}/approve`);
      await adminConfirmed(h, 'POST', `/v1/nodes/${ID}/retire`, 1);
      expect((await h.register(1)).body.status).toBe('pending');
      await adminConfirmed(h, 'POST', `/v1/nodes/${ID}/retire`, 1);
      expect(
        (await h.register(1, withToken(PLAIN_ENROLLMENT_TOKEN))).body.status
      ).toBe('approved');
    });

    test('a token role fills an empty assignment once and never replaces an assigned role', async () => {
      const { h, store } = await rig().boot();
      await h.register(1, withToken(PLAIN_ENROLLMENT_TOKEN));
      expect((await store.findNode(ID))?.role).toBeNull();
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      expect((await store.findNode(ID))?.role).toBe('ci');
      await h.admin('PATCH', `/v1/nodes/${ID}`, { role: 'devbox' });
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      expect((await store.findNode(ID))?.role).toBe('devbox');
      expect(countOf(await eventKinds(store, ID), 'role_assigned')).toBe(2); // enroll, then the person
    });

    test('a node cannot choose its role, claim approval or set labels through registration', async () => {
      const { h, store } = await rig().boot();
      const reply = await h.register(1, {
        role: 'ci',
        roleToken: 'x'.repeat(20),
        approval: 'approved',
        labels: ['gpu'],
        status: 'approved',
      });
      expect(reply.body).toMatchObject({ status: 'pending', role: null });
      const node = await store.findNode(ID);
      expect(node).toMatchObject({ approval: 'pending', role: null });
      expect(node?.labels).toEqual([]);
    });

    test('a wrong enrollment token is not an error and approves nothing; a malformed one is 400', async () => {
      const { h, store } = await rig().boot();
      expect(
        (await h.register(1, withToken('not-a-configured-token'))).body.status
      ).toBe('pending');
      expect((await h.register(1, withToken('bad token!'))).status).toBe(400);
      expect((await store.findNode(ID))?.enrolledVia).toBe('hello');
    });

    test('registration is limited per address, window by window, and the limit is answered with Retry-After', async () => {
      const { clock } = rig();
      const { h } = await rig().boot({
        controller: { registerLimit: { limit: 5, windowMs: 60_000 } },
      });
      const from = (address: string) =>
        h.call('POST', '/v1/nodes/register', {
          headers: { 'cf-connecting-ip': address },
          json: { nodeId: ID, hostname: 'ci-0001', secret: secretOf(1) },
        });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1)
        statuses.push((await from('203.0.113.1')).status);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);
      const limited = await from('203.0.113.1');
      expect(limited.body.error).toBe('rate_limited');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await from('203.0.113.2')).status).toBe(200); // another address is unaffected
      clock.advance(61);
      expect((await from('203.0.113.1')).status).toBe(200); // the next window
    });

    test('the rate limit shares its budget with enrollment checks and refuses before touching the database', async () => {
      const { h, store } = await rig().boot({
        controller: { registerLimit: { limit: 2, windowMs: 60_000 } },
      });
      const check = () =>
        h.call('POST', '/v1/enrollment/check', {
          headers: { 'x-forwarded-for': '198.51.100.9' },
          json: { enrollmentToken: CI_ENROLLMENT_TOKEN },
        });
      expect((await check()).status).toBe(200);
      expect((await check()).status).toBe(200);
      const refused = await h.call('POST', '/v1/nodes/register', {
        headers: { 'x-forwarded-for': '198.51.100.9' },
        json: { nodeId: ID, hostname: 'ci-0001', secret: secretOf(1) },
      });
      expect(refused.status).toBe(429);
      expect(await store.findNode(ID)).toBeNull();
    });

    test('a node that was approved by a person is not demoted by heartbeats and keeps converging after the controller restarts', async () => {
      const first = await rig().boot();
      await first.h.register(1);
      await first.h.admin('POST', `/v1/nodes/${ID}/approve`, { role: 'ci' });
      const node = simNode(1);
      await node.settle(first.h);
      await first.crash();
      const second = await rig().boot();
      expect((await node.beat(second.h)).body.status).toBe('approved');
      expect((await second.store.findNode(ID))?.approval).toBe('approved');
    });

    test('a person approving while the node registers again leaves a consistent row either way', async () => {
      const { h, store } = await rig().boot();
      await h.register(1);
      const [, approved] = await Promise.all([
        h.register(1),
        h.admin('POST', `/v1/nodes/${ID}/approve`),
      ]);
      expect(approved.status).toBe(200);
      const node = await store.findNode(ID);
      // Approval and its bookkeeping always agree, whichever request ran last.
      expect(node?.approval === 'approved').toBe(node?.approvedAt !== null);
      expect(node?.approval === 'approved').toBe(node?.approvedBy !== null);
      expect((await beatWith(h, secretOf(1))).status).toBe(200);
    });

    test('deleting a node while it reports leaves no orphan history, and the node must register again', async () => {
      const { h, store } = await rig().boot();
      await h.register(1, withToken(CI_ENROLLMENT_TOKEN));
      const node = simNode(1);
      await node.beat(h);
      const [beat, removed] = await Promise.all([
        node.beat(h),
        adminConfirmed(h, 'DELETE', `/v1/nodes/${ID}`, 1),
      ]);
      expect([200, 401]).toContain(beat.status);
      expect(removed.status).toBe(200);
      expect(await store.findNode(ID)).toBeNull();
      const orphans = await rig().db.sql.unsafe(
        `select count(*) as n from heartbeats where node_id = '${ID}'`
      );
      expect(Number(orphans[0]?.['n'])).toBe(0);
      expect((await beatWith(h, secretOf(1))).status).toBe(401);
      expect((await h.register(1)).status).toBe(201);
    });
  }
);
