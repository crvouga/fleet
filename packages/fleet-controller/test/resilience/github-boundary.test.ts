import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runGithubSync } from '../../src/github/sync';
import { nodeIdOf } from '../support/fixtures';
import type { FakeRunner } from '../github/testing/fake-github';
import {
  createGithubHarness,
  type GithubHarness,
} from '../github/testing/harness';

import { prng } from './support/prng';

const URL_PATH = '/v1/runner-registration';
const REGISTRATION_TOKEN = 'registration-token';

let h: GithubHarness;

beforeEach(async () => {
  h = await createGithubHarness();
  await h.addNode(1);
  await h.configure();
});
afterEach(() => h.close());

const register = (slot = 1, extra: Record<string, unknown> = {}) =>
  h.asNode(1, 'POST', URL_PATH, { slot, ...extra });

const runner = (
  id: number,
  name: string,
  over: Partial<FakeRunner> = {}
): FakeRunner => ({
  id,
  name,
  status: 'online',
  busy: false,
  labels: ['self-hosted', 'ci'],
  ...over,
});

describe('Resilience (Req 11): GitHub failures at the runner-registration boundary', () => {
  test('a 5xx outage is a 503 with Retry-After, fails fast while the circuit is open, and recovers once GitHub does', async () => {
    h.fake.injectAlways(REGISTRATION_TOKEN, { status: 503 });
    const down = await register(1);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ error: 'github_unavailable' });
    const wait = Number(down.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    const calls = h.fake.count(REGISTRATION_TOKEN);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(3); // bounded retries

    // Inside the wait the controller does not hammer GitHub: it answers from the circuit.
    const again = await register(2);
    expect(again.status).toBe(503);
    expect(h.fake.count(REGISTRATION_TOKEN)).toBe(calls);

    h.fake.clearInjected();
    h.clock.advance(wait + 1);
    const recovered = await register(1);
    expect(recovered.status).toBe(200);
    expect(recovered.body.token).toStartWith('REGTOKEN-');
    expect((await register(2)).status).toBe(200);
  });

  test('a 429 with Retry-After is relayed to the node, costs no extra GitHub calls, and recovers after the wait', async () => {
    h.fake.injectAlways(REGISTRATION_TOKEN, {
      status: 429,
      headers: { 'retry-after': '90' },
    });
    const limited = await register(1);
    expect(limited.status).toBe(503);
    expect(limited.headers.get('retry-after')).toBe('90');
    const calls = h.fake.count(REGISTRATION_TOKEN);
    for (let i = 0; i < 5; i += 1)
      expect((await register(2 + i)).status).toBe(503);
    expect(h.fake.count(REGISTRATION_TOKEN)).toBe(calls);
    h.fake.clearInjected();
    h.clock.advance(91);
    expect((await register(1)).status).toBe(200);
  });

  test('one transient 502 is absorbed by the retry and the node never sees it', async () => {
    h.fake.inject(REGISTRATION_TOKEN, { status: 502 });
    const reply = await register(1);
    expect(reply.status).toBe(200);
    expect(h.fake.count(REGISTRATION_TOKEN)).toBe(2);
  });

  test('ten concurrent requests for one slot during an outage share one bounded attempt; after recovery they share one call', async () => {
    h.fake.injectAlways(REGISTRATION_TOKEN, { status: 503 });
    const during = await Promise.all(
      Array.from({ length: 10 }, () => register(1))
    );
    expect(during.every((r) => r.status === 503)).toBe(true);
    expect(h.fake.count(REGISTRATION_TOKEN)).toBeLessThanOrEqual(3);
    const wait = Number(during[0]?.headers.get('retry-after'));
    h.fake.clearInjected();
    h.fake.requests.length = 0;
    h.clock.advance(wait + 1);
    const after = await Promise.all(
      Array.from({ length: 10 }, () => register(1))
    );
    expect(after.every((r) => r.status === 200)).toBe(true);
    expect(new Set(after.map((r) => r.body.token)).size).toBe(1);
    expect(h.fake.count(REGISTRATION_TOKEN)).toBe(1);
  });

  test('a controller restart in the middle of an outage keeps the node retryable and recovers without operator action', async () => {
    h.fake.injectAlways(REGISTRATION_TOKEN, { status: 503 });
    expect((await register(1)).status).toBe(503);
    const restarted = await h.restart();
    h = restarted;
    h.fake.clearInjected();
    h.clock.advance(120);
    const reply = await register(1);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
  });

  test('credential revocation applies to runner registration at once, and the grant is never in the audit log', async () => {
    const ok = await register(1);
    expect(ok.status).toBe(200);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/revoke-credential`, {
      confirm: `ci-${nodeIdOf(1).slice(0, 4)}`,
    });
    const refused = await register(1);
    expect(refused.status).toBe(401);
    const calls = h.fake.count(REGISTRATION_TOKEN);
    await register(1);
    expect(h.fake.count(REGISTRATION_TOKEN)).toBe(calls);
    const audit = JSON.stringify(await h.store.listAudit({ limit: 200 }));
    expect(audit).not.toContain(ok.body.token);
  });

  test('a node drained after it asked is refused the next registration without calling GitHub', async () => {
    expect((await register(1)).status).toBe(200);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/drain`);
    h.fake.requests.length = 0;
    const refused = await register(2);
    expect(refused.status).toBe(403);
    expect(refused.body.code ?? refused.body.error).toBeDefined();
    expect(h.fake.count(REGISTRATION_TOKEN)).toBe(0);
  });
});

describe('Resilience (Req 11): GitHub sync job idempotence and orphan safety', () => {
  const ghost = (n: number) => `ci-dead-${String(n).padStart(32, 'e')}-slot-1`;

  async function counts() {
    return {
      runners: (await h.github.store.listRunners()).length,
      jobs: (await h.github.store.listJobs({ limit: 100 })).length,
      events: (await h.store.listEvents({ limit: 500 })).length,
      audit: (await h.store.listAudit({ limit: 500 })).length,
    };
  }

  test('restarting between passes never duplicates runners, jobs, events or audit rows', async () => {
    h.fake.runners.set('acme/app', [
      runner(7, h.runnerName(1, 1)),
      runner(8, ghost(8), { status: 'offline' }),
    ]);
    await runGithubSync(h.github, h.deps.store);
    h.clock.advance(61);
    await runGithubSync(h.github, h.deps.store);
    const settled = await counts();
    for (let round = 0; round < 3; round += 1) {
      h = await h.restart();
      h.clock.advance(61);
      await runGithubSync(h.github, h.deps.store);
      await runGithubSync(h.github, h.deps.store);
      expect(await counts()).toEqual(settled);
    }
  });

  test('seeded: whatever flips busy between passes, a busy runner is never sent a DELETE', async () => {
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    const rng = prng(2026);
    const ids = [11, 12, 13, 14, 15, 16];
    h.fake.runners.set(
      'acme/app',
      ids.map((id) => runner(id, ghost(id), { status: 'offline' }))
    );
    for (let round = 0; round < 40; round += 1) {
      const live = h.fake.runners.get('acme/app') ?? [];
      for (const r of live) r.busy = rng.chance(0.6);
      const busyNow = new Set(live.filter((r) => r.busy).map((r) => r.id));
      const before = h.fake.requests.length;
      h.clock.advance(61);
      await runGithubSync(h.github, h.deps.store);
      const deletes = h.fake.requests
        .slice(before)
        .filter((r) => r.method === 'DELETE' && r.path.includes('/runners/'));
      for (const request of deletes) {
        const id = Number(request.path.split('/').pop());
        expect([round, id, busyNow.has(id)]).toEqual([round, id, false]);
      }
      for (const id of busyNow) {
        expect(
          (h.fake.runners.get('acme/app') ?? []).some((r) => r.id === id)
        ).toBe(true);
      }
    }
    // The scenario was not vacuous: some idle orphans were in fact removed.
    expect((h.fake.runners.get('acme/app') ?? []).length).toBeLessThan(
      ids.length
    );
  });

  test('a GitHub outage during the sync degrades the integration, never deletes anything, and a later pass recovers', async () => {
    await h.configure({
      policy: { orphanAutoRemoval: true, orphanGraceSeconds: 60 },
    });
    h.fake.runners.set('acme/app', [
      runner(21, ghost(21), { status: 'offline' }),
    ]);
    await runGithubSync(h.github, h.deps.store);
    h.clock.advance(300);
    h.fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 503 });
    const failed = await runGithubSync(h.github, h.deps.store);
    expect(failed.status).toBe('degraded');
    expect(h.fake.runners.get('acme/app')).toHaveLength(1);
    h.fake.clearInjected();
    h.clock.advance(900);
    const healed = await runGithubSync(h.github, h.deps.store);
    expect(healed.status).toBe('ok');
    expect(h.fake.runners.get('acme/app')).toHaveLength(0);
  });
});
