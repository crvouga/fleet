import { beforeEach, describe, expect, test } from 'bun:test';

import { MemoryStore } from '../../src/testing/memory-store';
import { SettingsConflictError } from '../../src/domain/settings-conflict';
import {
  CI_ENROLLMENT_TOKEN,
  createHarness,
  type Harness,
} from '../support/controller';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

const ID = nodeIdOf(1);

describeController('settings concurrency, dry run and impact', (ctx) => {
  beforeEach(async () => {
    await ctx().db.sql.unsafe('delete from audit_log');
  });
  const enroll = async (n: number) =>
    ctx().h.register(n, { enrollmentToken: CI_ENROLLMENT_TOKEN });
  const put = (
    body: unknown,
    headers: Record<string, string> = {},
    query = '',
    scope = 'fleet'
  ) =>
    ctx().h.call('PUT', `/v1/settings/${scope}${query}`, {
      headers: {
        Authorization:
          'Bearer ' + 'a-very-long-admin-token-for-tests-0123456789',
        ...headers,
      },
      json: body,
    });

  test('first write of a new scope needs no precondition and returns revision 1; GET carries the ETag', async () => {
    const first = await put({ disk: { alertPercent: 80 } });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(1);
    expect(first.headers.get('etag')).toBe('"1"');
    const read = await ctx().h.admin('GET', '/v1/settings/fleet');
    expect(read.body.revision).toBe(1);
    expect(
      (await ctx().h.admin('GET', '/v1/settings/role:ci')).body.revision
    ).toBe(0);
  });

  test('an existing scope without a precondition is 428 and nothing is written', async () => {
    await put({ disk: { alertPercent: 80 } });
    const reply = await put({ disk: { alertPercent: 70 } });
    expect(reply.status).toBe(428);
    expect(reply.body.error).toBe('precondition_required');
    expect(reply.body.currentRevision).toBe(1);
    expect(
      (await ctx().h.admin('GET', '/v1/settings/fleet')).body.value.disk
        .alertPercent
    ).toBe(80);
  });

  test('If-Match and the expectedRevision envelope both work; a stale revision is 409 with the current one', async () => {
    await put({ disk: { alertPercent: 80 } });
    const viaHeader = await put(
      { disk: { alertPercent: 75 } },
      { 'If-Match': '"1"' }
    );
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.revision).toBe(2);
    const viaBody = await put({
      value: { disk: { alertPercent: 70 } },
      expectedRevision: 2,
    });
    expect(viaBody.status).toBe(200);
    expect(viaBody.body.revision).toBe(3);
    const stale = await put(
      { disk: { alertPercent: 60 } },
      { 'If-Match': '1' }
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('conflict');
    expect(stale.body.currentRevision).toBe(3);
    expect(stale.body.expectedRevision).toBe(1);
    expect(
      (await ctx().h.admin('GET', '/v1/settings/fleet')).body.value.disk
        .alertPercent
    ).toBe(70);
    const audit = await ctx().store.listAudit({
      targetKind: 'settings',
      targetId: 'fleet',
      limit: 5,
    });
    expect(audit[0]).toMatchObject({
      action: 'settings.put',
      outcome: 'failed',
    });
    expect(audit[0]?.detail).toMatchObject({
      reason: 'conflict',
      expected: 1,
      current: 3,
    });
  });

  test('two concurrent writers: exactly one wins, the other gets 409', async () => {
    await put({ disk: { alertPercent: 80 } });
    const [a, b] = await Promise.all([
      put({ disk: { alertPercent: 71 } }, { 'If-Match': '1' }),
      put({ disk: { alertPercent: 72 } }, { 'If-Match': '1' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test('two concurrent first writers of a new scope: one 200, one 409', async () => {
    const [a, b] = await Promise.all([
      put({ disk: { alertPercent: 71 } }, {}, '', 'role:devbox'),
      put({ disk: { alertPercent: 72 } }, {}, '', 'role:devbox'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test('malformed preconditions are 400', async () => {
    await put({ disk: { alertPercent: 80 } });
    expect((await put({}, { 'If-Match': 'abc' })).status).toBe(400);
    expect((await put({ value: {}, expectedRevision: 'x' })).status).toBe(400);
    expect(
      (await put({ value: {}, expectedRevision: 1 }, { 'If-Match': '2' }))
        .status
    ).toBe(400);
    expect((await put({ value: {}, other: 1 })).status).toBe(400);
  });

  test('?dryRun=1 writes nothing and reports the nodes that would change and the warnings', async () => {
    await enroll(1);
    await enroll(2);
    const dry = await put({ sync: { paused: true } }, {}, '?dryRun=1');
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      dryRun: true,
      wouldWrite: false,
      revision: 0,
      totalNodes: 2,
      acknowledgementRequired: ['fleet_sync_paused'],
    });
    expect(dry.body.changedNodes).toHaveLength(2);
    expect(dry.body.changedNodes[0].fromRevision).not.toBe(
      dry.body.changedNodes[0].toRevision
    );
    expect(
      (await ctx().h.admin('GET', '/v1/settings/fleet')).body.revision
    ).toBe(0);
    const safe = await put({ disk: { alertPercent: 80 } }, {}, '?dryRun=1');
    expect(safe.body.wouldWrite).toBe(true);
    // A dry run is not a write: no desired history and no settings audit row for it.
    expect(await ctx().store.desiredHistory(ID, 10)).toHaveLength(0);
  });

  test('a destabilising change is refused 422 until its codes are acknowledged; every write is audited', async () => {
    await enroll(1);
    await enroll(2);
    const refused = await put({ sync: { paused: true } });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('unsafe_change');
    expect(refused.body.acknowledge).toEqual(['fleet_sync_paused']);
    expect(
      (await ctx().h.admin('GET', '/v1/settings/fleet')).body.revision
    ).toBe(0);

    const wrong = await put(
      { sync: { paused: true } },
      { 'X-Fleet-Acknowledge': 'something_else' }
    );
    expect(wrong.status).toBe(422);
    const accepted = await put(
      { sync: { paused: true } },
      { 'X-Fleet-Acknowledge': 'fleet_sync_paused' }
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.issues.map((i: { code: string }) => i.code)).toContain(
      'fleet_sync_paused'
    );
    const viaBody = await put({
      value: { sync: { paused: true }, runners: { cordoned: true } },
      expectedRevision: 1,
      acknowledge: ['ci_runners_cordoned'],
    });
    expect(viaBody.status).toBe(200);

    const audit = await ctx().store.listAudit({
      targetKind: 'settings',
      targetId: 'fleet',
      limit: 10,
    });
    expect(audit.map((r) => [r.action, r.outcome])).toEqual([
      ['settings.put', 'success'],
      ['settings.put', 'success'],
      ['settings.put', 'failed'],
      ['settings.put', 'failed'],
    ]);
    expect(audit[1]?.detail).toMatchObject({
      acknowledged: ['fleet_sync_paused'],
      fromRevision: 0,
      toRevision: 1,
    });
    expect(JSON.stringify(audit)).not.toContain('"paused"');
  });

  test('validation still comes first: an unknown key is 400 invalid_settings', async () => {
    const reply = await put({ nope: { x: 1 } });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe('invalid_settings');
  });

  test('restore is concurrency-safe, audited and labelled as a rollback in the history', async () => {
    await put({ disk: { alertPercent: 80 } });
    await put({ disk: { alertPercent: 70 } }, { 'If-Match': '1' });
    const history = (await ctx().h.admin('GET', '/v1/settings/fleet/history'))
      .body.history;
    const first = history[1];
    const stale = await ctx().h.admin('POST', '/v1/settings/fleet/restore', {
      historyId: first.id,
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    const missing = await ctx().h.admin('POST', '/v1/settings/fleet/restore', {
      historyId: first.id,
    });
    expect(missing.status).toBe(428);
    const dry = await ctx().h.call(
      'POST',
      '/v1/settings/fleet/restore?dryRun=1',
      {
        headers: {
          Authorization: 'Bearer a-very-long-admin-token-for-tests-0123456789',
        },
        json: { historyId: first.id },
      }
    );
    expect(dry.body.wouldWrite).toBe(false);
    const ok = await ctx().h.admin('POST', '/v1/settings/fleet/restore', {
      historyId: first.id,
      expectedRevision: 2,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.value.disk.alertPercent).toBe(80);
    expect(ok.body.revision).toBe(3);
    expect(ok.body.updatedBy).toBe(
      `admin-token (rollback to #${String(first.id)})`
    );
    const audit = await ctx().store.listAudit({
      targetKind: 'settings',
      targetId: 'fleet',
      limit: 1,
    });
    expect(audit[0]).toMatchObject({
      action: 'settings.restore',
      outcome: 'success',
    });
    expect(audit[0]?.detail).toMatchObject({
      restoredFrom: first.id,
      fromRevision: 2,
      toRevision: 3,
    });
    expect(
      (
        await ctx().h.admin('POST', '/v1/settings/fleet/restore', {
          historyId: 999999,
          expectedRevision: 3,
        })
      ).status
    ).toBe(404);
  });

  test('a write records the changed nodes desired documents, bounded and without duplicates', async () => {
    await enroll(1);
    const before = await ctx().h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1)
    );
    expect(before.status).toBe(200);
    await put({ disk: { alertPercent: 80 } });
    await put({ disk: { alertPercent: 80 } }, { 'If-Match': '1' });
    const rows = await ctx().store.desiredHistory(ID, 10);
    expect(rows.map((r) => r.cause)).toEqual(['settings:fleet', 'initial']);
    // The same document served again adds nothing.
    await ctx().h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));
    expect(await ctx().store.desiredHistory(ID, 10)).toHaveLength(2);
  });
});

describe('MemoryStore settings revision', () => {
  test('mirrors the SQLite contract: revision counts writes and a stale expectation throws', async () => {
    const store = new MemoryStore();
    expect((await store.putSettings('fleet', {}, 'a', 0)).revision).toBe(1);
    expect((await store.putSettings('fleet', {}, 'a', 1)).revision).toBe(2);
    await expect(store.putSettings('fleet', {}, 'a', 1)).rejects.toBeInstanceOf(
      SettingsConflictError
    );
    expect((await store.putSettings('fleet', {}, 'a')).revision).toBe(3);
  });
});

void createHarness;
void (undefined as unknown as Harness);
