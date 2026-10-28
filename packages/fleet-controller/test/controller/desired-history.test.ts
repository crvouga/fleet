import { describe, expect, test } from 'bun:test';

import {
  DESIRED_HISTORY_KEEP,
  annotateHistory,
  desiredChangeCause,
  type DesiredSnapshot,
} from '../../src/domain/desired-history';
import { MemoryStore } from '../../src/testing/memory-store';
import { CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf, registerInput } from '../support/fixtures';
import { adminConfirmed } from '../support/confirm';

const ID = nodeIdOf(1);
const doc = (
  revision: string,
  over: Partial<DesiredSnapshot> = {}
): DesiredSnapshot => ({
  revision,
  role: 'ci',
  closure: 'ci',
  values: {},
  ...over,
});

describe('desired history domain', () => {
  test('causes name what changed', () => {
    expect(desiredChangeCause(null, doc('a'))).toBe('initial');
    expect(
      desiredChangeCause(
        doc('a'),
        doc('b', { role: 'devbox', closure: 'devbox' })
      )
    ).toBe('role,closure');
    expect(
      desiredChangeCause(
        doc('a'),
        doc('b', { values: { sync: { paused: true } } })
      )
    ).toBe('settings');
    expect(desiredChangeCause(doc('a'), doc('b'))).toBe('revision');
  });

  test('a revision seen before is annotated as a rollback to that row', () => {
    const at = new Date(0);
    const rows = [3, 2, 1].map((id) => ({
      id,
      nodeId: ID,
      revision: id === 3 ? 'a' : id === 2 ? 'b' : 'a',
      desired: doc('x'),
      at,
      cause: null,
    }));
    expect(annotateHistory(rows).map((row) => row.revertsTo)).toEqual([
      1,
      null,
      null,
    ]);
  });
});

describe('MemoryStore desired history', () => {
  test('dedupes by latest revision and keeps a bounded tail', async () => {
    const store = new MemoryStore();
    await store.registerNode(registerInput(1));
    expect(await store.recordDesired(ID, doc('r0'))).toBe(true);
    expect(await store.recordDesired(ID, doc('r0'))).toBe(false);
    for (let i = 1; i < DESIRED_HISTORY_KEEP + 20; i += 1)
      await store.recordDesired(ID, doc(`r${i}`));
    const rows = await store.desiredHistory(ID, 1000);
    expect(rows).toHaveLength(DESIRED_HISTORY_KEEP);
    expect(rows[0]?.revision).toBe(`r${DESIRED_HISTORY_KEEP + 19}`);
    expect(await store.recordDesired(nodeIdOf(9), doc('x'))).toBe(false);
  });
});

describeController('GET /v1/nodes/:id/desired-history', (ctx) => {
  const beat = () =>
    ctx().h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));

  test('a heartbeat records the document served once, with the current one alongside', async () => {
    await ctx().h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat();
    await beat();
    const reply = await ctx().h.admin('GET', `/v1/nodes/${ID}/desired-history`);
    expect(reply.status).toBe(200);
    expect(reply.body.history).toHaveLength(1);
    expect(reply.body.history[0]).toMatchObject({
      cause: 'initial',
      revertsTo: null,
    });
    expect(reply.body.history[0].desired.revision).toBe(
      reply.body.current.revision
    );
  });

  test('role, settings and rollback changes are recorded in order, rollback marked', async () => {
    const { h, store } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat();
    await h.admin('PUT', '/v1/settings/fleet', { disk: { alertPercent: 80 } });
    await h
      .admin('PUT', '/v1/settings/fleet', { disk: { alertPercent: 90 } })
      .then(() => undefined);
    await h.admin('PATCH', `/v1/nodes/${ID}`, { role: 'devbox' });
    await beat();
    const history = (await h.admin('GET', `/v1/nodes/${ID}/desired-history`))
      .body.history;
    const causes = history.map((row: { cause: string }) => row.cause);
    expect(causes[0]).toBe('role,closure');
    expect(causes).toContain('settings:fleet');
    expect(causes.at(-1)).toBe('initial');
    // Roll the role back: the revision returns to an earlier one.
    await h.admin('PATCH', `/v1/nodes/${ID}`, { role: 'ci' });
    await beat();
    const after = (await h.admin('GET', `/v1/nodes/${ID}/desired-history`)).body
      .history;
    expect(after[0].revertsTo).not.toBeNull();
    expect(await store.desiredHistory(ID, 2)).toHaveLength(2);
  });

  test('limits and ids are validated; unknown nodes are 404', async () => {
    await ctx().h.register(1);
    expect(
      (await ctx().h.admin('GET', `/v1/nodes/${ID}/desired-history?limit=0`))
        .status
    ).toBe(400);
    expect(
      (await ctx().h.admin('GET', `/v1/nodes/${nodeIdOf(9)}/desired-history`))
        .status
    ).toBe(404);
    expect(
      (await ctx().h.call('GET', `/v1/nodes/${ID}/desired-history`)).status
    ).toBe(401);
  });

  test('SQLite keeps a bounded tail per node and writes each revision once', async () => {
    const { h, store } = ctx();
    await h.register(1);
    for (let i = 0; i < DESIRED_HISTORY_KEEP + 15; i += 1)
      await store.recordDesired(ID, doc(`r${i}`));
    expect(
      await store.recordDesired(ID, doc(`r${DESIRED_HISTORY_KEEP + 14}`))
    ).toBe(false);
    const rows = await store.desiredHistory(ID, 1000);
    expect(rows).toHaveLength(DESIRED_HISTORY_KEEP);
    expect(rows[0]?.revision).toBe(`r${DESIRED_HISTORY_KEEP + 14}`);
    expect(rows.at(-1)?.revision).toBe('r15');
  });

  test('the history of a deleted node goes with it', async () => {
    await ctx().h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat();
    await adminConfirmed(ctx().h, 'DELETE', `/v1/nodes/${ID}`, ID);
    const rows = await ctx().db
      .sql`select count(*) as n from desired_history where node_id = ${ID}`;
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});
