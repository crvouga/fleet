import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import { GithubClient } from '../../src/github/client';
import { GithubError } from '../../src/github/errors';
import { Clock } from '../support/controller';
import { T0 } from '../support/fixtures';

import { startFakeGithub, type FakeGithub } from './testing/fake-github';

const TARGET = { scope: 'repository', name: 'acme/app' } as const;

describe('GithubClient', () => {
  let fake: FakeGithub;
  const clock = new Clock();
  const sleeps: number[] = [];

  beforeAll(async () => {
    fake = await startFakeGithub({ now: clock.now });
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    clock.set(T0);
    fake.clearInjected();
    fake.requests.length = 0;
    fake.runners.clear();
    sleeps.length = 0;
    fake.revokeInstallationTokens();
  });

  function client(overrides: { appId?: string; installationId?: string } = {}) {
    return new GithubClient({
      apiUrl: fake.url,
      appId: overrides.appId ?? fake.appId,
      installationId: overrides.installationId ?? fake.installationId,
      key: fake.privateKey,
      fetch,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms / 1000);
      },
      random: () => 0,
      retry: {
        maxAttempts: 3,
        baseMs: 100,
        maxMs: 1000,
        maxInlineWaitMs: 5000,
        timeoutMs: 5000,
      },
    });
  }

  async function failure(run: () => Promise<unknown>): Promise<GithubError> {
    try {
      await run();
    } catch (error) {
      if (error instanceof GithubError) return error;
      throw error;
    }
    throw new Error('expected a GithubError');
  }

  test('signs an RS256 App JWT that GitHub (the fake) verifies, and caches the installation token', async () => {
    fake.runners.set('acme/app', []);
    const gh = client();
    await gh.listRunners(TARGET);
    await gh.listRunners(TARGET);
    await gh.listRunners(TARGET);
    expect(fake.count('POST /app/installations/777/access_tokens')).toBe(1);
    expect(fake.count('GET /repos/acme/app/actions/runners')).toBe(3);
  });

  test('refreshes the installation token before it expires', async () => {
    fake.runners.set('acme/app', []);
    const gh = client();
    await gh.listRunners(TARGET);
    clock.advance(3600 - 60);
    await gh.listRunners(TARGET);
    expect(fake.count('POST /app/installations/777/access_tokens')).toBe(2);
    clock.advance(-(3600 - 60));
  });

  test('concurrent calls share one token mint', async () => {
    fake.runners.set('acme/app', []);
    const gh = client();
    await Promise.all([1, 2, 3, 4, 5].map(() => gh.listRunners(TARGET)));
    expect(fake.count('POST /app/installations/777/access_tokens')).toBe(1);
  });

  test('pages through every runner', async () => {
    fake.runners.set(
      'acme/app',
      Array.from({ length: 230 }, (_, i) => ({
        id: i + 1,
        name: `r${i}`,
        status: 'online' as const,
        busy: false,
        labels: [],
      }))
    );
    expect(await client().listRunners(TARGET)).toHaveLength(230);
  });

  test('retries a 5xx with bounded exponential backoff and jitter', async () => {
    fake.runners.set('acme/app', []);
    fake.inject(
      'GET /repos/acme/app/actions/runners',
      { status: 502 },
      { status: 503 }
    );
    await client().listRunners(TARGET);
    expect(sleeps).toEqual([50, 100]);
  });

  test('gives up after the attempt limit with a public, temporary error', async () => {
    fake.injectAlways('GET /repos/acme/app/actions/runners', {
      status: 500,
      body: { message: 'secret-body-text' },
    });
    const error = await failure(() => client().listRunners(TARGET));
    expect(error.temporary).toBe(true);
    expect(error.code).toBe('FLEET_GITHUB_UNAVAILABLE');
    expect(error.message).not.toContain('secret-body-text');
    expect(fake.count('GET /repos/acme/app/actions/runners')).toBe(3);
  });

  test('429 with a short Retry-After is waited out', async () => {
    fake.runners.set('acme/app', []);
    fake.inject('GET /repos/acme/app/actions/runners', {
      status: 429,
      headers: { 'retry-after': '3' },
    });
    await client().listRunners(TARGET);
    expect(sleeps).toEqual([3000]);
  });

  test('a long rate limit is not slept: the caller backs off and the circuit opens', async () => {
    fake.injectAlways('GET /repos/acme/app/actions/runners', {
      status: 429,
      headers: { 'retry-after': '120' },
    });
    const gh = client();
    const error = await failure(() => gh.listRunners(TARGET));
    expect(error.code).toBe('FLEET_GITHUB_RATE_LIMITED');
    expect(error.retryAfterMs).toBe(120_000);
    expect(sleeps).toEqual([]);
    const calls = fake.count('GET /repos/acme/app/actions/runners');
    const again = await failure(() => gh.listRunners(TARGET));
    expect(again.temporary).toBe(true);
    expect(fake.count('GET /repos/acme/app/actions/runners')).toBe(calls);
    expect(gh.circuit().state).toBe('open');
    clock.advance(121);
    expect(gh.circuit().state).not.toBe('open');
    clock.advance(-121);
  });

  test('a primary rate limit uses the reset time', async () => {
    const reset = Math.floor(clock.now().getTime() / 1000) + 90;
    fake.injectAlways('GET /repos/acme/app/actions/runners', {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      },
    });
    const error = await failure(() => client().listRunners(TARGET));
    expect(error.code).toBe('FLEET_GITHUB_RATE_LIMITED');
    expect(error.retryAfterMs).toBe(90_000);
  });

  test('a secondary rate limit (403 with a message and no headers) is temporary', async () => {
    fake.injectAlways('GET /repos/acme/app/actions/runners', {
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
    });
    const error = await failure(() => client().listRunners(TARGET));
    expect(error.temporary).toBe(true);
    expect(error.code).toBe('FLEET_GITHUB_RATE_LIMITED');
  });

  test('a wrong private key or App ID is a permanent key failure, not retried', async () => {
    const error = await failure(() =>
      client({ appId: '999' }).listRunners(TARGET)
    );
    expect(error).toMatchObject({
      code: 'FLEET_GITHUB_KEY',
      temporary: false,
      status: 401,
    });
    expect(error.message).toContain('App ID or private key is wrong');
    expect(fake.count('POST /app/installations')).toBe(1);
  });

  test('an unknown installation is a permanent scope failure naming the installation', async () => {
    const error = await failure(() =>
      client({ installationId: '1' }).listRunners(TARGET)
    );
    expect(error).toMatchObject({
      code: 'FLEET_GITHUB_SCOPE',
      temporary: false,
    });
    expect(error.message).toContain('installation ID is wrong');
  });

  test('403 without rate-limit signs is a missing permission; 404 is a scope problem', async () => {
    fake.inject('GET /repos/acme/app/actions/runners', { status: 403 });
    const denied = await failure(() => client().listRunners(TARGET));
    expect(denied).toMatchObject({
      code: 'FLEET_GITHUB_SCOPE',
      temporary: false,
    });
    expect(denied.message).toContain('Administration');
    fake.inject('GET /repos/acme/app/actions/runners', { status: 404 });
    const missing = await failure(() => client().listRunners(TARGET));
    expect(missing.message).toContain('cannot reach this repository');
    expect(fake.count('GET /repos/acme/app/actions/runners')).toBe(2);
  });

  test('a token that expires mid-sync is replaced once and the call succeeds', async () => {
    fake.runners.set('acme/app', []);
    const gh = client();
    await gh.listRunners(TARGET);
    fake.revokeInstallationTokens();
    await gh.listRunners(TARGET);
    expect(fake.count('POST /app/installations/777/access_tokens')).toBe(2);
  });

  test('a token that keeps being refused fails with the key code instead of looping', async () => {
    fake.runners.set('acme/app', []);
    fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 401 });
    const error = await failure(() => client().listRunners(TARGET));
    expect(error.code).toBe('FLEET_GITHUB_KEY');
    expect(fake.count('GET /repos/acme/app/actions/runners')).toBe(2);
  });

  test('a network failure is temporary and never quotes the cause', async () => {
    const gh = new GithubClient({
      apiUrl: 'http://127.0.0.1:1',
      appId: fake.appId,
      installationId: fake.installationId,
      key: fake.privateKey,
      fetch,
      now: clock.now,
      sleep: async () => undefined,
      random: () => 0,
      retry: {
        maxAttempts: 2,
        baseMs: 1,
        maxMs: 2,
        maxInlineWaitMs: 5,
        timeoutMs: 1000,
      },
    });
    const error = await failure(() => gh.listRunners(TARGET));
    expect(error).toMatchObject({
      code: 'FLEET_GITHUB_UNAVAILABLE',
      temporary: true,
    });
    expect(error.message).not.toContain('127.0.0.1');
  });

  test('registration tokens, deletes and label removal use the installation token', async () => {
    fake.runners.set('acme/app', [
      {
        id: 9,
        name: 'r',
        status: 'online',
        busy: false,
        labels: ['self-hosted', 'ci', 'gpu'],
      },
    ]);
    const gh = client();
    const made = await gh.createRegistrationToken(TARGET);
    expect(made.token).toStartWith('REGTOKEN-');
    expect(
      await gh.removeCustomLabels(TARGET, 9, ['self-hosted', 'ci', 'gpu'])
    ).toBe(2);
    expect(await gh.deleteRunner(TARGET, 9)).toBe(true);
    expect(await gh.deleteRunner(TARGET, 9)).toBe(false);
  });
});
