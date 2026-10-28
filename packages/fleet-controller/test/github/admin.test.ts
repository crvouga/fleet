import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { runGithubSync } from '../../src/github/sync';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

import { createGithubHarness, type GithubHarness } from './testing/harness';

describe('runners and jobs API', () => {
  let h: GithubHarness;
  beforeAll(async () => {
    h = await createGithubHarness();
    await h.addNode(1);
  });
  afterAll(() => h.close());

  test('require sign-in', async () => {
    for (const [method, path] of [
      ['GET', '/v1/runners'],
      ['GET', '/v1/jobs'],
      ['PUT', '/v1/github/integration'],
      ['POST', '/v1/github/verify'],
    ] as const) {
      expect((await h.call(method, path)).status).toBe(401);
    }
  });

  test('before the integration is configured nothing is invented', async () => {
    const reply = await h.admin('GET', '/v1/runners');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      available: true,
      integration: { status: 'unconfigured', repositories: [] },
      connection: {
        keyConfigured: true,
        webhookEnabled: true,
        configured: false,
      },
      runners: [],
    });
    expect((await h.admin('GET', '/v1/jobs')).body).toEqual({
      jobs: [],
      nextBefore: null,
    });
  });

  test('without the operator key the page says so and shows no data', async () => {
    const bare = await createGithubHarness({ key: false });
    try {
      const reply = await bare.admin('GET', '/v1/runners');
      expect(reply.body.connection).toMatchObject({
        keyConfigured: false,
        configured: false,
      });
      const verify = await bare.admin('POST', '/v1/github/verify');
      expect(verify.body.ok).toBe(false);
      expect(verify.body.checks[0].message).toContain(
        'FLEET_GITHUB_APP_PRIVATE_KEY'
      );
      expect(bare.fake.requests).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });

  test('saving validates strictly and is audited', async () => {
    const bad = await h.admin('PUT', '/v1/github/integration', {
      scope: 'galaxy',
      repositories: ['no-slash'],
      appId: 'abc',
      policy: { orphanAutoRemoval: 'yes', surprise: 1 },
      private_key: 'oops',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.join(' ')).toContain('scope must be');
    expect(bad.body.errors.join(' ')).toContain('private_key is not a setting');
    const saved = await h.admin('PUT', '/v1/github/integration', {
      scope: 'repository',
      repositories: ['acme/app'],
      appId: h.fake.appId,
      installationId: h.fake.installationId,
      policy: { extraLabels: ['team-a'], orphanAutoRemoval: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.integration).toMatchObject({
      status: 'ok',
      repositories: ['acme/app'],
      policy: {
        extraLabels: ['team-a'],
        orphanAutoRemoval: true,
        orphanGraceSeconds: 1800,
      },
    });
    const audit = await h.store.listAudit({
      limit: 10,
      targetKind: 'github-integration',
    });
    expect(audit.map((a) => `${a.action}:${a.outcome}`)).toEqual([
      'github.integration.update:success',
      'github.integration.update:failed',
    ]);
    expect(JSON.stringify(audit)).not.toContain('oops');
  });

  test('the private key is never rendered or stored', async () => {
    const reply = await h.admin('GET', '/v1/runners');
    expect(reply.text).not.toContain('PRIVATE KEY');
    const rows = await h.db.unsafe('select * from github_integration');
    expect(JSON.stringify(rows)).not.toContain('PRIVATE KEY');
    const dump = await h.db.unsafe(
      "select name from sqlite_master where name = 'controller_secrets'"
    );
    expect(dump.length).toBe(1);
    expect(
      (await h.db.unsafe('select count(*) as n from controller_secrets'))[0]?.[
        'n'
      ]
    ).toBe(0);
  });

  test('verify reports success, then names the missing permission', async () => {
    h.fake.runners.set('acme/app', []);
    h.fake.runs.set('acme/app', []);
    const ok = await h.admin('POST', '/v1/github/verify');
    expect(ok.body.ok).toBe(true);
    expect(ok.body.checks.map((c: { name: string }) => c.name)).toEqual([
      'app',
      'installation',
      'runners:acme/app',
      'registration:acme/app',
      'jobs:acme/app',
    ]);
    h.fake.injectAlways(
      'POST /repos/acme/app/actions/runners/registration-token',
      { status: 403 }
    );
    const denied = await h.admin('POST', '/v1/github/verify');
    expect(denied.body.ok).toBe(false);
    const check = denied.body.checks.find(
      (c: { name: string }) => c.name === 'registration:acme/app'
    );
    expect(check).toMatchObject({ ok: false, code: 'FLEET_GITHUB_SCOPE' });
    expect(check.message).toContain('Administration');
    expect((await h.github.store.getIntegration()).status).toBe('error');
    h.fake.clearInjected();
    const audit = await h.store.listAudit({
      limit: 5,
      targetKind: 'github-integration',
    });
    expect(audit[0]).toMatchObject({
      action: 'github.verify',
      outcome: 'failed',
    });
  });

  test('verify lists the installations when the installation ID is wrong', async () => {
    await h.configure({ installationId: '1' });
    h.fake.revokeInstallationTokens();
    const reply = await h.admin('POST', '/v1/github/verify');
    const check = reply.body.checks.find(
      (c: { name: string }) => c.name === 'installation'
    );
    expect(check.code).toBe('FLEET_GITHUB_SCOPE');
    expect(check.message).toContain('777 (acme)');
    await h.configure();
  });

  test('verify distinguishes an outage from a wrong setting', async () => {
    h.fake.injectAlways('GET /app', { status: 503 });
    const reply = await h.admin('POST', '/v1/github/verify');
    expect(reply.body).toMatchObject({ ok: false, temporary: true });
    expect((await h.github.store.getIntegration()).status).toBe('degraded');
    h.fake.clearInjected();
    h.clock.advance(3600);
  });

  test('jobs filter by status, repository and node, and page with before', async () => {
    await h.configure();
    h.clock.advance(3600);
    const iso = (s: number) =>
      new Date(h.clock.now().getTime() + s * 1000).toISOString();
    const jobs = (
      runId: number,
      ids: number[],
      status: string,
      conclusion: string | null
    ) =>
      ids.map((id) => ({
        id,
        run_id: runId,
        name: `j${id}`,
        status,
        conclusion,
        labels: ['ci'],
        runner_id: 1,
        runner_name: h.runnerName(1, 1),
        html_url: 'https://github.com/acme/app/actions',
        created_at: iso(-id * 10),
        started_at: status === 'queued' ? null : iso(-id * 10 + 5),
        completed_at: status === 'completed' ? iso(-id * 10 + 25) : null,
      }));
    h.fake.runs.set('acme/app', [
      { id: 1, status: 'queued', updated_at: iso(0) },
      { id: 2, status: 'in_progress', updated_at: iso(0) },
      { id: 3, status: 'completed', updated_at: iso(0) },
    ]);
    h.fake.jobs.set(1, jobs(1, [1], 'queued', null));
    h.fake.jobs.set(2, jobs(2, [2], 'in_progress', null));
    h.fake.jobs.set(3, [
      ...jobs(3, [3], 'completed', 'failure'),
      ...jobs(3, [4], 'completed', 'success'),
    ]);
    h.fake.runners.set('acme/app', []);
    await runGithubSync(h.github, h.deps.store);

    const failed = await h.admin('GET', '/v1/jobs?status=failed');
    expect(failed.body.jobs).toHaveLength(1);
    expect(failed.body.jobs[0]).toMatchObject({
      id: 3,
      failed: true,
      runSeconds: 20,
      queuedSeconds: 5,
      nodeLabel: `ci-${nodeIdOf(1).slice(0, 4)}`,
      reportUrl: '/report-issue?kind=workload&job=3',
    });
    expect(
      (await h.admin('GET', '/v1/jobs?status=queued')).body.jobs.map(
        (j: { id: number }) => j.id
      )
    ).toEqual([1]);
    expect(
      (await h.admin('GET', '/v1/jobs?status=active')).body.jobs
    ).toHaveLength(2);
    expect(
      (await h.admin('GET', '/v1/jobs?repository=other/repo')).body.jobs
    ).toHaveLength(0);
    expect(
      (await h.admin('GET', `/v1/jobs?node=${nodeIdOf(1)}`)).body.jobs
    ).toHaveLength(4);
    const first = await h.admin('GET', '/v1/jobs?limit=3');
    expect(first.body.jobs).toHaveLength(3);
    const rest = await h.admin(
      'GET',
      `/v1/jobs?limit=3&before=${String(first.body.nextBefore)}`
    );
    expect(rest.body.jobs).toHaveLength(1);
    expect(rest.body.nextBefore).toBeNull();
    for (const bad of [
      'status=weird',
      'repository=x',
      'before=-1',
      'limit=0',
      'node=zz',
    ]) {
      expect((await h.admin('GET', `/v1/jobs?${bad}`)).status).toBe(400);
    }
  });

  test('the capacity summary compares reported slots with queued jobs', async () => {
    await h.store.recordHeartbeat(
      nodeIdOf(1),
      heartbeatBody(1, { runners: { slots: 4, busy: 1 } }),
      null,
      h.clock.now()
    );
    const reply = await h.admin('GET', '/v1/runners');
    expect(reply.body.capacity).toMatchObject({
      slotsTotal: 4,
      slotsBusy: 1,
      slotsFree: 3,
      queued: 1,
      inProgress: 1,
      waiting: 0,
    });
  });
});
