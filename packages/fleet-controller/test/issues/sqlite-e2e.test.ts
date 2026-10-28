import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';

import { createIssuesRuntime } from '../../src/issues/compose';
import { SqliteIssueStore } from '../../src/db/issue-store';
import { runIssueSyncJob } from '../../src/jobs/issue-sync';
import { CI_ENROLLMENT_TOKEN, silent } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';
import { signInAs } from '../support/session';

import { FakeIssuesApi, status } from './fake-issues-api';
import { FAST } from './support';

const api = new FakeIssuesApi();
beforeAll(() => api.start());
afterAll(() => api.stop());
beforeEach(() => api.reset());

/** The real controller on a real SQLite database, with the real SqliteIssueStore. */
describeController('issue reporting on SQLite (end to end)', (ctx) => {
  async function setup() {
    const { h, db } = ctx();
    await db.sql.unsafe('delete from issue_reports');
    await db.sql.unsafe('delete from nodes');
    api.clock = () => h.clock.now().toISOString();
    Object.assign(h.deps.env, {
      issues: {
        token: api.token,
        repository: api.repository,
        labels: ['fleet-report'],
        apiUrl: api.url,
      },
    });
    const runtime = createIssuesRuntime(h.deps, {
      store: new SqliteIssueStore(db.sql),
      log: silent,
      tuning: FAST,
      random: () => 0.5,
    });
    Object.assign(h.deps, { issues: runtime });
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const beat = await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, {
        sync: {
          rolledBack: true,
          healthFailure: 'runner never became healthy',
        },
      })
    );
    expect(beat.status).toBe(200);
    return { h, db, runtime };
  }

  test('preview saves a draft; create files once; the row, links and audit are right', async () => {
    const { h, db } = await setup();
    const preview = await h.admin('POST', '/v1/issues/preview', {
      kind: 'node',
      node: nodeIdOf(1),
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ persisted: true, status: 'draft' });
    const [a, b] = await Promise.all([
      h.admin('POST', '/v1/issues', { draftId: preview.body.id }),
      h.admin('POST', '/v1/issues', { draftId: preview.body.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(api.issues).toHaveLength(1);
    const rows =
      await db.sql`select status, github_issue_number, node_id, attempts from issue_reports`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'created',
      github_issue_number: 1,
      node_id: nodeIdOf(1),
      attempts: 1,
    });
    const links = await h.admin('GET', `/v1/issues/links?node=${nodeIdOf(1)}`);
    expect(links.body.node).toHaveLength(1);
    const audit =
      await db.sql`select action, outcome from audit_log where target_kind = 'issue' order by id`;
    expect(audit.map((r) => r['action'])).toEqual(
      expect.arrayContaining(['issue.preview', 'issue.create'])
    );
    expect(
      JSON.stringify(await db.sql`select * from issue_reports`)
    ).not.toContain(api.token);
    expect(JSON.stringify(await db.sql`select * from audit_log`)).not.toContain(
      api.token
    );
  });

  test('an outage queues the report in the database and the job files it when GitHub returns', async () => {
    const { h, db, runtime } = await setup();
    api.inject({ match: /POST .*\/issues$/, times: 2, respond: status(503) });
    const created = await h.admin('POST', '/v1/issues', {
      kind: 'node',
      node: nodeIdOf(1),
    });
    expect(created.status).toBe(202);
    const job = () =>
      runIssueSyncJob({
        store: h.deps.store,
        now: h.clock.now,
        fetch,
        log: silent,
        issues: runtime,
      });
    let finished = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      h.clock.advance(5);
      finished += await job();
    }
    expect(finished).toBe(1);
    const [row] =
      await db.sql`select status, attempts, last_error from issue_reports`;
    expect(row).toMatchObject({
      status: 'created',
      attempts: 3,
      last_error: null,
    });
    expect(api.issues).toHaveLength(1);
  });

  test('a viewer previews read-only and cannot create; the draft count stays zero', async () => {
    const { h, db } = await setup();
    const viewer = await signInAs(ctx(), 'reader@example.test', 'viewer');
    const reply = await viewer.h.call('POST', '/v1/issues/preview', {
      headers: viewer.headers,
      json: { kind: 'node', node: nodeIdOf(1) },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.persisted).toBe(false);
    const denied = await viewer.h.call('POST', '/v1/issues', {
      headers: viewer.headers,
      json: { kind: 'node', node: nodeIdOf(1) },
    });
    expect(denied.status).toBe(403);
    expect(await db.sql`select id from issue_reports`).toHaveLength(0);
    expect(api.issues).toHaveLength(0);
    expect(h.deps.issues).toBeDefined();
  });
});
