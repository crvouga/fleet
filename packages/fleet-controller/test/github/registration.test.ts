import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import { createGithubHarness, type GithubHarness } from './testing/harness';
import { nodeIdOf, registerInput } from '../support/fixtures';

describe('POST /v1/runner-registration', () => {
  let h: GithubHarness;
  beforeAll(async () => {
    h = await createGithubHarness();
    await h.addNode(1);
    await h.addNode(2, { role: 'devbox' });
    await h.addNode(3);
    await h.configure({ repositories: ['acme/app', 'acme/api'] });
    await h.admin('PUT', '/v1/settings/node:' + nodeIdOf(1), {
      runners: { repositories: ['acme/app', 'acme/api'] },
    });
  });
  afterAll(() => h.close());
  beforeEach(() => {
    h.fake.clearInjected();
    h.fake.requests.length = 0;
  });

  const url = '/v1/runner-registration';

  test('needs the node credential', async () => {
    expect((await h.call('POST', url, { json: { slot: 1 } })).status).toBe(401);
    expect((await h.admin('POST', url, { slot: 1 })).status).toBe(401);
  });

  test('returns a short-lived token for the repository the slot is assigned', async () => {
    const reply = await h.asNode(1, 'POST', url, { slot: 'slot-2' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      scope: 'repository',
      target: 'acme/api',
      url: 'https://github.com/acme/api',
      runnerGroup: null,
    });
    expect(reply.body.token).toStartWith('REGTOKEN-');
    expect(new Date(reply.body.expiresAt).getTime()).toBeGreaterThan(
      h.clock.now().getTime()
    );
    expect(reply.headers.get('cache-control')).toBe('no-store');
  });

  test('honors a requested repository only when it is assigned to the node', async () => {
    const ok = await h.asNode(1, 'POST', url, {
      slot: 1,
      repository: 'acme/api',
    });
    expect(ok.body.target).toBe('acme/api');
    const refused = await h.asNode(1, 'POST', url, {
      slot: 1,
      repository: 'evil/other',
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'runner_not_allowed',
      code: 'repository_not_assigned',
    });
    expect(h.fake.count('registration-token')).toBe(1);
  });

  test('refuses a node whose role runs no runners, without calling GitHub', async () => {
    const reply = await h.asNode(2, 'POST', url, { slot: 1 });
    expect(reply.status).toBe(403);
    expect(reply.body.code).toBe('role_runs_no_runners');
    expect(h.fake.requests).toHaveLength(0);
  });

  test('refuses a cordoned or disabled node, and an unapproved one', async () => {
    await h.putSettings('node:' + nodeIdOf(1), {
      runners: { repositories: ['acme/app'], cordoned: true },
    });
    const drained = await h.asNode(1, 'POST', url, { slot: 1 });
    expect(drained.body).toMatchObject({
      error: 'runner_not_allowed',
      code: 'runners_drained',
    });
    await h.putSettings('node:' + nodeIdOf(1), {
      runners: { repositories: ['acme/app', 'acme/api'] },
    });
    await h.store.registerNode(registerInput(9));
    const pending = await h.asNode(9, 'POST', url, { slot: 1 });
    expect(pending.status).toBe(403);
    expect(h.fake.count('registration-token')).toBe(0);
  });

  test('validates the body', async () => {
    for (const body of [
      {},
      { slot: 0 },
      { slot: 'x' },
      { slot: 65 },
      { slot: 1, repository: 'no-slash' },
      { slot: 1, extra: 1 },
    ]) {
      expect((await h.asNode(1, 'POST', url, body)).status).toBe(400);
    }
  });

  test('concurrent requests for one slot share a single GitHub call', async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => h.asNode(1, 'POST', url, { slot: 1 }))
    );
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(new Set(replies.map((r) => r.body.token)).size).toBe(1);
    expect(h.fake.count('registration-token')).toBe(1);
  });

  test('a retry with the same idempotency key replays the answer', async () => {
    const first = await h.asNode(1, 'POST', url, {
      slot: 3,
      idempotencyKey: 'attempt-0001',
    });
    const retry = await h.asNode(1, 'POST', url, {
      slot: 3,
      idempotencyKey: 'attempt-0001',
    });
    expect(retry.body.token).toBe(first.body.token);
    const other = await h.asNode(1, 'POST', url, {
      slot: 3,
      idempotencyKey: 'attempt-0002',
    });
    expect(other.body.token).not.toBe(first.body.token);
    expect(h.fake.count('registration-token')).toBe(2);
  });

  test('a GitHub outage is a retryable 503 with Retry-After', async () => {
    h.fake.injectAlways('registration-token', { status: 503 });
    const reply = await h.asNode(1, 'POST', url, { slot: 4 });
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({
      error: 'github_unavailable',
      code: 'FLEET_GITHUB_UNAVAILABLE',
    });
    expect(Number(reply.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('a rate limit tells the node how long to wait', async () => {
    h.fake.injectAlways('registration-token', {
      status: 429,
      headers: { 'retry-after': '120' },
    });
    await h.asNode(1, 'POST', url, { slot: 5 });
    h.clock.advance(200);
    const reply = await h.asNode(1, 'POST', url, { slot: 5 });
    expect(reply.status).toBe(503);
    expect(reply.body.code).toBe('FLEET_GITHUB_RATE_LIMITED');
    expect(reply.headers.get('retry-after')).toBe('120');
  });

  test('a permanent refusal is a 422 with the public code', async () => {
    h.clock.advance(600);
    h.fake.injectAlways('registration-token', { status: 403 });
    const reply = await h.asNode(1, 'POST', url, { slot: 6 });
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({
      error: 'github_refused',
      code: 'FLEET_GITHUB_SCOPE',
    });
    expect(reply.body.message).toContain('Administration');
  });

  test('is audited without the token, and the token is never logged', async () => {
    h.fake.clearInjected();
    h.clock.advance(600);
    const reply = await h.asNode(1, 'POST', url, { slot: 7 });
    const audit = await h.store.listAudit({ limit: 100, targetKind: 'node' });
    const mine = audit.filter((a) => a.action === 'runner.registration');
    expect(mine.some((a) => a.outcome === 'success')).toBe(true);
    expect(mine.some((a) => a.outcome === 'denied')).toBe(true);
    expect(mine.some((a) => a.outcome === 'failed')).toBe(true);
    const everything = JSON.stringify(audit) + h.logs.join('\n');
    expect(everything).not.toContain(reply.body.token);
    expect(everything).not.toContain('REGTOKEN-');
  });

  test('is rate limited per node', async () => {
    h.fake.clearInjected();
    const fresh = await createGithubHarness();
    try {
      await fresh.addNode(1);
      await fresh.configure();
      await fresh.admin('PUT', '/v1/settings/node:' + nodeIdOf(1), {
        runners: { repositories: ['acme/app'] },
      });
      let limited = 0;
      for (let i = 0; i < 35; i += 1) {
        const reply = await fresh.asNode(1, 'POST', url, { slot: 1 });
        if (reply.status === 429) limited += 1;
      }
      expect(limited).toBe(5);
    } finally {
      await fresh.close();
    }
  });

  test('without the operator key nothing is simulated', async () => {
    const bare = await createGithubHarness({ key: false });
    try {
      await bare.addNode(1);
      await bare.configure();
      await bare.admin('PUT', '/v1/settings/node:' + nodeIdOf(1), {
        runners: { repositories: ['acme/app'] },
      });
      const reply = await bare.asNode(1, 'POST', url, { slot: 1 });
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({
        error: 'github_refused',
        code: 'FLEET_GITHUB_UNCONFIGURED',
      });
      expect(bare.fake.requests).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});
