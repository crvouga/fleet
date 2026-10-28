import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createController } from '../../src/app';
import { mountUi } from '../../src/routes/ui';
import { runGithubSync } from '../../src/github/sync';
import { ADMIN_TOKEN, silent } from '../support/controller';
import { createTestDeps } from '../../src/testing/test-deps';
import { Hono } from 'hono';

import { createGithubHarness, type GithubHarness } from './testing/harness';

const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('the /runners page', () => {
  let h: GithubHarness;
  let app: Hono;
  beforeAll(async () => {
    h = await createGithubHarness({ key: false });
    app = createController(h.deps, { log: silent });
    mountUi(app, h.deps);
  });
  afterAll(() => h.close());

  test('requires sign-in', async () => {
    const reply = await app.request('/runners');
    expect(reply.status).toBe(303);
    expect(reply.headers.get('location')).toContain('/login');
  });

  test('without the operator key it says so and shows nothing invented', async () => {
    const reply = await app.request('/runners', { headers: auth });
    expect(reply.status).toBe(200);
    const page = await reply.text();
    expect(page).toContain('<title>Runners');
    expect(page).toContain('FLEET_GITHUB_APP_PRIVATE_KEY');
    expect(page).toContain('Nothing is simulated');
    expect(page).toContain('GitHub lists no Fleet runners');
    expect(page).toContain('No jobs have been recorded');
    expect(page).toContain('href="/runners"');
  });

  test('is served by the single-page console route too', async () => {
    const reply = await app.request('/ui/state?path=%2Frunners', {
      headers: auth,
    });
    expect(reply.status).toBe(200);
  });

  test('with data it lists jobs with durations and a report link for failures', async () => {
    const live = await createGithubHarness();
    try {
      await live.addNode(1);
      await live.configure();
      live.fake.runners.set('acme/app', []);
      live.fake.runs.set('acme/app', [
        {
          id: 9,
          status: 'completed',
          updated_at: live.clock.now().toISOString(),
        },
      ]);
      const stamp = (s: number) =>
        new Date(live.clock.now().getTime() + s * 1000).toISOString();
      live.fake.jobs.set(9, [
        {
          id: 77,
          run_id: 9,
          name: 'unit <tests>',
          status: 'completed',
          conclusion: 'failure',
          labels: ['ci'],
          runner_id: 1,
          runner_name: live.runnerName(1, 1),
          html_url: 'https://github.com/acme/app/actions/runs/9/job/77',
          created_at: stamp(-300),
          started_at: stamp(-240),
          completed_at: stamp(-60),
        },
      ]);
      await runGithubSync(live.github, live.deps.store);
      const liveApp = createController(live.deps, { log: silent });
      mountUi(liveApp, live.deps);
      const page = await (
        await liveApp.request('/runners', { headers: auth })
      ).text();
      expect(page).toContain('unit &lt;tests&gt;');
      expect(page).not.toContain('unit <tests>');
      expect(page).toContain('href="/report-issue?kind=workload&amp;job=77"');
      expect(page).toContain('3m');
      expect(page).toContain('1m');
    } finally {
      await live.close();
    }
  });

  test('without the GitHub integration (synthetic fixtures) it says it is unavailable', async () => {
    const deps = createTestDeps();
    const plain = new Hono();
    mountUi(plain, deps);
    const page = await (
      await plain.request('/runners', {
        headers: { cookie: 'fleet_session=ok:tester' },
      })
    ).text();
    expect(page).toContain('not available in this mode');
  });
});
