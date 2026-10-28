import { afterEach, describe, expect, test } from 'bun:test';

import { NEW_ISSUE_URL_MAX } from '../../src/issues/prefill';
import type { Json } from '../support/controller';
import { parseHtml } from '../ui/helpers';

import { recordControllerError, REQUEST_ID, seedEvents, withJob } from './seed';
import {
  ADMIN,
  IDS,
  issueHarness,
  request,
  VIEWER,
  type IssueHarness,
} from './support';

let current: IssueHarness | null = null;
afterEach(() => current?.api.stop());

async function harness(options: Parameters<typeof issueHarness>[0] = {}) {
  current = await issueHarness(options);
  const events = await seedEvents(current);
  return { h: current, events };
}

const page = (h: IssueHarness, path: string, cookie: string | null = ADMIN) =>
  request(h, 'GET', path, { cookie }).then((r) => r.text());

describe('the preview page', () => {
  test('requires sign-in', async () => {
    const { h } = await harness();
    const reply = await request(
      h,
      'GET',
      `/report-issue?kind=node&node=${IDS.rolledBack}`,
      { cookie: null }
    );
    expect(reply.status).toBe(303);
    expect(reply.headers.get('location')).toContain('/login');
  });

  test('an admin sees the redacted report, the redaction summary and one Create button; the draft is saved', async () => {
    const { h, events } = await harness();
    const html = await page(
      h,
      `/report-issue?kind=node&node=${IDS.rolledBack}&event=${events.rollback}`
    );
    expect(html).toContain('<title>Report an issue');
    expect(html).toContain('[Fleet node] Node rolled back');
    expect(html).toContain('No secrets were detected');
    expect(html.match(/Create GitHub issue/g)).toHaveLength(1);
    expect(html).toContain('action="/report-issue"');
    const stored = await h.memory.list({ limit: 5 });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('draft');
    expect(html).toContain(`value="${stored[0]!.id}"`);

    await h.deps.store.addEvent({
      nodeId: IDS.rolledBack,
      nodeLabel: 'n',
      kind: 'rollback',
      severity: 'error',
      message: 'token=abcdef123456 leaked',
    });
    const withSecret = await page(
      h,
      `/report-issue?kind=node&node=${IDS.rolledBack}`
    );
    expect(withSecret).toContain('Removed before showing');
    expect(withSecret).not.toContain('abcdef123456');
  });

  test('a viewer gets a read-only preview: no button, nothing saved', async () => {
    const { h } = await harness();
    const html = await page(
      h,
      `/report-issue?kind=node&node=${IDS.rolledBack}`,
      VIEWER
    );
    expect(html).toContain('read-only preview');
    expect(html).not.toContain('Create GitHub issue');
    expect(html).toContain('## Summary');
    expect(await h.memory.list({ limit: 5 })).toHaveLength(0);
  });

  test('bad or unknown targets are refused with a reason, not guessed', async () => {
    const { h } = await harness();
    const missing = await request(h, 'GET', '/report-issue?kind=node');
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('name what to report');
    const unknown = await request(
      h,
      'GET',
      `/report-issue?kind=node&node=${'ab'.repeat(32)}`
    );
    expect(unknown.status).toBe(404);
    const badKind = await request(h, 'GET', '/report-issue?kind=bogus&node=x');
    expect(badKind.status).toBe(400);
  });

  test('every kind is reachable: installer, controller, workload (the Runners link target)', async () => {
    const { h } = await harness();
    withJob(h);
    recordControllerError(h, new Error('boom'));
    for (const query of [
      `kind=installer&node=${IDS.pending}`,
      `kind=controller&request=${REQUEST_ID}`,
      'kind=workload&job=77',
    ]) {
      const reply = await request(h, 'GET', `/report-issue?${query}`);
      expect(reply.status, query).toBe(200);
    }
  });
});

describe('confirming', () => {
  test('POST creates the issue and shows the result; the browser is redirected back', async () => {
    const { h } = await harness();
    await page(h, `/report-issue?kind=node&node=${IDS.rolledBack}`);
    const [draft] = await h.memory.list({ limit: 1 });
    const reply = await request(h, 'POST', '/report-issue', {
      form: { draft: draft!.id },
    });
    expect(reply.status).toBe(303);
    expect(reply.headers.get('location')).toBe(
      `/report-issue?draft=${draft!.id}`
    );
    expect(h.api.issues).toHaveLength(1);
    const cookie = `${ADMIN}; ${reply.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')}`;
    const html = await page(h, `/report-issue?draft=${draft!.id}`, cookie);
    expect(html).toContain('Created GitHub issue #1');
    expect(html).toContain('Filed as GitHub issue #1');
    expect(html).not.toContain('Create GitHub issue</button>');
  });

  test('is protected like every admin form: cross-site refused, viewers refused and audited', async () => {
    const { h } = await harness();
    await page(h, `/report-issue?kind=node&node=${IDS.rolledBack}`);
    const [draft] = await h.memory.list({ limit: 1 });
    const crossSite = await request(h, 'POST', '/report-issue', {
      form: { draft: draft!.id },
      origin: 'https://evil.example',
    });
    expect(crossSite.status).toBe(403);
    const noOrigin = await request(h, 'POST', '/report-issue', {
      form: { draft: draft!.id },
      origin: null,
    });
    expect(noOrigin.status).toBe(403);
    const viewer = await request(h, 'POST', '/report-issue', {
      form: { draft: draft!.id },
      cookie: VIEWER,
    });
    expect(viewer.status).toBe(403);
    expect(h.api.issues).toHaveLength(0);
    expect((await h.memory.get(draft!.id))!.status).toBe('draft');
    const denied = await h.deps.store.listAudit({ limit: 10 });
    expect(denied.some((e) => e.outcome === 'denied')).toBe(true);
  });
});

describe('the JSON API', () => {
  test('preview is allowed for a viewer (nothing saved); creating is not', async () => {
    const { h } = await harness();
    const preview = await request(h, 'POST', '/v1/issues/preview', {
      cookie: VIEWER,
      json: { kind: 'node', node: IDS.rolledBack },
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      persisted: false,
      id: null,
      status: 'unsaved',
    });
    const create = await request(h, 'POST', '/v1/issues', {
      cookie: VIEWER,
      json: { kind: 'node', node: IDS.rolledBack },
    });
    expect(create.status).toBe(403);
    expect(h.api.issues).toHaveLength(0);
  });

  test('an admin previews (saved as draft), files, lists and reads it back', async () => {
    const { h } = await harness();
    const preview = (await (
      await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'node', node: IDS.rolledBack },
      })
    ).json()) as Json;
    expect(preview).toMatchObject({ persisted: true, status: 'draft' });
    expect(preview['submission']).toMatchObject({
      configured: true,
      reason: null,
    });
    expect(preview['body']).toContain('## Summary');
    const created = await request(h, 'POST', '/v1/issues', {
      json: { draftId: preview['id'] },
    });
    expect(created.status).toBe(201);
    const list = (await (
      await request(h, 'GET', '/v1/issues', { cookie: VIEWER })
    ).json()) as Json;
    expect(list['reports']).toHaveLength(1);
    expect(list['reports'][0]).toMatchObject({
      status: 'created',
      githubIssueNumber: 1,
    });
    expect(list['reports'][0]['body']).toBeUndefined();
    const one = (await (
      await request(h, 'GET', `/v1/issues/${String(preview['id'])}`, {
        cookie: VIEWER,
      })
    ).json()) as Json;
    expect(one['body']).toContain('## Summary');
    expect((await request(h, 'GET', '/v1/issues/nope')).status).toBe(404);
  });

  test('POST /v1/issues with a target previews and files in one call', async () => {
    const { h } = await harness();
    const reply = await request(h, 'POST', '/v1/issues', {
      json: { kind: 'node', node: IDS.rolledBack },
    });
    expect(reply.status).toBe(201);
    expect(h.api.issues).toHaveLength(1);
  });

  test('validates input and requires a same-origin session or the admin token', async () => {
    const { h } = await harness();
    expect(
      (
        await request(h, 'POST', '/v1/issues/preview', {
          json: { kind: 'node' },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(h, 'POST', '/v1/issues/preview', {
          json: { kind: 'node', node: 'zz' },
        })
      ).status
    ).toBe(400);
    expect(
      (await request(h, 'POST', '/v1/issues', { json: { draftId: 'missing' } }))
        .status
    ).toBe(404);
    expect(
      (
        await request(h, 'POST', '/v1/issues', {
          json: { kind: 'node', node: IDS.rolledBack },
          origin: 'https://evil.example',
        })
      ).status
    ).toBe(403);
    expect(
      (await request(h, 'GET', '/v1/issues', { cookie: null })).status
    ).toBe(401);
  });

  test('links tell nodes and events where they were reported', async () => {
    const { h, events } = await harness();
    const preview = (await (
      await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'node', node: IDS.rolledBack, event: events.rollback },
      })
    ).json()) as Json;
    await request(h, 'POST', '/v1/issues', {
      json: { draftId: preview['id'] },
    });
    const links = (await (
      await request(
        h,
        'GET',
        `/v1/issues/links?node=${IDS.rolledBack}&event=${events.rollback}&event=${events.blocked}`,
        { cookie: VIEWER }
      )
    ).json()) as Json;
    expect(links['node']).toHaveLength(1);
    expect(links['events'][String(events.rollback)]).toMatchObject({
      number: 1,
      status: 'created',
    });
    expect(links['events'][String(events.blocked)]).toBeUndefined();
  });
});

describe('without a token the page still works', () => {
  test('says why, offers copy and a prefilled new-issue link, and creates nothing', async () => {
    const { h } = await harness({ configured: false, repositoryOnly: true });
    const html = await page(
      h,
      `/report-issue?kind=node&node=${IDS.rolledBack}`
    );
    expect(html).toContain('Filing from the controller is not configured');
    expect(html).toContain('FLEET_ISSUES_GITHUB_TOKEN');
    expect(html).not.toContain('Create GitHub issue');
    expect(html).toContain('data-copy="');
    const link =
      /href="(http:\/\/127\.0\.0\.1:\d+\/acme\/fleet-reports\/issues\/new\?[^"]+)"/.exec(
        html
      );
    expect(link).not.toBeNull();
    const url = new URL(link![1]!.replaceAll('&amp;', '&'));
    expect(url.searchParams.get('title')).toContain('[Fleet node]');
    expect(url.searchParams.get('body')).toContain('fleet-issue-fingerprint:');
    expect(url.toString().length).toBeLessThanOrEqual(NEW_ISSUE_URL_MAX);
    const create = await request(h, 'POST', '/v1/issues', {
      json: { kind: 'node', node: IDS.rolledBack },
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({
      error: 'issues_not_configured',
    });
    expect(h.api.calls).toHaveLength(0);
  });

  test('with no repository either, it says so and offers only copy', async () => {
    const { h } = await harness({ configured: false });
    const html = await page(
      h,
      `/report-issue?kind=node&node=${IDS.rolledBack}`
    );
    expect(html).toContain('Without FLEET_ISSUES_REPOSITORY');
    expect(html).not.toContain('Open prefilled GitHub issue');
    expect(html).toContain('data-copy="');
  });

  test('the prefilled link is shortened to fit, keeping the fingerprint marker', async () => {
    const { h } = await harness({ configured: false, repositoryOnly: true });
    for (let i = 0; i < 60; i += 1)
      await h.deps.store.addEvent({
        nodeId: IDS.rolledBack,
        nodeLabel: 'n',
        kind: 'noise',
        severity: 'warn',
        message: `${i} ${'é'.repeat(200)}`,
      });
    const reply = (await (
      await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'node', node: IDS.rolledBack },
      })
    ).json()) as Json;
    const url = new URL(reply['submission']['newIssueUrl']);
    expect(url.toString().length).toBeLessThanOrEqual(NEW_ISSUE_URL_MAX);
    expect(url.searchParams.get('body')).toContain('fleet-issue-fingerprint:');
    expect(url.searchParams.get('body')).toContain(
      'Shortened for the length of a web address'
    );
  });
});

describe('hostile text from nodes', () => {
  const HOSTILE = '<script>alert(1)</script><img src=x onerror=alert(2)>';

  test('is escaped on the page, never markup', async () => {
    const { h } = await harness();
    await h.deps.store.addEvent({
      nodeId: IDS.rolledBack,
      nodeLabel: HOSTILE,
      kind: 'rollback',
      severity: 'error',
      message: HOSTILE,
    });
    h.deps.store.updateSeeded(IDS.rolledBack, {
      displayName: HOSTILE,
      hostname: HOSTILE,
      reconcile: { phase: 'blocked', issues: [HOSTILE] },
    });
    const clean = await parseHtml(
      await page(h, `/report-issue?kind=node&node=${IDS.online}`)
    );
    const html = await page(
      h,
      `/report-issue?kind=node&node=${IDS.rolledBack}`
    );
    const parsed = await parseHtml(html);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(parsed.tags.filter((t) => t === 'script').length).toBe(
      clean.tags.filter((t) => t === 'script').length
    );
    expect(parsed.tags).not.toContain('img');
    expect(parsed.attributes).not.toContain('onerror');
  });

  test('cannot break out of its Markdown code span or fence, link, mention or embed', async () => {
    const { h } = await harness();
    const message =
      'x ``` \n## fake heading\n![t](https://evil.example/p.png) [a](https://evil.example) @everyone `tick`';
    await h.deps.store.addEvent({
      nodeId: IDS.rolledBack,
      nodeLabel: 'n',
      kind: 'rollback',
      severity: 'error',
      message,
    });
    h.deps.store.updateSeeded(IDS.rolledBack, {
      reconcile: { phase: 'blocked', issues: [message] },
    });
    const reply = (await (
      await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'node', node: IDS.rolledBack },
      })
    ).json()) as Json;
    const body: string = reply['body'];
    const outside = body.split('\n').filter((line) => !line.startsWith('    '));
    const headings = outside
      .filter((line) => line.startsWith('## '))
      .map((line) => line);
    expect(headings).not.toContain('## fake heading');
    expect(body).not.toMatch(/^## fake heading/m);
    for (const line of body.split('\n')) {
      if (line.includes('evil.example') || line.includes('@everyone')) {
        const before = line.slice(0, line.search(/evil\.example|@everyone/));
        expect((before.match(/`/g) ?? []).length % 2, line).toBe(1);
      }
    }
  });
});

describe('Report issue links across the UI', () => {
  test('node page, events, overview, pending and operations link to the preview', async () => {
    const { h, events } = await harness();
    const node = await page(h, `/nodes/${IDS.rolledBack}`);
    expect(node).toContain(
      `href="/report-issue?kind=node&amp;node=${IDS.rolledBack}"`
    );
    const pending = await page(h, '/pending');
    expect(pending).toContain(
      `href="/report-issue?kind=installer&amp;node=${IDS.pending}"`
    );
    const feed = await page(h, '/events');
    expect(feed).toContain(
      `kind=node&amp;node=${IDS.rolledBack}&amp;event=${events.rollback}`
    );
    const overview = await page(h, '/');
    expect(overview).toContain('/report-issue?kind=node&amp;node=');
    const op = await h.deps.store.operations.create(
      {
        id: 'op-9',
        kind: 'drain',
        nodeId: IDS.online,
        requestedBy: 'tester',
        requestedAt: h.now(),
        progress: null,
        idempotencyKey: null,
        detail: {},
      },
      []
    );
    expect(op.outcome).toBe('created');
    await h.deps.store.operations.update('op-9', {
      expect: 'pending',
      status: 'failed',
      updatedAt: h.now(),
      progress: null,
      failure: 'node never drained',
    });
    expect(await page(h, '/operations')).toContain('&amp;operation=op-9');
  });

  test('once filed, the node page and the events page show the issue', async () => {
    const { h, events } = await harness();
    const preview = (await (
      await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'node', node: IDS.rolledBack, event: events.rollback },
      })
    ).json()) as Json;
    await request(h, 'POST', '/v1/issues', {
      json: { draftId: preview['id'] },
    });
    expect(await page(h, `/nodes/${IDS.rolledBack}`)).toContain('Issue #1');
    expect(await page(h, '/events')).toContain('Issue #1');
    expect(await page(h, `/events?node=${IDS.online}`)).not.toContain(
      'Issue #1'
    );
  });

  test('the console state route serves the report page path', async () => {
    const { h } = await harness();
    const reply = await request(
      h,
      'GET',
      `/ui/state?path=${encodeURIComponent(`/report-issue?kind=node&node=${IDS.rolledBack}`)}`
    );
    expect(reply.status).toBe(200);
  });
});

describe('controller error pages', () => {
  function breakNodes(h: IssueHarness): void {
    const store = h.deps.store;
    store.listNodes = async () => {
      throw new Error(
        'relation "secret_table" exploded: password=hunter2-hunter2'
      );
    };
  }

  test('a 5xx keeps its JSON body, carries the request id and a report link, and remembers the error', async () => {
    const { h } = await harness();
    breakNodes(h);
    const reply = await request(h, 'GET', '/v1/nodes');
    expect(reply.status).toBe(500);
    expect(await reply.json()).toEqual({
      error: 'internal',
      message: 'The Fleet controller could not complete the request.',
    });
    const id = reply.headers.get('x-request-id')!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(reply.headers.get('x-fleet-report')).toBe(
      `/report-issue?kind=controller&request=${id}`
    );
    const preview = (await (
      await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'controller', request: id },
      })
    ).json()) as Json;
    expect(preview['body']).toContain('relation "secret_table" exploded');
    expect(preview['body']).not.toContain('hunter2-hunter2');
    expect(preview['body']).toContain(id);
    expect(preview['classification']).toMatchObject({
      code: 'controller-error',
    });
  });

  test('a browser navigation gets a page with the id and a Report link', async () => {
    const { h } = await harness();
    breakNodes(h);
    const reply = await h.app.request('/nodes', {
      headers: { cookie: ADMIN, accept: 'text/html' },
    });
    expect(reply.status).toBe(500);
    const html = await reply.text();
    const id = reply.headers.get('x-request-id')!;
    expect(html).toContain('Something went wrong');
    expect(html).toContain(id);
    expect(html).toContain(
      `href="/report-issue?kind=controller&amp;request=${id}"`
    );
    expect(html).not.toContain('hunter2');
  });
});
