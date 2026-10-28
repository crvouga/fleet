import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runGithubSyncJob } from '../../src/jobs/github-sync';
import type { JobDeps } from '../../src/jobs/offline-notifier';
import { silent } from '../support/controller';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';
import { recordingLogger } from '../support/recording-logger';

import type { FakeJob, FakeRunner } from './testing/fake-github';
import { createGithubHarness, type GithubHarness } from './testing/harness';

const CANARY = 'ghs_CANARY_TOKEN_must_never_appear';
let h: GithubHarness;
let posted: { url: string; body: string }[];

beforeEach(async () => {
  h = await createGithubHarness();
  posted = [];
});
afterEach(() => h.close());

const iso = (seconds: number) =>
  new Date(h.clock.now().getTime() + seconds * 1000).toISOString();

function jobDeps(harness: GithubHarness = h): JobDeps {
  return {
    store: harness.deps.store,
    now: harness.clock.now,
    log: recordingLogger(),
    github: harness.github,
    fetch: async (url, init) => {
      posted.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('ok');
    },
  };
}

function queuedJob(id: number, waitedSeconds: number): FakeJob {
  return {
    id,
    run_id: 100,
    name: `build-${id}`,
    status: 'queued',
    conclusion: null,
    labels: ['self-hosted', 'nixos', 'ci'],
    runner_id: null,
    runner_name: null,
    html_url: `https://github.com/acme/app/actions/runs/100/job/${id}`,
    created_at: iso(-waitedSeconds),
    started_at: null,
    completed_at: null,
  };
}

function idleRunner(name: string): FakeRunner {
  return {
    id: 7,
    name,
    status: 'online',
    busy: false,
    labels: ['self-hosted', 'linux', 'x64', 'nixos', 'ci'],
  };
}

/** The node reports now (so it stays online), with these readiness issues. */
async function beat(issues: string[] = []): Promise<void> {
  await h.store.recordHeartbeat(
    nodeIdOf(1),
    heartbeatBody(1, { readiness: { issues } }),
    null,
    h.clock.now()
  );
}

/** One scheduler pass a minute later: the node reports, then the sync job runs. */
async function pass(issues: string[] = [], deps = jobDeps()): Promise<void> {
  h.clock.advance(61);
  await beat(issues);
  await runGithubSyncJob(deps);
}

async function healthEvents() {
  const rows = await h.store.listEvents({
    limit: 100,
    kinds: [
      'runner_queue_stalled',
      'runner_queue_ok',
      'runners_offline',
      'runners_ok',
      'runner_registration_failing',
      'runner_registration_ok',
    ],
  });
  return [...rows].reverse();
}

const kinds = async () => (await healthEvents()).map((e) => e.kind);

async function seedStalledQueue(): Promise<void> {
  await h.addNode(1);
  await h.configure();
  h.fake.runners.set('acme/app', []);
  h.fake.runs.set('acme/app', [
    { id: 100, status: 'queued', updated_at: iso(-60) },
  ]);
  h.fake.jobs.set(100, [queuedJob(1, 11 * 60)]);
}

describe('queue stall detection in the GitHub sync job', () => {
  test('a long-queued job with no idle runner opens one incident, once', async () => {
    await seedStalledQueue();
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled']);
    await pass();
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled']);

    const incidents = await h.admin('GET', '/v1/incidents?open=true');
    expect(incidents.body.incidents).toHaveLength(1);
    expect(incidents.body.incidents[0]).toMatchObject({
      rule: 'runner_queue',
      title: 'CI job queue stalled',
      nodeId: null,
      severity: 'warn',
      open: true,
    });
    expect(incidents.body.incidents[0].reportHref).toMatch(
      /^\/report-issue\?kind=workload&event=\d+$/
    );
  });

  test('a job that has not waited long enough opens nothing', async () => {
    await h.addNode(1);
    await h.configure();
    h.fake.runners.set('acme/app', [idleRunner(h.runnerName(1, 1))]);
    h.fake.runs.set('acme/app', [
      { id: 100, status: 'queued', updated_at: iso(-60) },
    ]);
    h.fake.jobs.set(100, [queuedJob(1, 120)]);
    await pass();
    await pass();
    expect(await kinds()).toEqual([]);
  });

  test('it closes only after the condition stays gone for the hold, and not again', async () => {
    await seedStalledQueue();
    await pass();
    // An idle runner appears: the job is taken a moment later.
    h.fake.runners.set('acme/app', [idleRunner(h.runnerName(1, 1))]);
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled']);
    await pass();
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled', 'runner_queue_ok']);
    await pass();
    expect(await kinds()).toHaveLength(2);
    const incidents = await h.admin('GET', '/v1/incidents');
    expect(incidents.body.incidents[0]).toMatchObject({
      rule: 'runner_queue',
      open: false,
    });
  });

  test('it is restart-safe: a restarted controller announces nothing new', async () => {
    await seedStalledQueue();
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled']);
    const restarted = await h.restart();
    const before = h;
    h = restarted;
    try {
      await pass();
      await pass();
      expect(await kinds()).toEqual(['runner_queue_stalled']);
    } finally {
      h = before;
      await restarted.close();
    }
  });

  test('a degraded GitHub leaves open incidents alone and adds nothing', async () => {
    await seedStalledQueue();
    await pass();
    h.fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 503 });
    await pass();
    await pass();
    await pass();
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled']);
  });

  test('an unconfigured integration records nothing and exports no metrics', async () => {
    await h.addNode(1);
    await pass();
    expect(await kinds()).toEqual([]);
    const metrics = await h.admin('GET', '/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).not.toContain('fleet_runner_queue_stalled');
    expect(metrics.text).not.toContain('fleet_runners_online');
    expect(metrics.text).not.toContain('fleet_ci_jobs_queued_oldest_seconds');
  });
});

describe('runners_offline and registration failures', () => {
  test('no online runner for ten minutes while a CI node reports opens once', async () => {
    await h.addNode(1);
    await h.configure();
    h.fake.runners.set('acme/app', []);
    for (let i = 0; i < 9; i += 1) await pass();
    expect(await kinds()).toEqual([]);
    await pass();
    await pass();
    expect(await kinds()).toEqual(['runners_offline']);
    await pass();
    expect(await kinds()).toEqual(['runners_offline']);
    const [event] = await healthEvents();
    expect(event).toMatchObject({ nodeId: null, severity: 'error' });
  });

  test('an online runner clears it after the hold', async () => {
    await h.addNode(1);
    await h.configure();
    h.fake.runners.set('acme/app', []);
    for (let i = 0; i < 11; i += 1) await pass();
    expect(await kinds()).toEqual(['runners_offline']);
    h.fake.runners.set('acme/app', [idleRunner(h.runnerName(1, 1))]);
    for (let i = 0; i < 4; i += 1) await pass();
    expect(await kinds()).toEqual(['runners_offline', 'runners_ok']);
  });

  test('a node reporting FLEET_GITHUB_KEY opens a per-node incident with a node report link, an alert, and no secrets', async () => {
    await h.addNode(1);
    await h.configure();
    h.fake.runners.set('acme/app', [idleRunner(h.runnerName(1, 1))]);
    await h.putSettings('fleet', {
      alerts: { webhookUrl: 'https://alerts.example/hook' },
    });
    const issues = [`FLEET_GITHUB_KEY: refused ${CANARY}`];
    for (let i = 0; i < 4; i += 1) await pass(issues);
    expect(await kinds()).toEqual([]);
    await pass(issues);
    await pass(issues);
    const [event] = await healthEvents();
    expect(event).toMatchObject({
      kind: 'runner_registration_failing',
      nodeId: nodeIdOf(1),
      severity: 'error',
    });
    expect(await kinds()).toEqual(['runner_registration_failing']);

    const incidents = await h.admin('GET', '/v1/incidents?open=true');
    expect(incidents.body.incidents[0]).toMatchObject({
      rule: 'runner_registration',
      nodeId: nodeIdOf(1),
    });
    expect(incidents.body.incidents[0].reportHref).toMatch(
      /^\/report-issue\?kind=node&event=\d+$/
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('https://alerts.example/hook');
    expect(JSON.parse(posted[0]?.body ?? '{}')).toMatchObject({
      kind: 'runner_registration_failing',
    });

    // Neither the events, the incidents, the webhook nor the logs carry the node's text.
    const everything = [
      JSON.stringify(await healthEvents()),
      JSON.stringify(incidents.body),
      posted[0]?.body ?? '',
      ...h.logs,
    ].join('\n');
    expect(everything).not.toContain(CANARY);

    // The node recovers: one close, one more alert-free pass.
    for (let i = 0; i < 4; i += 1) await pass([]);
    expect(await kinds()).toEqual([
      'runner_registration_failing',
      'runner_registration_ok',
    ]);
  });
});

describe('metrics and the runners page', () => {
  test('with an integration the three series are exported, and disappear when the mirror goes stale', async () => {
    await seedStalledQueue();
    await pass();
    const text = (await h.admin('GET', '/metrics')).text;
    expect(text).toContain('fleet_runner_queue_stalled 1');
    expect(text).toContain('fleet_runners_online 0');
    expect(text).toMatch(/fleet_ci_jobs_queued_oldest_seconds 7\d\d/);

    // GitHub stops answering and nobody refreshes the mirror for a long time.
    h.clock.advance(3600);
    const stale = (await h.admin('GET', '/metrics')).text;
    expect(stale).not.toContain('fleet_runner_queue_stalled');
    expect(stale).not.toContain('fleet_runners_online');
  });

  test('without a GitHub runtime (fixtures, tests) there are no runner series at all', async () => {
    const { runnerHealthMetrics } =
      await import('../../src/routes/runner-health-metrics');
    const { createTestDeps } = await import('../../src/testing/test-deps');
    expect(await runnerHealthMetrics(createTestDeps())).toEqual([]);
  });

  test('a configured integration that never synced exports nothing either', async () => {
    await h.configure();
    expect((await h.admin('GET', '/metrics')).text).not.toContain(
      'fleet_runners_online'
    );
  });

  test('GET /v1/runners carries the health view with the threshold facts', async () => {
    await seedStalledQueue();
    await pass();
    const view = (await h.admin('GET', '/v1/runners')).body;
    expect(view.health).toMatchObject({
      available: true,
      runnersOnline: 0,
      queuedFleetJobs: 1,
      queueStalled: true,
    });
    expect(view.health.conditions[0]).toMatchObject({ rule: 'runner_queue' });
  });

  test('the thresholds are policy: a strict setting is validated and applied', async () => {
    await h.addNode(1);
    const bad = await h.admin('PUT', '/v1/github/integration', {
      scope: 'repository',
      repositories: ['acme/app'],
      appId: h.fake.appId,
      installationId: h.fake.installationId,
      policy: { queueStallMinutes: 0 },
    });
    expect(bad.status).toBe(400);
    await h.configure({ policy: { queueStallMinutes: 1 } });
    h.fake.runners.set('acme/app', []);
    h.fake.runs.set('acme/app', [
      { id: 100, status: 'queued', updated_at: iso(-60) },
    ]);
    h.fake.jobs.set(100, [queuedJob(1, 150)]);
    await pass();
    expect(await kinds()).toEqual(['runner_queue_stalled']);
  });

  test('the server page shows runner health and open incidents with report links', async () => {
    const { createController } = await import('../../src/app');
    const { mountUi } = await import('../../src/routes/ui');
    const { ADMIN_TOKEN } = await import('../support/controller');
    await seedStalledQueue();
    await pass();
    const app = createController(h.deps, { log: silent });
    mountUi(app, h.deps);
    const reply = await app.request('/runners', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const page = await reply.text();
    expect(page).toContain('Runner health');
    expect(page).toContain('stalled');
    expect(page).toContain('CI job queue stalled');
    expect(page).toMatch(/href="\/report-issue\?kind=workload&amp;event=\d+"/);
    const incidents = await app.request('/incidents', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(await incidents.text()).toContain('CI job queue stalled');
  });
});
