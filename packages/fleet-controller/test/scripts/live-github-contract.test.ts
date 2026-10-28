import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyFailure,
  humanSummary,
  runContract,
  type ContractResult,
} from '../../scripts/live-github-contract';
import { GithubError } from '../../src/github/errors';
import type { FetchLike } from '../../src/github/transport';
import {
  startFakeGithub,
  type FakeGithub,
} from '../github/testing/fake-github';
import { Clock } from '../support/controller';

const SCRIPT = join(import.meta.dir, '../../scripts/live-github-contract.ts');
const CANARY = 'CANARY-registration-token-0123456789';

let fake: FakeGithub;
let clock: Clock;
let work: string;

beforeEach(async () => {
  clock = new Clock(new Date());
  fake = await startFakeGithub({ now: clock.now });
  work = mkdtempSync(join(tmpdir(), 'live-contract-'));
  fake.runners.set('acme/app', []);
  fake.runs.set('acme/app', []);
});
afterEach(() => {
  fake.stop();
  rmSync(work, { recursive: true, force: true });
});

const pem = () =>
  fake.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function env(over: Record<string, string | undefined> = {}) {
  return {
    FLEET_LIVE_GITHUB_APP_ID: fake.appId,
    FLEET_LIVE_GITHUB_INSTALLATION_ID: fake.installationId,
    FLEET_LIVE_GITHUB_APP_PRIVATE_KEY: pem(),
    FLEET_LIVE_GITHUB_TARGET: 'acme/app',
    FLEET_LIVE_GITHUB_SCOPE: 'repository',
    FLEET_LIVE_GITHUB_API_URL: fake.url,
    ...over,
  };
}

/** The real GitHub sends rate-limit headers on every answer; the loopback fake does not. */
function withRateLimit(remaining = 4800): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    const headers = new Headers(response.headers);
    headers.set('x-ratelimit-limit', '5000');
    headers.set('x-ratelimit-remaining', String(remaining));
    headers.set(
      'x-ratelimit-reset',
      String(Math.floor(Date.now() / 1000) + 3000)
    );
    headers.set('x-ratelimit-resource', 'core');
    return new Response(response.body, { status: response.status, headers });
  };
}

/** Strips the headers: what a misbehaving proxy in front of GitHub would do. */
const withoutRateLimit: FetchLike = async (input, init) => {
  const response = await fetch(input, init);
  const headers = new Headers(response.headers);
  for (const name of ['limit', 'remaining', 'used', 'reset', 'resource'])
    headers.delete(`x-ratelimit-${name}`);
  return new Response(response.body, { status: response.status, headers });
};

/** A loopback proxy in front of the fake that decides whether rate-limit headers are sent. */
function startProxy(send: boolean) {
  const forward = send ? withRateLimit() : withoutRateLimit;
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      return forward(`${fake.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
      });
    },
  });
}

function run(
  over: Record<string, string | undefined> = {},
  fetchImpl: FetchLike = withRateLimit()
): Promise<ContractResult> {
  return runContract({
    env: env(over),
    fetch: fetchImpl,
    now: () => new Date(),
    sleep: async () => undefined,
  });
}

const failureOf = (result: ContractResult) =>
  result.checks.find((check) => !check.ok);

describe('live GitHub contract: logic against the loopback fake', () => {
  test('happy path: every check passes, runners are paged, the budget is reported', async () => {
    fake.runners.set(
      'acme/app',
      Array.from({ length: 230 }, (_, i) => ({
        id: i + 1,
        name: `r-${i}`,
        status: 'online' as const,
        busy: false,
        labels: ['self-hosted'],
      }))
    );
    const result = await run();
    expect(result).toMatchObject({
      outcome: 'pass',
      exitCode: 0,
      scope: 'repository',
      targetHint: 'a***/a***',
      runnersTotal: 230,
      runnersListPages: 3,
      rateLimit: {
        limit: 5000,
        remaining: 4800,
        usedPercent: 4,
        resource: 'core',
      },
    });
    expect(result.checks.map((c) => c.name)).toEqual([
      'config',
      'app_jwt',
      'installation_token',
      'installation_reach',
      'runners_list',
      'registration_token',
      'rate_limit',
    ]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(
      fake.count('POST /repos/acme/app/actions/runners/registration-token')
    ).toBe(1);
  });

  test('an organization target works the same way', async () => {
    fake.runners.set('acme', []);
    const result = await run({
      FLEET_LIVE_GITHUB_SCOPE: 'organization',
      FLEET_LIVE_GITHUB_TARGET: 'acme',
    });
    expect(result).toMatchObject({ outcome: 'pass', scope: 'organization' });
    expect(
      fake.count('POST /orgs/acme/actions/runners/registration-token')
    ).toBe(1);
  });

  test('skips cleanly, exit 0, when none of the variables are set', async () => {
    const result = await runContract({
      env: {},
      fetch: withRateLimit(),
      now: () => new Date(),
    });
    expect(result).toMatchObject({
      outcome: 'skipped',
      exitCode: 0,
      checks: [],
    });
    expect(result.message).toContain('FLEET_LIVE_GITHUB_APP_ID');
    expect(fake.requests).toHaveLength(0);
  });

  test('empty strings (an unset secret) count as unset', async () => {
    const empty = Object.fromEntries(
      Object.keys(env()).map((key) => [key, ''])
    );
    expect((await run(empty)).outcome).toBe('skipped');
  });

  test('a partial configuration is a loud failure naming only variables, never values', async () => {
    const result = await run({
      FLEET_LIVE_GITHUB_APP_PRIVATE_KEY: undefined,
      FLEET_LIVE_GITHUB_TARGET: undefined,
    });
    expect(result).toMatchObject({ outcome: 'fail', exitCode: 1 });
    expect(failureOf(result)).toMatchObject({
      name: 'config',
      failure: 'invalid_config',
    });
    expect(result.message).toContain(
      'FLEET_LIVE_GITHUB_APP_PRIVATE_KEY is not set'
    );
    expect(result.message).toContain('FLEET_LIVE_GITHUB_TARGET is not set');
    expect(fake.requests).toHaveLength(0);
  });

  test('malformed values are named, the value is never echoed', async () => {
    const result = await run({
      FLEET_LIVE_GITHUB_APP_PRIVATE_KEY: CANARY,
      FLEET_LIVE_GITHUB_APP_ID: 'abc',
      FLEET_LIVE_GITHUB_TARGET: 'not a repo',
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain(
      'FLEET_LIVE_GITHUB_APP_PRIVATE_KEY is not an RSA PEM key'
    );
    expect(result.message).toContain(
      'FLEET_LIVE_GITHUB_APP_ID must be a number'
    );
    expect(result.message).toContain('owner/repo');
    expect(JSON.stringify(result) + humanSummary(result)).not.toContain(CANARY);
  });

  describe('each failure is classified and actionable', () => {
    test('a wrong App ID: the JWT is refused', async () => {
      const result = await run({ FLEET_LIVE_GITHUB_APP_ID: '999' });
      expect(failureOf(result)).toMatchObject({
        name: 'app_jwt',
        failure: 'bad_credential',
        code: 'FLEET_GITHUB_KEY',
        status: 401,
      });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('FLEET_LIVE_GITHUB_APP_ID');
    });

    test('a wrong installation ID', async () => {
      const result = await run({ FLEET_LIVE_GITHUB_INSTALLATION_ID: '1' });
      expect(failureOf(result)).toMatchObject({
        name: 'installation_token',
        failure: 'wrong_installation',
        code: 'FLEET_GITHUB_SCOPE',
      });
      expect(result.message).toContain('FLEET_LIVE_GITHUB_INSTALLATION_ID');
    });

    test('an installation that does not include the target repository', async () => {
      const result = await run({ FLEET_LIVE_GITHUB_TARGET: 'acme/other' });
      expect(failureOf(result)).toMatchObject({
        name: 'installation_reach',
        failure: 'target_unreachable',
      });
      expect(result.message).toContain('install the App');
    });

    test('a target that answers 404', async () => {
      fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 404 });
      const result = await run();
      expect(failureOf(result)).toMatchObject({
        name: 'runners_list',
        failure: 'target_unreachable',
        status: 404,
      });
    });

    test('missing repository Administration is told apart from every other failure', async () => {
      fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 403 });
      const result = await run();
      expect(failureOf(result)).toMatchObject({
        name: 'runners_list',
        failure: 'missing_runner_permission',
        code: 'FLEET_GITHUB_SCOPE',
        status: 403,
      });
      expect(result.message).toContain(
        "repository permission 'Administration'"
      );
      expect(result.exitCode).toBe(1);
    });

    test('missing organization Self-hosted runners names that permission instead', async () => {
      fake.runners.set('acme', []);
      fake.injectAlways('GET /orgs/acme/actions/runners', { status: 403 });
      const result = await run({
        FLEET_LIVE_GITHUB_SCOPE: 'organization',
        FLEET_LIVE_GITHUB_TARGET: 'acme',
      });
      expect(failureOf(result)?.failure).toBe('missing_runner_permission');
      expect(result.message).toContain(
        "organization permission 'Self-hosted runners'"
      );
    });

    test('read works but a registration token needs write', async () => {
      fake.injectAlways(
        'POST /repos/acme/app/actions/runners/registration-token',
        {
          status: 403,
        }
      );
      const result = await run();
      expect(failureOf(result)).toMatchObject({
        name: 'registration_token',
        failure: 'missing_runner_write_permission',
      });
      expect(result.checks.find((c) => c.name === 'runners_list')?.ok).toBe(
        true
      );
      expect(result.message).toContain('Read and write');
    });

    test('rate limiting and outages are temporary (exit 2), not a contract break', async () => {
      fake.injectAlways('GET /repos/acme/app/actions/runners', {
        status: 429,
        headers: { 'retry-after': '1' },
      });
      const limited = await run();
      // The client's circuit opens on a rate limit, so the second try reports the pause.
      expect(failureOf(limited)).toMatchObject({ failure: 'temporary' });
      expect(limited.message).toContain('rerun later');
      expect(limited.exitCode).toBe(2);
      fake.clearInjected();
      fake.injectAlways('GET /repos/acme/app/actions/runners', { status: 503 });
      const down = await run();
      expect(down).toMatchObject({ exitCode: 2 });
      expect(failureOf(down)).toMatchObject({
        failure: 'temporary',
        code: 'FLEET_GITHUB_UNAVAILABLE',
      });
    });

    test('a registration token that has already expired, or has a strange shape, fails', async () => {
      const post = 'POST /repos/acme/app/actions/runners/registration-token';
      fake.injectAlways(post, {
        status: 201,
        body: {
          token: 'ABCDEFGH12345678',
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      });
      expect(failureOf(await run())).toMatchObject({
        name: 'registration_token',
        failure: 'bad_token',
      });
      fake.injectAlways(post, {
        status: 201,
        body: {
          token: 'has spaces',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      });
      expect(failureOf(await run())?.failure).toBe('bad_token');
      fake.injectAlways(post, {
        status: 201,
        body: { token: 'ABCDEFGH12345678' },
      });
      expect(failureOf(await run())?.failure).toBe('bad_token');
    });

    test('missing rate-limit headers fail the contract', async () => {
      const result = await run({}, withoutRateLimit);
      expect(failureOf(result)).toMatchObject({
        name: 'rate_limit',
        failure: 'missing_rate_limit_headers',
      });
    });

    test('a low budget is reported but is not a failure', async () => {
      const result = await run({}, withRateLimit(12));
      expect(result.outcome).toBe('pass');
      expect(result.checks.at(-1)?.message).toContain('low');
    });

    test('an unclassified error is reported by name only', () => {
      const failure = classifyFailure(
        'runners_list',
        new TypeError(`boom ${CANARY}`),
        { scope: 'repository', name: 'acme/app' }
      );
      expect(failure).toMatchObject({ failure: 'unexpected' });
      expect(failure.message).toContain('TypeError');
      expect(failure.message).not.toContain(CANARY);
    });

    test('classification follows the client code and status, not text', () => {
      const target = { scope: 'repository', name: 'acme/app' } as const;
      const refused = new GithubError('FLEET_GITHUB_SCOPE', 'anything', {
        temporary: false,
        status: 403,
      });
      expect(classifyFailure('runners_list', refused, target).failure).toBe(
        'missing_runner_permission'
      );
      const key = new GithubError('FLEET_GITHUB_KEY', 'anything', {
        temporary: false,
        status: 401,
      });
      expect(classifyFailure('installation_token', key, target).failure).toBe(
        'bad_credential'
      );
    });
  });

  test('no secret appears in the summary or the JSON: private key, tokens, full target', async () => {
    fake.injectAlways(
      'POST /repos/acme/app/actions/runners/registration-token',
      {
        status: 201,
        body: {
          token: CANARY,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }
    );
    const result = await run();
    expect(result.outcome).toBe('pass');
    const output = JSON.stringify(result) + humanSummary(result);
    const keyBody = pem()
      .split('\n')
      .filter((l) => !l.startsWith('-----') && l !== '');
    for (const forbidden of [
      CANARY,
      'ghs_installation_',
      'REGTOKEN',
      'acme/app',
      ...keyBody.slice(0, 3),
      'BEGIN PRIVATE KEY',
    ])
      expect(output).not.toContain(forbidden);
  });
});

describe('live GitHub contract: the script as a process', () => {
  async function spawn(
    vars: Record<string, string | undefined>,
    args: string[] = []
  ) {
    const base: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
    for (const [key, value] of Object.entries(vars))
      if (value !== undefined) base[key] = value;
    const child = Bun.spawn(['bun', SCRIPT, ...args], {
      env: base,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  test('without the variables it prints a notice and exits 0', async () => {
    const done = await spawn({});
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('SKIPPED');
    const actions = await spawn({ GITHUB_ACTIONS: 'true' });
    expect(actions.stdout).toContain(
      '::notice title=Live GitHub contract skipped::'
    );
  });

  test('a passing run: --json prints only the result, the files are redacted, no secret leaks', async () => {
    fake.injectAlways(
      'POST /repos/acme/app/actions/runners/registration-token',
      {
        status: 201,
        body: {
          token: CANARY,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }
    );
    const proxy = startProxy(true);
    try {
      const file = join(work, 'result.json');
      const summary = join(work, 'summary.md');
      const done = await spawn(
        {
          ...env({
            FLEET_LIVE_GITHUB_API_URL: `http://127.0.0.1:${proxy.port}`,
          }),
          GITHUB_ACTIONS: 'true',
          GITHUB_STEP_SUMMARY: summary,
        },
        ['--json', '--result-file', file]
      );
      expect(done.code).toBe(0);
      const json = done.stdout.split('\n').filter((l) => l.startsWith('{'));
      expect(json).toHaveLength(1);
      expect(JSON.parse(json[0] ?? '{}')).toMatchObject({
        schema: 1,
        outcome: 'pass',
        exitCode: 0,
      });
      const everything = [
        done.stdout,
        done.stderr,
        readFileSync(file, 'utf8'),
        readFileSync(summary, 'utf8'),
      ].join('\n');
      for (const forbidden of [
        CANARY,
        'ghs_installation_',
        'BEGIN PRIVATE KEY',
        'acme/app',
      ])
        expect(everything).not.toContain(forbidden);
      expect(readFileSync(summary, 'utf8')).toContain('| rate_limit | pass |');
      expect(JSON.parse(readFileSync(file, 'utf8')).checks).toHaveLength(7);
    } finally {
      await proxy.stop(true);
    }
  });

  test('missing rate-limit headers: exit 1 and an error annotation', async () => {
    const proxy = startProxy(false);
    try {
      const done = await spawn({
        ...env({ FLEET_LIVE_GITHUB_API_URL: `http://127.0.0.1:${proxy.port}` }),
        GITHUB_ACTIONS: 'true',
      });
      expect(done.code).toBe(1);
      expect(done.stdout).toContain(
        '::error title=Live GitHub contract failed::'
      );
      expect(done.stdout).toContain('rate_limit');
    } finally {
      await proxy.stop(true);
    }
  });

  test('a broken configuration exits 1 with the variable named', async () => {
    const done = await spawn({ FLEET_LIVE_GITHUB_APP_ID: '1' });
    expect(done.code).toBe(1);
    expect(done.stdout).toContain(
      'FLEET_LIVE_GITHUB_INSTALLATION_ID is not set'
    );
  });
});
