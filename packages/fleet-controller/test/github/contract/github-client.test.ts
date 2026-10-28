import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';

import { GithubClient } from '../../../src/github/client';
import { GithubError } from '../../../src/github/errors';
import { Clock } from '../../support/controller';
import { T0 } from '../../support/fixtures';
import {
  startFakeGithub,
  type FakeGithub,
  type FakeRunner,
} from '../testing/fake-github';

import {
  allProblems,
  coverageKey,
  recordingFetch,
  type Exchange,
} from './recorder';
import { EXERCISED } from './selection';

const REPO = { scope: 'repository', name: 'acme/app' } as const;
const ORG = { scope: 'organization', name: 'acme' } as const;
const DOCS = 'https://docs.github.com/rest';

let fake: FakeGithub;
const clock = new Clock();
let exchanges: Exchange[] = [];
const covered = new Set<string>();

beforeAll(async () => {
  fake = await startFakeGithub({ now: clock.now });
});
afterAll(() => fake.stop());
beforeEach(() => {
  clock.set(T0);
  fake.clearInjected();
  fake.runners.clear();
  fake.runs.clear();
  fake.jobs.clear();
  fake.revokeInstallationTokens();
});

/** The controller's real client, sending through a recorder to the loopback fake. */
function client(attempts = 1): GithubClient {
  const rec = recordingFetch();
  exchanges = rec.exchanges;
  return new GithubClient({
    apiUrl: fake.url,
    appId: fake.appId,
    installationId: fake.installationId,
    key: fake.privateKey,
    fetch: rec.fetch,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms / 1000),
    random: () => 0,
    retry: {
      maxAttempts: attempts,
      baseMs: 10,
      maxMs: 100,
      maxInlineWaitMs: 100,
      timeoutMs: 5000,
    },
  });
}

/** Fails with every way the exchanges depart from GitHub's contract; remembers what was exercised. */
function conforms(): void {
  expect(exchanges.length).toBeGreaterThan(0);
  expect(allProblems(exchanges)).toEqual([]);
  for (const exchange of exchanges) covered.add(coverageKey(exchange));
}

async function refusal(run: () => Promise<unknown>): Promise<GithubError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GithubError) return error;
    throw error;
  }
  throw new Error('expected GithubError');
}

function runner(id: number, over: Partial<FakeRunner> = {}): FakeRunner {
  return {
    id,
    name: `ci-${id}`,
    status: 'online',
    busy: false,
    labels: ['self-hosted', 'linux', 'x64', 'ci'],
    ...over,
  };
}

describe('GitHub client against the published contract: success paths', () => {
  test('App endpoints: GET /app, GET /app/installations, POST access_tokens', async () => {
    const gh = client();
    expect(await gh.getApp()).toEqual({ slug: 'fleet-test' });
    expect(await gh.listInstallations()).toEqual([
      { id: 777, account: 'acme' },
    ]);
    await gh.checkInstallation();
    conforms();
    expect(exchanges.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /app',
      'GET /app/installations',
      'POST /app/installations/777/access_tokens',
    ]);
  });

  test('runner lists are paginated with per_page/page and every page conforms', async () => {
    fake.runners.set(
      'acme/app',
      Array.from({ length: 230 }, (_, i) => runner(i + 1))
    );
    fake.runners.set('acme', [
      runner(900),
      runner(901, { status: 'offline', busy: true }),
    ]);
    const gh = client();
    expect(await gh.listRunners(REPO)).toHaveLength(230);
    expect(await gh.listRunners(ORG)).toHaveLength(2);
    conforms();
    const pages = exchanges.filter(
      (e) => e.path === '/repos/acme/app/actions/runners'
    );
    expect(pages.map((e) => e.query.get('page'))).toEqual(['1', '2', '3']);
    expect(new Set(pages.map((e) => e.query.get('per_page')))).toEqual(
      new Set(['100'])
    );
  });

  test('installation repositories are paginated and every page conforms', async () => {
    for (let i = 0; i < 130; i += 1) fake.runs.set(`acme/repo-${i}`, []);
    const gh = client();
    expect(await gh.listInstallationRepositories()).toHaveLength(130);
    conforms();
    expect(
      exchanges.filter((e) => e.path === '/installation/repositories')
    ).toHaveLength(2);
  });

  test('workflow runs per status and the jobs of a run', async () => {
    const at = clock.now().toISOString();
    fake.runs.set('acme/app', [
      { id: 100, status: 'queued', updated_at: at },
      { id: 101, status: 'in_progress', updated_at: at },
      { id: 102, status: 'completed', updated_at: at },
    ]);
    const job = {
      run_id: 101,
      labels: ['self-hosted', 'ci'],
      html_url: 'https://github.com/acme/app/actions/runs/101/job/1',
      created_at: at,
      conclusion: null,
      runner_id: null,
      runner_name: null,
      completed_at: null,
    };
    fake.jobs.set(101, [
      { ...job, id: 1, name: 'queued job', status: 'queued', started_at: null },
      {
        ...job,
        id: 2,
        name: 'running',
        status: 'in_progress',
        started_at: at,
        runner_id: 7,
        runner_name: 'ci-7',
      },
      {
        ...job,
        id: 3,
        name: 'done',
        status: 'completed',
        conclusion: 'failure',
        started_at: at,
        completed_at: at,
        runner_id: 7,
        runner_name: 'ci-7',
      },
    ]);
    const gh = client();
    for (const status of ['queued', 'in_progress', 'completed'] as const)
      expect(await gh.listRuns('acme/app', status, 50)).toHaveLength(1);
    expect(await gh.listRunJobs('acme/app', 101)).toHaveLength(3);
    conforms();
  });

  test('registration tokens for a repository and an organization', async () => {
    const gh = client();
    const repo = await gh.createRegistrationToken(REPO);
    const org = await gh.createRegistrationToken(ORG);
    expect(repo.expiresAt).not.toBeNull();
    expect(org.token).toStartWith('REGTOKEN-');
    conforms();
    const answers = exchanges.filter((e) =>
      e.path.endsWith('/registration-token')
    );
    expect(answers.map((e) => e.status)).toEqual([201, 201]);
    expect(Object.keys(answers[0]?.responseBody as object).sort()).toEqual([
      'expires_at',
      'token',
    ]);
  });

  test('deleting runners and removing labels, for both targets', async () => {
    fake.runners.set('acme/app', [runner(1), runner(2, { busy: true })]);
    fake.runners.set('acme', [runner(3), runner(4)]);
    const gh = client();
    expect(await gh.deleteRunner(REPO, 1)).toBe(true);
    expect(await gh.deleteRunner(ORG, 3)).toBe(true);
    expect(await gh.removeCustomLabels(REPO, 2, ['ci', 'self-hosted'])).toBe(1);
    expect(await gh.removeCustomLabels(ORG, 4, ['ci'])).toBe(1);
    conforms();
    const labelCalls = exchanges.filter((e) => e.path.includes('/labels/'));
    expect(labelCalls.map((e) => e.status)).toEqual([200, 200]);
  });

  test('a label with characters that need escaping is a single path segment', async () => {
    fake.runners.set('acme/app', [
      runner(5, { labels: ['self-hosted', 'team/gpu 1'] }),
    ]);
    const gh = client();
    expect(await gh.removeCustomLabels(REPO, 5, ['team/gpu 1'])).toBe(1);
    conforms();
    expect(exchanges.at(-1)?.path).toBe(
      '/repos/acme/app/actions/runners/5/labels/team%2Fgpu%201'
    );
  });
});

/** What GitHub documents for each failure; the injected answers use exactly these shapes. */
const rateLimit = (reset: number) => ({
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '0',
  'x-ratelimit-used': '5000',
  'x-ratelimit-resource': 'core',
  'x-ratelimit-reset': String(reset),
});

describe('GitHub client against the published contract: error answers', () => {
  test('401 and 404 on minting an installation token are documented and classified', async () => {
    const gh = client();
    fake.inject('POST /app/installations/777/access_tokens', {
      status: 401,
      body: {
        message: 'A JSON web token could not be decoded',
        documentation_url: `${DOCS}/apps/apps`,
      },
    });
    const bad = await refusal(() => gh.checkInstallation());
    expect(bad).toMatchObject({
      code: 'FLEET_GITHUB_KEY',
      status: 401,
      temporary: false,
    });
    fake.inject('POST /app/installations/777/access_tokens', {
      status: 404,
      body: { message: 'Not Found', documentation_url: DOCS },
    });
    const gone = await refusal(() => client().checkInstallation());
    expect(gone).toMatchObject({ code: 'FLEET_GITHUB_SCOPE', status: 404 });
    conforms();
  });

  test('422 validation-error with its errors array', async () => {
    fake.inject('POST /app/installations/777/access_tokens', {
      status: 422,
      body: {
        message: 'Validation Failed',
        documentation_url: DOCS,
        errors: [
          {
            resource: 'Installation',
            field: 'repository_ids',
            code: 'invalid',
            message: 'bad id',
          },
        ],
      },
    });
    const error = await refusal(() => client().checkInstallation());
    expect(error).toMatchObject({ status: 422, temporary: false });
    conforms();
  });

  test('403 and 404 on runner endpoints are documented', async () => {
    fake.inject('POST /repos/acme/app/actions/runners/registration-token', {
      status: 403,
      body: {
        message: 'Resource not accessible by integration',
        documentation_url: DOCS,
      },
    });
    expect(
      await refusal(() => client().createRegistrationToken(REPO))
    ).toMatchObject({
      code: 'FLEET_GITHUB_SCOPE',
      status: 403,
    });
    fake.inject('GET /orgs/acme/actions/runners', {
      status: 404,
      body: { message: 'Not Found', documentation_url: DOCS },
    });
    expect(await refusal(() => client().listRunners(ORG))).toMatchObject({
      status: 404,
    });
    conforms();
  });

  test('422 when deleting a busy runner, 404 for a runner that is gone', async () => {
    fake.runners.set('acme/app', [runner(1, { busy: true })]);
    const busy = await refusal(() => client().deleteRunner(REPO, 1));
    expect(busy).toMatchObject({ status: 422 });
    conforms();
    const gh = client();
    expect(await gh.deleteRunner(REPO, 99)).toBe(false);
    conforms();
    expect(exchanges.map((e) => e.status)).toEqual([201, 404]);
  });

  test('primary rate limit: 403 with x-ratelimit-remaining 0 and a reset time', async () => {
    const reset = Math.floor(clock.now().getTime() / 1000) + 120;
    fake.inject('GET /repos/acme/app/actions/runners', {
      status: 403,
      headers: rateLimit(reset),
      body: {
        message: 'API rate limit exceeded for installation ID 777.',
        documentation_url: `${DOCS}/overview/rate-limits-for-the-rest-api`,
      },
    });
    const error = await refusal(() => client().listRunners(REPO));
    expect(error).toMatchObject({
      code: 'FLEET_GITHUB_RATE_LIMITED',
      temporary: true,
      status: 403,
    });
    expect(error.retryAfterMs).toBeGreaterThan(100_000);
    conforms();
  });

  test('secondary rate limit: 403 with Retry-After in seconds', async () => {
    fake.inject('POST /repos/acme/app/actions/runners/registration-token', {
      status: 403,
      headers: { 'retry-after': '60' },
      body: {
        message:
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        documentation_url: `${DOCS}/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits`,
      },
    });
    const error = await refusal(() => client().createRegistrationToken(REPO));
    expect(error).toMatchObject({
      code: 'FLEET_GITHUB_RATE_LIMITED',
      retryAfterMs: 60_000,
    });
    conforms();
  });

  test('429 and 5xx answers are temporary and carry the generic error body', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      fake.inject('GET /repos/acme/app/actions/runs', {
        status,
        headers: status === 429 ? { 'retry-after': '30' } : {},
        body: {
          message: status === 429 ? 'Too Many Requests' : 'Server Error',
          documentation_url: DOCS,
        },
      });
      const error = await refusal(() =>
        client().listRuns('acme/app', 'queued', 10)
      );
      expect(error).toMatchObject({ temporary: true, status });
      conforms();
    }
  });

  test('a 5xx is retried with the same, conforming, request', async () => {
    fake.runners.set('acme/app', [runner(1)]);
    fake.inject('GET /repos/acme/app/actions/runners', { status: 502 });
    const gh = client(3);
    expect(await gh.listRunners(REPO)).toHaveLength(1);
    conforms();
    const lists = exchanges.filter((e) => e.path.endsWith('/actions/runners'));
    expect(lists.map((e) => e.status)).toEqual([502, 200]);
    expect(lists[0]?.query.toString()).toBe(lists[1]?.query.toString());
  });

  test('an expired installation token (401 on a runner call) is replaced and the call repeated', async () => {
    fake.runners.set('acme/app', [runner(1)]);
    const gh = client();
    await gh.listRunners(REPO);
    fake.revokeInstallationTokens();
    await gh.listRunners(REPO);
    conforms();
    expect(exchanges.map((e) => e.status)).toEqual([201, 200, 401, 201, 200]);
  });
});

describe('contract coverage of the GitHub client', () => {
  test('every runner, token, run, job and App operation was exercised with a success answer', () => {
    expect(EXERCISED.githubClient.filter((key) => !covered.has(key))).toEqual(
      []
    );
  });
});
