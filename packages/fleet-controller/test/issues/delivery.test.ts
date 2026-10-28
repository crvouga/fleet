import { afterEach, describe, expect, test } from 'bun:test';
import { createLogger } from '@pkgs/logger';

import { MemoryIssueStore } from '../../src/issues/memory-store';
import { retryDelayMs } from '../../src/issues/delivery';
import { classifyHttp } from '../../src/issues/github-issues';
import { DEFAULT_TUNING } from '../../src/issues/runtime';
import { runIssueSyncJob } from '../../src/jobs/issue-sync';

import type { Json } from '../support/controller';

import { status } from './fake-issues-api';
import { seedEvents } from './seed';
import { IDS, issueHarness, request, type IssueHarness } from './support';

let current: IssueHarness | null = null;
afterEach(() => current?.api.stop());

async function harness(
  options: Parameters<typeof issueHarness>[0] = {}
): Promise<IssueHarness> {
  current = await issueHarness(options);
  await seedEvents(current);
  return current;
}

interface Preview {
  id: string;
  status: string;
  duplicate: { id: string; number: number | null } | null;
}

async function preview(
  h: IssueHarness,
  node = IDS.rolledBack
): Promise<Preview> {
  const reply = await request(h, 'POST', '/v1/issues/preview', {
    json: { kind: 'node', node },
  });
  expect(reply.status).toBe(200);
  return (await reply.json()) as Preview;
}

async function submit(
  h: IssueHarness,
  draftId: string
): Promise<{ status: number; body: Json }> {
  const reply = await request(h, 'POST', '/v1/issues', { json: { draftId } });
  return {
    status: reply.status,
    body: (await reply.json()) as Json,
  };
}

function runJob(h: IssueHarness) {
  return runIssueSyncJob({
    store: h.deps.store,
    now: h.now,
    fetch,
    log: createLogger({ name: 'test', level: 'silent' }),
    issues: h.deps.issues,
  });
}

async function report(h: IssueHarness, id: string) {
  const row = await h.memory.get(id);
  if (row === null) throw new Error('report is gone');
  return row;
}

describe('backoff and failure classes (pure)', () => {
  test('exponential, capped, jittered between half and full, and Retry-After wins when longer', () => {
    const t = { ...DEFAULT_TUNING, baseMs: 1000, capMs: 8000 };
    expect(retryDelayMs(1, t, () => 0, null)).toBe(500);
    expect(retryDelayMs(1, t, () => 1, null)).toBe(1000);
    expect(retryDelayMs(3, t, () => 1, null)).toBe(4000);
    expect(retryDelayMs(9, t, () => 1, null)).toBe(8000);
    expect(retryDelayMs(2, t, () => 0, 30_000)).toBe(30_000);
    expect(retryDelayMs(2, t, () => 0, 99_999_999)).toBe(t.maxRetryAfterMs);
  });

  test('network-ish and capacity failures are temporary; credential and request errors are not', () => {
    const reply = (
      statusCode: number,
      headers: Record<string, string> = {},
      json: unknown = {}
    ) =>
      classifyHttp(
        { status: statusCode, headers: new Headers(headers), json },
        'acme/r',
        0
      );
    for (const code of [500, 502, 503, 504, 429, 408])
      expect(reply(code).temporary).toBe(true);
    expect(reply(403, { 'retry-after': '30' }).retryAfterMs).toBe(30_000);
    expect(
      reply(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' })
        .temporary
    ).toBe(true);
    expect(
      reply(403, {}, { message: 'You have exceeded a secondary rate limit' })
        .temporary
    ).toBe(true);
    for (const code of [400, 401, 403, 404, 410, 422])
      expect(reply(code).temporary).toBe(false);
    expect(reply(401).message).toContain('FLEET_ISSUES_GITHUB_TOKEN');
    expect(reply(404).message).toContain('acme/r');
    expect(reply(422, {}, { message: 'Validation Failed' }).message).toContain(
      'Validation Failed'
    );
  });
});

describe('creating the issue', () => {
  test('a configured controller files it once, with the marker, labels and the token', async () => {
    const h = await harness();
    const draft = await preview(h);
    expect(draft.status).toBe('draft');
    const sent = await submit(h, draft.id);
    expect(sent.status).toBe(201);
    expect(sent.body['report']).toMatchObject({
      status: 'created',
      githubIssueNumber: 1,
    });
    expect(h.api.issues).toHaveLength(1);
    const issue = h.api.issues[0]!;
    expect(issue.body).toContain('<!-- fleet-issue-fingerprint:');
    expect(issue.labels).toEqual(['fleet-report']);
    expect(h.api.creates()[0]!.authorization).toBe(`Bearer ${h.api.token}`);
    const trail = await h.deps.store.listAudit({ limit: 20 });
    expect(trail.map((e) => e.action)).toEqual(
      expect.arrayContaining(['issue.preview', 'issue.create'])
    );
    expect(JSON.stringify(trail)).not.toContain(h.api.token);
  });

  test('submitting the same draft again changes nothing', async () => {
    const h = await harness();
    const draft = await preview(h);
    await submit(h, draft.id);
    const again = await submit(h, draft.id);
    expect(again.status).toBe(200);
    expect(again.body['outcome']).toBe('existing');
    expect(h.api.creates()).toHaveLength(1);
  });

  test('the token is never stored, returned, rendered or logged', async () => {
    const h = await harness();
    const draft = await preview(h);
    const sent = await submit(h, draft.id);
    const everything = JSON.stringify([
      sent.body,
      await h.memory.list({ limit: 10 }),
      await h.deps.store.listAudit({ limit: 50 }),
    ]);
    expect(everything).not.toContain(h.api.token);
    const page = await (
      await request(h, 'GET', `/report-issue?draft=${draft.id}`)
    ).text();
    expect(page).not.toContain(h.api.token);
  });
});

describe('temporary failures queue with bounded, jittered backoff', () => {
  test('a 503 queues the report, the job retries when due and succeeds once GitHub is back', async () => {
    const h = await harness();
    h.api.inject({ match: /POST .*\/issues$/, times: 1, respond: status(503) });
    const draft = await preview(h);
    const sent = await submit(h, draft.id);
    expect(sent.status).toBe(202);
    const queued = await report(h, draft.id);
    expect(queued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(queued.lastError).toContain('HTTP 503');
    expect(queued.nextAttemptAt!.getTime() - h.now().getTime()).toBe(750);

    expect(await runJob(h)).toBe(0);
    expect(h.api.creates()).toHaveLength(1);
    h.advance(751);
    expect(await runJob(h)).toBe(1);
    expect(await report(h, draft.id)).toMatchObject({
      status: 'created',
      githubIssueNumber: 1,
      lastError: null,
    });
    expect(h.api.issues).toHaveLength(1);
  });

  test('429 with Retry-After waits at least that long; rate-limit headers on a 403 do too', async () => {
    const h = await harness();
    h.api.inject({
      match: /POST .*\/issues$/,
      times: 1,
      respond: status(429, 'slow down', { 'retry-after': '120' }),
    });
    const first = await preview(h);
    await submit(h, first.id);
    expect(
      (await report(h, first.id)).nextAttemptAt!.getTime() - h.now().getTime()
    ).toBe(120_000);
    h.advance(119_000);
    expect(await runJob(h)).toBe(0);
    h.advance(2_000);
    expect(await runJob(h)).toBe(1);

    h.api.inject({
      match: /POST .*\/issues$/,
      times: 1,
      respond: status(403, 'API rate limit exceeded', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(h.now().getTime() / 1000) + 90),
      }),
    });
    const second = await preview(h, IDS.online);
    await submit(h, second.id);
    const waited =
      (await report(h, second.id)).nextAttemptAt!.getTime() - h.now().getTime();
    expect(waited).toBeGreaterThanOrEqual(89_000);
    expect(waited).toBeLessThanOrEqual(91_000);
  });

  test('a timeout is temporary', async () => {
    const h = await harness({ tuning: { timeoutMs: 80 } });
    h.api.inject({
      match: /POST .*\/issues$/,
      times: 1,
      respond: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Response('{}', { status: 201 })), 400)
        ),
    });
    const draft = await preview(h);
    expect((await submit(h, draft.id)).status).toBe(202);
    expect((await report(h, draft.id)).lastError).toContain(
      'did not answer in time'
    );
  });

  test('a connection that cannot be made is temporary', async () => {
    const h = await harness();
    const stopped = h.api;
    const draft = await preview(h);
    stopped.stop();
    expect((await submit(h, draft.id)).status).toBe(202);
    expect((await report(h, draft.id)).lastError).toContain(
      'could not be reached'
    );
    expect((await report(h, draft.id)).status).toBe('queued');
  });

  test('after the last attempt it fails with an actionable message and the draft is intact', async () => {
    const h = await harness();
    h.api.inject({
      match: /POST .*\/issues$/,
      times: Infinity,
      respond: status(502),
    });
    const draft = await preview(h);
    await submit(h, draft.id);
    for (let i = 0; i < 6; i += 1) {
      h.advance(60_000);
      await runJob(h);
    }
    const failed = await report(h, draft.id);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 4,
      nextAttemptAt: null,
    });
    expect(failed.lastError).toContain('Gave up after 4 attempts');
    expect(failed.lastError).toContain('Create GitHub issue');
    expect(failed.body).toContain('## Summary');
    const trail = await h.deps.store.listAudit({ limit: 50 });
    expect(trail.find((e) => e.action === 'issue.deliver')).toMatchObject({
      outcome: 'failed',
      actor: 'system:issue-sync',
    });
  });
});

describe('permanent failures fail at once and stay usable', () => {
  for (const [code, text] of [
    [401, 'FLEET_ISSUES_GITHUB_TOKEN'],
    [403, 'Issues: write'],
    [404, 'acme/fleet-reports'],
    [422, 'invalid'],
  ] as const) {
    test(`${code} becomes failed with a visible reason`, async () => {
      const h = await harness();
      h.api.inject({
        match: /POST .*\/issues$/,
        times: 1,
        respond: status(code, 'Validation Failed'),
      });
      const draft = await preview(h);
      const sent = await submit(h, draft.id);
      expect(sent.status).toBe(502);
      expect(sent.body['error']).toBe('issue_failed');
      const failed = await report(h, draft.id);
      expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
      expect(failed.lastError).toContain(text);
      expect(h.api.creates()).toHaveLength(1);
      const page = await (
        await request(h, 'GET', `/report-issue?draft=${draft.id}`)
      ).text();
      expect(page).toContain('The report was not filed');
      expect(page).toContain('Create GitHub issue');
      expect(page).toContain('## Summary');
    });
  }

  test('after the cause is fixed the same report can be filed', async () => {
    const h = await harness();
    h.api.inject({ match: /POST .*\/issues$/, times: 1, respond: status(401) });
    const draft = await preview(h);
    expect((await submit(h, draft.id)).status).toBe(502);
    const retried = await submit(h, draft.id);
    expect(retried.status).toBe(201);
    expect((await report(h, draft.id)).status).toBe('created');
  });
});

describe('no duplicate issues, whatever fails', () => {
  test('GitHub created the issue but the answer was lost: the retry finds it by its marker', async () => {
    const h = await harness();
    h.api.inject({
      match: /POST .*\/issues$/,
      times: 1,
      afterEffect: true,
      respond: status(502),
    });
    const draft = await preview(h);
    expect((await submit(h, draft.id)).status).toBe(202);
    expect(h.api.issues).toHaveLength(1);
    h.advance(5_000);
    await runJob(h);
    expect(await report(h, draft.id)).toMatchObject({
      status: 'created',
      githubIssueNumber: 1,
    });
    expect(h.api.issues).toHaveLength(1);
    expect(h.api.creates()).toHaveLength(1);
  });

  test('the controller crashed between create and saving the number', async () => {
    const h = await harness();
    const real = h.memory.markCreated.bind(h.memory);
    let crashes = 1;
    h.memory.markCreated = async (...args) => {
      if (crashes-- > 0) throw new Error('database is gone');
      return real(...args);
    };
    const draft = await preview(h);
    await expect(submit(h, draft.id)).resolves.toMatchObject({ status: 500 });
    expect(h.api.issues).toHaveLength(1);
    expect(await report(h, draft.id)).toMatchObject({
      status: 'queued',
      githubIssueNumber: null,
    });
    h.advance(10_000);
    await runJob(h);
    expect(await report(h, draft.id)).toMatchObject({
      status: 'created',
      githubIssueNumber: 1,
    });
    expect(h.api.issues).toHaveLength(1);
  });

  test('a claimed attempt cannot be started twice; two job passes create one issue', async () => {
    const h = await harness();
    h.api.inject({ match: /POST .*\/issues$/, times: 1, respond: status(503) });
    const draft = await preview(h);
    await submit(h, draft.id);
    h.advance(1_000);
    const results = await Promise.all([runJob(h), runJob(h), runJob(h)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.api.issues).toHaveLength(1);
  });

  test('two submissions of one draft at once file one issue', async () => {
    const h = await harness();
    const draft = await preview(h);
    const [a, b] = await Promise.all([
      submit(h, draft.id),
      submit(h, draft.id),
    ]);
    expect(h.api.issues).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
  });

  test('two different drafts of one failure submitted at once file one issue; the other links to it', async () => {
    const h = await harness();
    h.api.inject({ match: /POST .*\/issues$/, times: 1, respond: status(401) });
    const first = await preview(h);
    expect((await submit(h, first.id)).status).toBe(502);
    const second = await preview(h);
    expect(second.id).not.toBe(first.id);
    const [a, b] = await Promise.all([
      submit(h, first.id),
      submit(h, second.id),
    ]);
    expect(h.api.issues).toHaveLength(1);
    const outcomes = [a.body['outcome'], b.body['outcome']].sort();
    expect(outcomes).toEqual(['created', 'duplicate']);
    const created = [a, b].find((r) => r.body['outcome'] === 'created')!;
    const duplicate = [a, b].find((r) => r.body['outcome'] === 'duplicate')!;
    expect(duplicate.body['report'].id).toBe(created.body['report'].id);
    expect((await report(h, created.body['report'].id)).githubIssueNumber).toBe(
      1
    );
  });

  test('a failure that happens again is linked, and commented on at most once a day', async () => {
    const h = await harness();
    const first = await preview(h);
    await submit(h, first.id);
    const second = await preview(h);
    expect(second.duplicate).toMatchObject({ number: 1 });
    const linked = await submit(h, second.id);
    expect(linked.body).toMatchObject({
      outcome: 'duplicate',
      report: { githubIssueNumber: 1 },
    });
    expect(h.api.issues).toHaveLength(1);
    expect(h.api.comments).toHaveLength(1);
    expect(h.api.comments[0]!.body).toContain('Seen again');

    const third = await preview(h);
    await submit(h, third.id);
    expect(h.api.comments).toHaveLength(1);
    h.advance(25 * 3_600_000);
    const fourth = await preview(h);
    await submit(h, fourth.id);
    expect(h.api.comments).toHaveLength(2);
    expect((await report(h, second.id)).status).toBe('duplicate');
  });

  test('once the GitHub issue is closed a new occurrence files a new issue', async () => {
    const h = await harness();
    const first = await preview(h);
    await submit(h, first.id);
    h.api.issues[0]!.state = 'closed';
    const again = await preview(h);
    const sent = await submit(h, again.id);
    expect(sent.status).toBe(201);
    expect(h.api.issues).toHaveLength(2);
    expect((await report(h, first.id)).status).toBe('duplicate');
    expect(await report(h, again.id)).toMatchObject({
      status: 'created',
      githubIssueNumber: 2,
    });
  });
});

describe('outage recovery end to end', () => {
  test('GitHub down for a while: queued, retried with growing delays, filed when it returns', async () => {
    const h = await harness();
    h.api.inject({ match: /POST .*\/issues$/, times: 2, respond: status(503) });
    const draft = await preview(h);
    await submit(h, draft.id);
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const row = await report(h, draft.id);
      if (row.status === 'created') break;
      delays.push(row.nextAttemptAt!.getTime() - h.now().getTime());
      h.advance(row.nextAttemptAt!.getTime() - h.now().getTime() + 1);
      await runJob(h);
    }
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect((await report(h, draft.id)).status).toBe('created');
    expect(h.api.issues).toHaveLength(1);
  });
});

describe('the store contract', () => {
  test('a second open report for one fingerprint is refused by queue()', async () => {
    const store = new MemoryIssueStore();
    const base = {
      fingerprint: 'f'.repeat(32),
      kind: 'node' as const,
      nodeId: null,
      title: 't',
      body: 'b',
      snapshot: {},
      correlationId: null,
      createdBy: 'x',
      now: new Date(0),
    };
    const a = await store.saveDraft({ ...base, id: 'a' });
    expect((await store.queue(a.id, new Date(1))).outcome).toBe('queued');
    await store.markFailed('a', 'x', new Date(2));
    const b = await store.saveDraft({ ...base, id: 'b' });
    expect((await store.queue(b.id, new Date(3))).outcome).toBe('queued');
    expect((await store.queue('a', new Date(4))).outcome).toBe('conflict');
  });
});
