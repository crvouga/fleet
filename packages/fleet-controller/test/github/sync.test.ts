import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runGithubSync } from '../../src/github/sync';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

import type { FakeJob, FakeRunner } from './testing/fake-github';
import { createGithubHarness, type GithubHarness } from './testing/harness';

let h: GithubHarness;

beforeEach(async () => {
  h = await createGithubHarness();
});
afterEach(() => h.close());

const iso = (seconds: number) =>
  new Date(h.clock.now().getTime() + seconds * 1000).toISOString();

function job(id: number, runId: number, over: Partial<FakeJob> = {}): FakeJob {
  return {
    id,
    run_id: runId,
    name: `build-${id}`,
    status: 'queued',
    conclusion: null,
    labels: ['self-hosted', 'ci'],
    runner_id: null,
    runner_name: null,
    html_url: `https://github.com/acme/app/actions/runs/${runId}/job/${id}`,
    created_at: iso(-120),
    started_at: null,
    completed_at: null,
    ...over,
  };
}

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
    labels: ['self-hosted', 'ci'],
    ...over,
  };
}

function seedJobs(): void {
  h.fake.runs.set('acme/app', [
    { id: 100, status: 'queued', updated_at: iso(-60) },
    { id: 101, status: 'in_progress', updated_at: iso(-30) },
    { id: 102, status: 'completed', updated_at: iso(-10) },
  ]);
  h.fake.jobs.set(100, [job(1, 100)]);
  h.fake.jobs.set(101, [
    job(2, 101, {
      status: 'in_progress',
      started_at: iso(-60),
      runner_id: 7,
      runner_name: h.runnerName(1, 1),
    }),
  ]);
  h.fake.jobs.set(102, [
    job(3, 102, {
      status: 'completed',
      conclusion: 'failure',
      started_at: iso(-200),
      completed_at: iso(-20),
      runner_id: 7,
      runner_name: h.runnerName(1, 1),
    }),
  ]);
}

describe('GitHub sync', () => {
  test('does nothing, and calls nothing, until the integration is configured', async () => {
    const outcome = await runGithubSync(h.github, h.deps.store);
    expect(outcome).toMatchObject({ ran: false, skipped: 'unconfigured' });
    expect(h.fake.requests).toHaveLength(0);
    expect((await h.github.store.getIntegration()).status).toBe('unconfigured');
  });

  test('without the operator key nothing is simulated and GitHub is not called', async () => {
    const bare = await createGithubHarness({ key: false });
    try {
      await bare.configure();
      const outcome = await runGithubSync(bare.github, bare.deps.store);
      expect(outcome.skipped).toBe('unconfigured');
      expect(bare.fake.requests).toHaveLength(0);
      const integration = await bare.github.store.getIntegration();
      expect(integration.lastError).toContain('FLEET_GITHUB_APP_PRIVATE_KEY');
      expect((await bare.github.store.listJobs({ limit: 10 })).length).toBe(0);
    } finally {
      await bare.close();
    }
  });

  test('pulls runners and jobs into the database and correlates them to nodes', async () => {
    await h.addNode(1);
    await h.configure();
    h.fake.runners.set('acme/app', [
      runner(7, h.runnerName(1, 1), { busy: true }),
    ]);
    seedJobs();
    const outcome = await runGithubSync(h.github, h.deps.store);
    expect(outcome).toMatchObject({
      ran: true,
      status: 'ok',
      runners: 1,
      jobs: 3,
      orphans: 0,
    });
    const jobs = await h.github.store.listJobs({ limit: 10 });
    expect(jobs.map((j) => j.id)).toEqual([3, 2, 1]);
    expect(jobs.find((j) => j.id === 2)?.nodeId).toBe(nodeIdOf(1));
    const failed = await h.github.store.listJobs({
      limit: 10,
      status: 'failed',
    });
    expect(failed.map((j) => j.id)).toEqual([3]);
    const runners = await h.github.store.listRunners();
    expect(runners[0]).toMatchObject({
      id: 7,
      nodeId: nodeIdOf(1),
      slot: 'slot-1',
      busy: true,
    });
    const integration = await h.github.store.getIntegration();
    expect(integration).toMatchObject({ status: 'ok', lastError: null });
    expect(integration.lastSyncAt).not.toBeNull();
  });

  test('is idempotent: a second pass changes nothing', async () => {
    await h.addNode(1);
    await h.configure();
    h.fake.runners.set('acme/app', [runner(7, h.runnerName(1, 1))]);
    seedJobs();
    await runGithubSync(h.github, h.deps.store);
    const before = JSON.stringify(await h.github.store.listJobs({ limit: 50 }));
    h.clock.advance(61);
    await runGithubSync(h.github, h.deps.store);
    const after = JSON.stringify(await h.github.store.listJobs({ limit: 50 }));
    expect(after.replace(/"updatedAt":"[^"]+"/g, '')).toBe(
      before.replace(/"updatedAt":"[^"]+"/g, '')
    );
    expect((await h.github.store.listRunners()).length).toBe(1);
  });

  test('inside the interval a tick is skipped without calling GitHub', async () => {
    await h.configure();
    await runGithubSync(h.github, h.deps.store);
    const calls = h.fake.requests.length;
    const outcome = await runGithubSync(h.github, h.deps.store);
    expect(outcome).toMatchObject({ ran: false, skipped: 'not-due' });
    expect(h.fake.requests.length).toBe(calls);
  });

  test('a job that finished while the controller was away still converges', async () => {
    await h.configure();
    h.fake.runs.set('acme/app', [
      { id: 100, status: 'queued', updated_at: iso(-60) },
    ]);
    h.fake.jobs.set(100, [job(1, 100)]);
    await runGithubSync(h.github, h.deps.store);
    expect((await h.github.store.getJob(1))?.status).toBe('queued');
    h.clock.advance(3600);
    h.fake.runs.set('acme/app', []);
    h.fake.jobs.set(100, [
      job(1, 100, {
        status: 'completed',
        conclusion: 'success',
        started_at: iso(-3000),
        completed_at: iso(-2900),
      }),
    ]);
    await runGithubSync(h.github, h.deps.store);
    expect((await h.github.store.getJob(1))?.status).toBe('completed');
  });

  test('a rate limit degrades the integration and backs off without hammering GitHub', async () => {
    await h.configure();
    h.fake.injectAlways('GET /repos/acme/app/actions/runners', {
      status: 429,
      headers: { 'retry-after': '300' },
    });
    const first = await runGithubSync(h.github, h.deps.store);
    expect(first).toMatchObject({ ran: true, status: 'degraded' });
    expect(first.error).toContain('FLEET_GITHUB_RATE_LIMITED');
    const calls = h.fake.requests.length;
    h.clock.advance(120);
    expect(await runGithubSync(h.github, h.deps.store)).toMatchObject({
      ran: false,
      skipped: 'backoff',
    });
    expect(h.fake.requests.length).toBe(calls);
    h.fake.clearInjected();
    h.clock.advance(300);
    expect(await runGithubSync(h.github, h.deps.store)).toMatchObject({
      ran: true,
      status: 'ok',
    });
    const events = await h.store.listEvents({ limit: 20 });
    expect(events.map((e) => e.kind)).toContain('github-sync');
    expect((await h.github.store.getIntegration()).lastError).toBeNull();
  });

  test('a 5xx outage degrades and recovers', async () => {
    await h.configure();
    h.fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 502 });
    expect(await runGithubSync(h.github, h.deps.store)).toMatchObject({
      status: 'degraded',
    });
    h.fake.clearInjected();
    h.clock.advance(600);
    expect(await runGithubSync(h.github, h.deps.store)).toMatchObject({
      status: 'ok',
    });
  });

  test.each([
    [401, 'FLEET_GITHUB_KEY'],
    [403, 'FLEET_GITHUB_SCOPE'],
    [404, 'FLEET_GITHUB_SCOPE'],
  ])(
    'a permanent %d is recorded as an error with the public code',
    async (status, code) => {
      await h.configure();
      h.fake.injectAlways('GET /repos/acme/app/actions/runners', {
        status,
        body: { message: 'secret-body' },
      });
      const outcome = await runGithubSync(h.github, h.deps.store);
      expect(outcome.status).toBe('error');
      const integration = await h.github.store.getIntegration();
      expect(integration.status).toBe('error');
      expect(integration.lastError).toContain(code);
      expect(integration.lastError).not.toContain('secret-body');
      expect(h.logs.join('\n')).not.toContain('secret-body');
    }
  );

  test('an installation token that expires mid-sync is replaced and the sync completes', async () => {
    await h.configure();
    h.fake.runners.set('acme/app', [runner(7, h.runnerName(1, 1))]);
    await runGithubSync(h.github, h.deps.store);
    h.fake.revokeInstallationTokens();
    h.clock.advance(61);
    expect(await runGithubSync(h.github, h.deps.store)).toMatchObject({
      ran: true,
      status: 'ok',
    });
  });

  test('a controller restart in the middle of a sync repeats the same decisions', async () => {
    await h.addNode(1);
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    const ghost = 'ci-dead-' + 'f'.repeat(32) + '-slot-1';
    h.fake.runners.set('acme/app', [
      runner(7, h.runnerName(1, 1)),
      runner(8, ghost, { status: 'offline' }),
    ]);
    seedJobs();
    await runGithubSync(h.github, h.deps.store);
    expect(
      (await h.github.store.listRunners()).find((r) => r.id === 8)?.orphanSince
    ).not.toBeNull();
    h.clock.advance(120);
    // The removal fails halfway: GitHub goes away after the records were stored.
    h.fake.injectAlways('DELETE /repos/acme/app/actions/runners/8', {
      status: 503,
    });
    const crashed = await runGithubSync(h.github, h.deps.store);
    expect(crashed.status).toBe('degraded');
    const restarted = await h.restart();
    try {
      restarted.fake.clearInjected();
      restarted.clock.advance(600);
      const outcome = await runGithubSync(
        restarted.github,
        restarted.deps.store
      );
      expect(outcome).toMatchObject({ status: 'ok', removed: 1 });
      expect(restarted.fake.runners.get('acme/app')?.map((r) => r.id)).toEqual([
        7,
      ]);
      expect(
        (await restarted.github.store.listJobs({ limit: 10 })).length
      ).toBe(3);
      await runGithubSync(restarted.github, restarted.deps.store);
      expect(
        (await restarted.github.store.listJobs({ limit: 10 })).length
      ).toBe(3);
    } finally {
      h = restarted;
    }
  });
});

describe('orphan runners', () => {
  const ghostName = 'ci-dead-' + 'e'.repeat(32) + '-slot-2';

  async function sync(): Promise<void> {
    await runGithubSync(h.github, h.deps.store);
    h.clock.advance(61);
  }

  test('are flagged but never deleted while the policy is off', async () => {
    await h.configure({ policy: { orphanGraceSeconds: 60 } });
    h.fake.runners.set('acme/app', [
      runner(8, ghostName, { status: 'offline' }),
    ]);
    await sync();
    h.clock.advance(7200);
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(1);
    expect((await h.github.store.listRunners())[0]?.orphanSince).not.toBeNull();
    expect(
      (await h.store.listEvents({ limit: 20 })).filter(
        (e) => e.kind === 'runner-orphan'
      )
    ).toHaveLength(1);
  });

  test('are removed only after the grace period, and each removal is audited', async () => {
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 600 },
    });
    h.fake.runners.set('acme/app', [
      runner(8, ghostName, { status: 'offline' }),
    ]);
    await sync();
    h.clock.advance(300);
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(1);
    h.clock.advance(400);
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(0);
    const audit = await h.store.listAudit({
      limit: 50,
      targetKind: 'github-runner',
    });
    expect(
      audit.find((a) => a.action === 'runner.orphan.remove')
    ).toMatchObject({
      outcome: 'success',
      detail: { reason: 'unknown-node' },
    });
  });

  test('a busy runner is never deleted, however long it has been an orphan', async () => {
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    h.fake.runners.set('acme/app', [runner(8, ghostName, { busy: true })]);
    for (let i = 0; i < 4; i += 1) {
      await sync();
      h.clock.advance(3600);
    }
    expect(h.fake.runners.get('acme/app')).toHaveLength(1);
    expect(h.fake.count('DELETE /repos/acme/app/actions/runners/8')).toBe(0);
  });

  test('a runner that turns busy between the poll and the delete is left alone', async () => {
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    h.fake.runners.set('acme/app', [
      runner(8, ghostName, { status: 'offline' }),
    ]);
    await sync();
    h.clock.advance(300);
    const live = h.fake.runners.get('acme/app')?.[0];
    h.fake.inject('GET /repos/acme/app/actions/runners', {
      status: 200,
      body: { runners: [{ ...live, busy: false }] },
    });
    if (live !== undefined) live.busy = true; // GitHub refuses to delete it (422)
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(1);
  });

  test('a retired node, and a node that left the ci role, strand their runners', async () => {
    await h.addNode(1);
    await h.addNode(2);
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    await h.store.setApproval(nodeIdOf(1), 'retired', 'tester');
    await h.store.assignRole(nodeIdOf(2), 'devbox', 'tester');
    h.fake.runners.set('acme/app', [
      runner(1, h.runnerName(1, 1)),
      runner(2, h.runnerName(2, 1)),
    ]);
    await sync();
    h.clock.advance(120);
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(0);
  });

  test('an offline node strands an idle runner after the grace period, not before', async () => {
    await h.addNode(1);
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 600 },
    });
    h.fake.runners.set('acme/app', [runner(1, h.runnerName(1, 1))]);
    await sync();
    h.clock.advance(3600);
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(1);
    h.clock.advance(601);
    await sync();
    expect(h.fake.runners.get('acme/app')).toHaveLength(0);
  });

  test('a healthy runner and a runner that is not the fleet’s are never touched', async () => {
    await h.addNode(1);
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    h.fake.runners.set('acme/app', [
      runner(1, h.runnerName(1, 1)),
      runner(2, 'my-laptop', { status: 'offline' }),
      runner(3, 'builder-slot-1', { status: 'offline' }),
    ]);
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(3600);
      await h.store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1),
        null,
        h.clock.now()
      );
      await runGithubSync(h.github, h.deps.store);
    }
    expect(h.fake.runners.get('acme/app')).toHaveLength(3);
  });

  test('a cordoned node’s runners lose their routing labels but are not deleted', async () => {
    await h.addNode(1);
    await h.addNode(2);
    await h.configure();
    await h.putSettings('node:' + nodeIdOf(1), { runners: { cordoned: true } });
    h.fake.runners.set('acme/app', [
      runner(1, h.runnerName(1, 1), {
        labels: ['self-hosted', 'linux', 'x64', 'ci', 'gpu'],
      }),
    ]);
    await sync();
    expect(h.fake.runners.get('acme/app')?.[0]?.labels).toEqual([
      'self-hosted',
      'linux',
      'x64',
    ]);
    await sync();
    h.clock.advance(61);
    await sync();
    expect(
      h.fake.count('DELETE /repos/acme/app/actions/runners/1/labels')
    ).toBe(2);
  });
});
