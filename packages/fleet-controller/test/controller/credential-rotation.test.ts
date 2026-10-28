import { describe, expect, test } from 'bun:test';

import type { Store } from '../../src/store';
import { MemoryStore } from '../../src/testing/memory-store';
import {
  CI_ENROLLMENT_TOKEN,
  Clock,
  createHarness,
  type Harness,
} from '../support/controller';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf, secretOf, sha256 } from '../support/fixtures';

const ID = nodeIdOf(1);
/** What a person types to confirm: the node's hostname (the harness registers ci-<4 hex>). */
const NAME = `ci-${ID.slice(0, 4)}`;
/** Raw next secrets (64 hex) and the hashes a node offers for them. */
const SECRET_2 = sha256('next-secret-1');
const SECRET_3 = sha256('next-secret-2');

/** The node authenticates with an arbitrary secret (the harness only knows secretOf(n)). */
function as(
  h: Harness,
  secret: string,
  request: { method: string; path: string; json?: unknown }
) {
  return h.call(request.method, request.path, {
    headers: { Authorization: `Bearer ${ID}.${secret}` },
    ...(request.json === undefined ? {} : { json: request.json }),
  });
}
const beat = (h: Harness, secret: string) =>
  as(h, secret, {
    method: 'POST',
    path: '/v1/heartbeat',
    json: heartbeatBody(1),
  });
const offer = (h: Harness, secret: string, next: string) =>
  as(h, secret, {
    method: 'POST',
    path: '/v1/credential/rotate',
    json: { nextSecretHash: sha256(next) },
  });
const request = (h: Harness) =>
  h.admin('POST', `/v1/nodes/${ID}/rotate-credential`);

interface Rig {
  readonly h: Harness;
  readonly store: Store;
  /** Pretends the in-flight rotation started this long ago. */
  age(ms: number): Promise<void>;
}

function scenarios(make: () => Rig) {
  const enrolled = async () => {
    const rig = make();
    await rig.h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    return rig;
  };

  test('no rotation requested: no hint on the heartbeat, and /v1/credential/rotate is 409', async () => {
    const { h } = await enrolled();
    const reply = await beat(h, secretOf(1));
    expect(reply.status).toBe(200);
    expect(reply.body.credential).toBeUndefined();
    const refused = await offer(h, secretOf(1), SECRET_2);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('rotation_not_requested');
  });

  test('rotation: hint, offer, both secrets work until the first use of the new one, then only it', async () => {
    const { h, store } = await enrolled();
    const asked = await request(h);
    expect(asked.status).toBe(202);
    // Asking again is idempotent.
    const again = await request(h);
    expect(again.body.credential.rotateRequestedAt).toBe(
      asked.body.credential.rotateRequestedAt
    );

    const hint = await beat(h, secretOf(1));
    expect(hint.body.credential).toEqual({ rotate: true });
    expect(hint.body.desired?.revision ?? 'unchanged').toBeDefined();

    const offered = await offer(h, secretOf(1), SECRET_2);
    expect(offered.status).toBe(200);
    expect(offered.body).toEqual({ ok: true, rotationPending: true });
    expect((await offer(h, secretOf(1), SECRET_2)).status).toBe(200); // retry-safe

    // A node that crashed before swapping still authenticates with the old secret.
    expect((await beat(h, secretOf(1))).status).toBe(200);
    expect((await store.credentialStatus(ID))?.rotationPending).toBe(true);

    // First authentication with the new secret promotes it.
    const first = await beat(h, SECRET_2);
    expect(first.status).toBe(200);
    expect(first.body.credential).toBeUndefined();
    const status = await store.credentialStatus(ID);
    expect(status?.rotationPending).toBe(false);
    expect(status?.rotateRequestedAt).toBeNull();
    expect(status?.rotatedAt).toBeInstanceOf(Date);
    // The old secret is gone.
    expect((await beat(h, secretOf(1))).status).toBe(401);
    expect((await beat(h, SECRET_2)).status).toBe(200);
    const events = await store.listEvents({ nodeId: ID, limit: 20 });
    expect(events.map((event) => event.kind)).toContain('credential_rotated');
  });

  test('a node that regenerated its next secret replaces the old offer; the discarded one never works', async () => {
    const { h } = await enrolled();
    await request(h);
    await offer(h, secretOf(1), SECRET_2);
    // Node lost its next file before swapping: it still holds the old secret.
    expect((await offer(h, secretOf(1), SECRET_3)).status).toBe(200);
    expect((await beat(h, SECRET_2)).status).toBe(401);
    expect((await beat(h, SECRET_3)).status).toBe(200);
  });

  test('the pending window is bounded: after the grace the next secret is refused and the old one still works', async () => {
    const { h, store, age } = await enrolled().then((rig) => rig);
    await request(h);
    await offer(h, secretOf(1), SECRET_2);
    await age(GRACE_PLUS);
    expect((await beat(h, SECRET_2)).status).toBe(401);
    expect((await beat(h, secretOf(1))).status).toBe(200);
    expect((await store.credentialStatus(ID))?.rotationPending).toBe(false);
    // The request is still open, so the node can offer again and recover.
    expect((await beat(h, secretOf(1))).body.credential).toEqual({
      rotate: true,
    });
    expect((await offer(h, secretOf(1), SECRET_2)).status).toBe(200);
    expect((await beat(h, SECRET_2)).status).toBe(200);
  });

  test('bad offers: malformed hash 400, same secret 400, unknown credential 401, rotated-away secret cannot offer', async () => {
    const { h } = await enrolled();
    await request(h);
    const malformed = await as(h, secretOf(1), {
      method: 'POST',
      path: '/v1/credential/rotate',
      json: { nextSecretHash: 'nope' },
    });
    expect(malformed.status).toBe(400);
    const same = await offer(h, secretOf(1), secretOf(1));
    expect(same.status).toBe(400);
    expect((await offer(h, 'f'.repeat(64), SECRET_2)).status).toBe(401);
    const anonymous = await h.call('POST', '/v1/credential/rotate', {
      json: { nextSecretHash: sha256(SECRET_2) },
    });
    expect(anonymous.status).toBe(401);
  });

  test('registering again ends a pending rotation and uses the registration secret', async () => {
    const { h, store } = await enrolled();
    await request(h);
    await offer(h, secretOf(1), SECRET_2);
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    expect((await store.credentialStatus(ID))?.rotateRequestedAt).toBeNull();
    expect((await beat(h, SECRET_2)).status).toBe(401);
    expect((await beat(h, secretOf(1))).status).toBe(200);
  });

  test('revocation: the node gets 401 at once, re-registers as pending even with an enrollment token, and is audited', async () => {
    const { h, store } = await enrolled();
    expect((await beat(h, secretOf(1))).status).toBe(200);
    // Without typing the node's name nothing happens, and the refusal is audited.
    const unconfirmed = await h.admin(
      'POST',
      `/v1/nodes/${ID}/revoke-credential`
    );
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe('confirmation_required');
    expect(unconfirmed.body.expected).toBe(NAME);
    expect((await beat(h, secretOf(1))).status).toBe(200);
    const revoked = await h.admin('POST', `/v1/nodes/${ID}/revoke-credential`, {
      confirm: NAME,
      reason: 'laptop lost',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.credential.revokedAt).toBeTruthy();
    expect(JSON.stringify(revoked.body)).not.toContain('revoked:');
    expect((await beat(h, secretOf(1))).status).toBe(401);
    // Idempotent.
    expect(
      (
        await h.admin('POST', `/v1/nodes/${ID}/revoke-credential`, {
          confirm: NAME,
        })
      ).status
    ).toBe(200);
    // No rotation of a revoked credential.
    expect((await request(h)).status).toBe(409);

    // The stolen identity registers again, enrollment token and all: pending, no role.
    const back = await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    expect(back.body.status).toBe('pending');
    expect(back.body.role).toBe('ci'); // an existing assignment is kept; approval is what a person decides
    const node = await store.findNode(ID);
    expect(node?.approval).toBe('pending');
    expect((await store.credentialStatus(ID))?.revokedAt).toBeNull();
    // The new secret works for a pending node, which learns nothing to run.
    const pending = await beat(h, secretOf(1));
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');
    // A person approves it again.
    expect((await h.admin('POST', `/v1/nodes/${ID}/approve`)).status).toBe(200);

    const audit = await store.listAudit({
      targetKind: 'node',
      targetId: ID,
      limit: 20,
    });
    const actions = audit.map((row) => row.action);
    expect(actions).toContain('credential.revoke');
    expect(
      audit.some(
        (row) => row.action === 'credential.revoke' && row.outcome === 'denied'
      )
    ).toBe(true);
    expect(actions).toContain('credential.reregistered');
    expect(JSON.stringify(audit)).not.toContain(secretOf(1));
    const kinds = (await store.listEvents({ nodeId: ID, limit: 30 })).map(
      (e) => e.kind
    );
    expect(kinds).toContain('credential_revoked');
    expect(kinds).toContain('credential_reregistered');
  });

  test('unknown node and malformed ids are 404; a malformed reason is 400', async () => {
    const { h } = await enrolled();
    expect(
      (await h.admin('POST', `/v1/nodes/${nodeIdOf(9)}/rotate-credential`))
        .status
    ).toBe(404);
    expect(
      (await h.admin('POST', `/v1/nodes/${nodeIdOf(9)}/revoke-credential`))
        .status
    ).toBe(404);
    expect(
      (await h.admin('GET', `/v1/nodes/${nodeIdOf(9)}/credential`)).status
    ).toBe(404);
    expect(
      (await h.admin('POST', '/v1/nodes/nope/revoke-credential')).status
    ).toBe(404);
    expect(
      (
        await h.admin('POST', `/v1/nodes/${ID}/revoke-credential`, {
          reason: 5,
        })
      ).status
    ).toBe(400);
    const status = await h.admin('GET', `/v1/nodes/${ID}/credential`);
    expect(status.status).toBe(200);
    expect(status.body.credential.revokedAt).toBeNull();
  });
}

const GRACE_PLUS = 72 * 3600 * 1000 + 60_000;

describeController('credential rotation and revocation (SQLite)', (ctx) => {
  scenarios(() => ({
    h: ctx().h,
    store: ctx().store,
    async age(ms) {
      await ctx().db.sql.unsafe(
        `update node_lifecycle set rotate_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Math.ceil(ms / 1000)} seconds')`
      );
    },
  }));
});

describe('credential rotation and revocation (in-memory store)', () => {
  scenarios(() => {
    const clock = new Clock();
    const store = new MemoryStore(clock.now);
    return {
      h: createHarness(store, { clock }),
      store,
      async age(ms) {
        clock.advance(ms / 1000);
      },
    };
  });
});
