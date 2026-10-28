import { createLogger } from '@pkgs/logger';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  commentOn,
  createIssue,
  findByFingerprint,
  issueState,
  type Client,
} from '../../../src/issues/github-issues';
import { markerFor } from '../../../src/issues/fingerprint';
import { DEFAULT_TUNING } from '../../../src/issues/runtime';
import { runIssueSyncJob } from '../../../src/jobs/issue-sync';
import { errorBody, FakeIssuesApi, status } from '../../issues/fake-issues-api';
import { seedEvents } from '../../issues/seed';
import {
  IDS,
  issueHarness,
  request,
  type IssueHarness,
} from '../../issues/support';

import {
  allProblems,
  coverageKey,
  recordingFetch,
  type Exchange,
} from './recorder';
import { EXERCISED } from './selection';

const covered = new Set<string>();
const apis: FakeIssuesApi[] = [];
afterEach(() => {
  for (const api of apis.splice(0)) api.stop();
});

function conforms(exchanges: readonly Exchange[]): void {
  expect(exchanges.length).toBeGreaterThan(0);
  expect(allProblems(exchanges)).toEqual([]);
  for (const exchange of exchanges) covered.add(coverageKey(exchange));
}

/** The issue-reporting client of the controller, sending through a recorder to the loopback fake. */
async function direct() {
  const api = new FakeIssuesApi();
  await api.start();
  apis.push(api);
  const now = new Date('2026-10-14T12:00:00Z');
  api.clock = () => now.toISOString();
  const rec = recordingFetch();
  const client: Client = {
    config: {
      token: api.token,
      repository: api.repository,
      labels: ['fleet-report'],
      apiUrl: api.url,
    },
    fetch: rec.fetch,
    tuning: { ...DEFAULT_TUNING, timeoutMs: 2000 },
    now: () => now,
  };
  return { api, client, now, exchanges: rec.exchanges };
}

describe('issue client against the published contract: direct calls', () => {
  test('create, comment, read state, and look up by fingerprint', async () => {
    const { client, now, exchanges } = await direct();
    const made = await createIssue(client, {
      title: 'node down',
      body: 'details <!-- fleet-issue-fingerprint:abc -->',
    });
    expect(made).toMatchObject({ ok: true, created: { number: 1 } });
    expect(await commentOn(client, 1, 'seen again')).toEqual({
      ok: true,
      done: true,
    });
    expect(await issueState(client, 1)).toEqual({ ok: true, state: 'open' });
    expect(await findByFingerprint(client, 'nothing-here', now)).toEqual({
      ok: true,
      found: null,
    });
    conforms(exchanges);
    expect(exchanges.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual([
      'POST /repos/acme/fleet-reports/issues 201',
      'POST /repos/acme/fleet-reports/issues/1/comments 201',
      'GET /repos/acme/fleet-reports/issues/1 200',
      'GET /repos/acme/fleet-reports/issues 200',
    ]);
    expect(exchanges[0]?.requestBody).toEqual({
      title: 'node down',
      body: 'details <!-- fleet-issue-fingerprint:abc -->',
      labels: ['fleet-report'],
    });
  });

  test('looking for a fingerprint pages through the open issues (per_page, page, since, state, sort, direction)', async () => {
    const { api, client, now, exchanges } = await direct();
    for (let i = 1; i <= 130; i += 1)
      api.issues.push({
        number: i,
        title: `t${i}`,
        body: 'no marker',
        state: 'open',
        labels: [],
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        html_url: `https://github.com/acme/fleet-reports/issues/${i}`,
      });
    expect(await findByFingerprint(client, 'absent', now)).toEqual({
      ok: true,
      found: null,
    });
    conforms(exchanges);
    const pages = exchanges.filter((e) => e.method === 'GET');
    expect(pages.map((e) => e.query.get('page'))).toEqual(['1', '2']);
    expect(pages[0]?.query.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('a pull request in the issue list is documented and never taken for a report', async () => {
    const { api, client, now, exchanges } = await direct();
    const body = `report ${markerFor('f'.repeat(32))}`;
    await createIssue(client, { title: 'a', body });
    expect(await findByFingerprint(client, 'f'.repeat(32), now)).toMatchObject({
      found: { number: 1 },
    });
    const url = 'https://api.github.com/repos/acme/fleet-reports/pulls/1';
    api.issues[0]!.pull_request = {
      url,
      html_url: 'https://github.com/acme/fleet-reports/pull/1',
      diff_url: `${url}.diff`,
      patch_url: `${url}.patch`,
      merged_at: null,
    };
    expect(await findByFingerprint(client, 'f'.repeat(32), now)).toEqual({
      ok: true,
      found: null,
    });
    conforms(exchanges);
  });

  test('documented error answers: 401, 403, 404, 410, 422, 429, 503, and an issue that is gone', async () => {
    const { api, client, exchanges } = await direct();
    const cases: [number, Record<string, string>, boolean][] = [
      [401, {}, false],
      [403, {}, false],
      [404, {}, false],
      [410, {}, false],
      [422, {}, false],
      [429, { 'retry-after': '60' }, true],
      [503, {}, true],
    ];
    for (const [code, headers, temporary] of cases) {
      api.inject({
        match: /POST .*\/issues$/,
        times: 1,
        respond: () =>
          new Response(
            JSON.stringify(
              code === 422
                ? {
                    ...errorBody('Validation Failed'),
                    errors: [
                      { resource: 'Issue', field: 'labels', code: 'invalid' },
                    ],
                  }
                : errorBody('error')
            ),
            {
              status: code,
              headers: { 'content-type': 'application/json', ...headers },
            }
          ),
      });
      const result = await createIssue(client, { title: 't', body: 'b' });
      expect(result).toMatchObject({ ok: false, status: code, temporary });
    }
    api.inject({
      match: /GET .*\/issues\/9$/,
      times: 1,
      respond: status(410, 'Gone'),
    });
    expect(await issueState(client, 9)).toEqual({ ok: true, state: null });
    expect(await issueState(client, 8)).toEqual({ ok: true, state: null });
    conforms(exchanges);
  });

  test('a bad token is refused with 401, as GitHub does', async () => {
    const { api, client, exchanges } = await direct();
    api.token = 'a-different-token-0123456789';
    expect(await createIssue(client, { title: 't', body: 'b' })).toMatchObject({
      ok: false,
      status: 401,
      temporary: false,
    });
    conforms(exchanges);
  });
});

describe('issue reporting end to end against the published contract', () => {
  let current: IssueHarness | null = null;
  afterEach(() => current?.api.stop());

  async function harness(
    rec: ReturnType<typeof recordingFetch>
  ): Promise<IssueHarness> {
    current = await issueHarness({ fetch: rec.fetch });
    await seedEvents(current);
    return current;
  }

  async function file(
    h: IssueHarness,
    node = IDS.rolledBack
  ): Promise<{ status: number; id: string }> {
    const preview = await request(h, 'POST', '/v1/issues/preview', {
      json: { kind: 'node', node },
    });
    const draft = (await preview.json()) as { id: string };
    const sent = await request(h, 'POST', '/v1/issues', {
      json: { draftId: draft.id },
    });
    return { status: sent.status, id: draft.id };
  }

  test('file, recur (comment), close and refile, and recover from a lost answer', async () => {
    const rec = recordingFetch();
    const h = await harness(rec);
    expect((await file(h)).status).toBe(201);
    expect((await file(h)).status).toBe(200);
    h.api.issues[0]!.state = 'closed';
    expect((await file(h)).status).toBe(201);
    h.api.inject({
      match: /POST .*\/issues$/,
      times: 1,
      afterEffect: true,
      respond: status(502, 'Bad Gateway'),
    });
    expect((await file(h, IDS.online)).status).toBe(202);
    h.advance(5_000);
    await runIssueSyncJob({
      store: h.deps.store,
      now: h.now,
      fetch: rec.fetch,
      log: createLogger({ name: 'test', level: 'silent' }),
      issues: h.deps.issues,
    });
    conforms(rec.exchanges);
    const calls = rec.exchanges.map((e) => `${e.method} ${e.status}`);
    expect(calls).toContain('POST 201');
    expect(calls).toContain('POST 502');
    expect(h.api.comments.length).toBeGreaterThan(0);
  });
});

describe('contract coverage of the issue client', () => {
  test('every issue operation was exercised with a success answer', () => {
    for (const key of EXERCISED.issuesClient) expect(covered).toContain(key);
  });
});
