import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { runGithubSync } from '../../../src/github/sync';
import { nodeIdOf } from '../../support/fixtures';
import type { FakeRunner } from '../testing/fake-github';
import {
  createGithubHarness,
  WEBHOOK_SECRET,
  type GithubHarness,
} from '../testing/harness';
import { ping, workflowJob, workflowRun } from '../testing/webhook-payloads';

import { github } from './openapi';
import {
  allProblems,
  coverageKey,
  recordingFetch,
  type Exchange,
} from './recorder';

/**
 * The whole controller (routes, sync job, registration, verify, webhook) on a
 * real SQLite database, talking to the loopback fake through a recorder. Every
 * GitHub request it makes and every fake answer must conform.
 */
let h: GithubHarness;
let exchanges: Exchange[];

beforeAll(async () => {
  const rec = recordingFetch();
  exchanges = rec.exchanges;
  h = await createGithubHarness({ fetch: rec.fetch });
  await h.addNode(1);
  await h.addNode(2);
});
afterAll(() => h.close());

const iso = (seconds: number) =>
  new Date(h.clock.now().getTime() + seconds * 1000).toISOString();

function runner(
  id: number,
  name: string,
  over: Partial<FakeRunner> = {}
): FakeRunner {
  return {
    id,
    name,
    status: 'online',
    busy: false,
    labels: ['self-hosted', 'linux', 'x64', 'ci'],
    ...over,
  };
}

function seedWorkflows(): void {
  h.fake.runs.set('acme/app', [
    { id: 100, status: 'queued', updated_at: iso(-60) },
    { id: 101, status: 'in_progress', updated_at: iso(-30) },
    { id: 102, status: 'completed', updated_at: iso(-10) },
  ]);
  const base = {
    labels: ['self-hosted', 'ci'],
    created_at: iso(-120),
    conclusion: null,
    completed_at: null,
    runner_id: null,
    runner_name: null,
    started_at: null,
  };
  const url = (run: number, id: number) =>
    `https://github.com/acme/app/actions/runs/${run}/job/${id}`;
  h.fake.jobs.set(100, [
    {
      ...base,
      id: 1,
      run_id: 100,
      name: 'queued',
      status: 'queued',
      html_url: url(100, 1),
    },
  ]);
  h.fake.jobs.set(101, [
    {
      ...base,
      id: 2,
      run_id: 101,
      name: 'running',
      status: 'in_progress',
      started_at: iso(-60),
      runner_id: 7,
      runner_name: h.runnerName(1, 1),
      html_url: url(101, 2),
    },
  ]);
  h.fake.jobs.set(102, [
    {
      ...base,
      id: 3,
      run_id: 102,
      name: 'done',
      status: 'completed',
      conclusion: 'failure',
      started_at: iso(-200),
      completed_at: iso(-20),
      runner_id: 7,
      runner_name: h.runnerName(1, 1),
      html_url: url(102, 3),
    },
  ]);
}

function conforms(): void {
  expect(exchanges.length).toBeGreaterThan(0);
  expect(allProblems(exchanges)).toEqual([]);
}

describe('controller to GitHub, repository scope', () => {
  test('sync: runners, runs, jobs, orphan removal and label removal all conform', async () => {
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    await h.putSettings('node:' + nodeIdOf(2), { runners: { cordoned: true } });
    h.fake.runners.set('acme/app', [
      runner(7, h.runnerName(1, 1), { busy: true }),
      runner(8, h.runnerName(2, 1), {
        labels: ['self-hosted', 'linux', 'x64', 'ci', 'gpu'],
      }),
      runner(9, 'ci-dead-' + 'e'.repeat(32) + '-slot-2', { status: 'offline' }),
    ]);
    seedWorkflows();
    await runGithubSync(h.github, h.deps.store);
    h.clock.advance(61);
    await runGithubSync(h.github, h.deps.store);
    expect(h.fake.runners.get('acme/app')?.map((r) => r.id)).toEqual([7, 8]);
    expect(await h.github.store.getJob(1)).toMatchObject({
      status: 'queued',
      startedAt: null,
    });
    conforms();
    const keys = exchanges.map((e) => `${e.method} ${e.path}`);
    expect(keys).toContain('DELETE /repos/acme/app/actions/runners/9');
    expect(keys).toContain(
      'DELETE /repos/acme/app/actions/runners/8/labels/ci'
    );
  });

  test('verify connection conforms, including the permission failure answer', async () => {
    const ok = await h.admin('POST', '/v1/github/verify');
    expect(ok.body.ok).toBe(true);
    h.fake.inject('POST /repos/acme/app/actions/runners/registration-token', {
      status: 403,
      body: {
        message: 'Resource not accessible by integration',
        documentation_url: 'https://docs.github.com/rest',
      },
    });
    expect((await h.admin('POST', '/v1/github/verify')).body.ok).toBe(false);
    conforms();
  });

  test('node registration conforms', async () => {
    const reply = await h.asNode(1, 'POST', '/v1/runner-registration', {
      slot: 'slot-1',
    });
    expect(reply.status).toBe(200);
    conforms();
  });

  test('a rate-limited sync backs off and the injected answer conforms', async () => {
    h.clock.advance(7200);
    h.fake.inject('GET /repos/acme/app/actions/runners', {
      status: 429,
      headers: { 'retry-after': '30' },
      body: {
        message: 'Too Many Requests',
        documentation_url: 'https://docs.github.com/rest',
      },
    });
    await runGithubSync(h.github, h.deps.store);
    expect((await h.github.store.getIntegration()).status).toBe('degraded');
    conforms();
  });
});

describe('controller to GitHub, organization scope', () => {
  test('org runners, installation repositories and org registration tokens conform', async () => {
    h.clock.advance(7200);
    h.fake.clearInjected();
    await h.configure({
      scope: 'organization',
      organization: 'acme',
      repositories: [],
      runnerGroup: null,
    });
    h.fake.runners.set('acme', [runner(20, h.runnerName(1, 2))]);
    h.fake.runs.set('acme/app', [
      { id: 100, status: 'queued', updated_at: iso(-60) },
    ]);
    await h.admin('PUT', '/v1/settings/node:' + nodeIdOf(1), {
      runners: { repositories: [] },
    });
    await runGithubSync(h.github, h.deps.store);
    const reply = await h.asNode(1, 'POST', '/v1/runner-registration', {
      slot: 'slot-2',
    });
    expect(reply.status).toBe(200);
    conforms();
    const touched = new Set(
      exchanges.map((e) => github.find(e.method, e.path)?.template)
    );
    expect(touched).toContain('/orgs/{org}/actions/runners');
    expect(touched).toContain('/installation/repositories');
    expect(touched).toContain('/orgs/{org}/actions/runners/registration-token');
  });
});

describe('webhook payloads', () => {
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  let delivery = 0;

  async function deliver(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    delivery += 1;
    return h.call('POST', '/v1/github/webhook', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': `contract-delivery-${delivery}`,
        'x-hub-signature-256': sign(body),
      },
    });
  }

  test('every workflow_job payload the tests send is a valid GitHub payload, and the controller stores it', async () => {
    await h.configure();
    let id = 600;
    for (const action of ['queued', 'waiting', 'in_progress', 'completed']) {
      id += 1;
      const payload = workflowJob({ id }, action);
      expect(
        github.webhookProblems(
          `workflow-job-${action.replace('_', '-')}`,
          payload
        )
      ).toEqual([]);
      expect((await deliver('workflow_job', payload)).body.result).toBe('job');
      const stored = await h.github.store.getJob(id);
      expect(stored?.repository).toBe('acme/app');
      // GitHub sends started_at (the creation time) even for a job still waiting for a runner.
      if (action === 'queued') expect(stored?.startedAt).toBeNull();
    }
  });

  test('workflow_run and ping payloads are valid and handled', async () => {
    for (const action of ['requested', 'in_progress', 'completed']) {
      const payload = workflowRun(action);
      expect(
        github.webhookProblems(
          `workflow-run-${action.replace('_', '-')}`,
          payload
        )
      ).toEqual([]);
      expect((await deliver('workflow_run', payload)).body.result).toBe(
        'sync-requested'
      );
    }
    expect(github.webhookProblems('ping', ping())).toEqual([]);
    expect((await deliver('ping', ping())).body.result).toBe('pong');
  });

  test('a payload missing what GitHub always sends is caught', () => {
    const broken = workflowJob({ id: 1 }, 'queued') as Record<
      string,
      Record<string, unknown>
    >;
    delete broken['workflow_job']?.['run_id'];
    expect(
      github.webhookProblems('workflow-job-queued', broken).join()
    ).toContain('run_id');
    const wrongType = workflowJob({ status: 'sleeping' }, 'queued');
    expect(
      github.webhookProblems('workflow-job-queued', wrongType).join()
    ).toContain('status');
  });
});

describe('what the controller exercised', () => {
  test('sync, verify and registration exercised every runner, job, label and token operation', () => {
    const covered = new Set(exchanges.map(coverageKey));
    for (const key of [
      'GET /repos/{owner}/{repo}/actions/runners 200',
      'GET /repos/{owner}/{repo}/actions/runs 200',
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs 200',
      'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id} 204',
      'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}/labels/{name} 200',
      'POST /repos/{owner}/{repo}/actions/runners/registration-token 201',
      'POST /repos/{owner}/{repo}/actions/runners/registration-token 403',
      'GET /repos/{owner}/{repo}/actions/runners 429',
      'GET /app 200',
    ])
      expect(covered).toContain(key);
  });
});
