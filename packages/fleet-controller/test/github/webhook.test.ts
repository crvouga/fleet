import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { validSignature } from '../../src/github/webhook';
import { nodeIdOf } from '../support/fixtures';

import {
  createGithubHarness,
  WEBHOOK_SECRET,
  type GithubHarness,
} from './testing/harness';

const sign = (body: string, secret = WEBHOOK_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function workflowJob(over: Record<string, unknown> = {}, action = 'queued') {
  return {
    action,
    repository: { full_name: 'acme/app' },
    workflow_job: {
      id: 501,
      run_id: 90,
      name: 'test',
      status: action === 'completed' ? 'completed' : action,
      conclusion: action === 'completed' ? 'success' : null,
      labels: ['self-hosted', 'ci'],
      runner_id: null,
      runner_name: null,
      html_url: 'https://github.com/acme/app/actions/runs/90/job/501',
      created_at: '2026-10-14T11:58:00Z',
      started_at: null,
      completed_at: null,
      ...over,
    },
  };
}

describe('POST /v1/github/webhook', () => {
  let h: GithubHarness;
  let delivery = 0;
  beforeAll(async () => {
    h = await createGithubHarness();
    await h.addNode(1);
    await h.configure();
  });
  afterAll(() => h.close());

  async function send(
    payload: unknown,
    event = 'workflow_job',
    over: { signature?: string; id?: string } = {}
  ) {
    const body =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    delivery += 1;
    return h.call('POST', '/v1/github/webhook', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': over.id ?? `delivery-${delivery}-aaaa`,
        'x-hub-signature-256': over.signature ?? sign(body),
      },
    });
  }

  test('rejects a bad or missing signature with 401 and audits it without the payload', async () => {
    const body = JSON.stringify(workflowJob());
    const wrong = await send(body, 'workflow_job', {
      signature: sign(body, 'another-secret-0123456789'),
    });
    expect(wrong.status).toBe(401);
    const missing = await h.call('POST', '/v1/github/webhook', {
      body,
      headers: {
        'x-github-delivery': 'delivery-missing-sig',
        'x-github-event': 'workflow_job',
      },
    });
    expect(missing.status).toBe(401);
    const audit = await h.store.listAudit({
      limit: 10,
      targetKind: 'github-integration',
    });
    expect(audit.filter((a) => a.outcome === 'denied')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('"id":501');
    expect(await h.github.store.getJob(501)).toBeNull();
  });

  test('compares signatures in constant time and rejects malformed ones', () => {
    const body = '{}';
    expect(
      validSignature('s'.repeat(20), body, sign(body, 's'.repeat(20)))
    ).toBe(true);
    for (const bad of [
      undefined,
      '',
      'sha256=',
      'sha256=abc',
      'sha1=' + 'a'.repeat(40),
      `sha256=${'g'.repeat(64)}`,
      `sha256=${'0'.repeat(64)}`,
    ]) {
      expect(validSignature('s'.repeat(20), body, bad)).toBe(false);
    }
  });

  test('stores a workflow_job event', async () => {
    const reply = await send(workflowJob());
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, result: 'job' });
    expect(await h.github.store.getJob(501)).toMatchObject({
      status: 'queued',
      source: 'webhook',
      repository: 'acme/app',
    });
  });

  test('acknowledges a duplicate delivery id without handling it again', async () => {
    const id = 'delivery-duplicate-1';
    expect(
      (await send(workflowJob({ id: 502 }), 'workflow_job', { id })).body.result
    ).toBe('job');
    await h.db.unsafe('delete from ci_jobs where id = 502');
    const again = await send(workflowJob({ id: 502 }), 'workflow_job', { id });
    expect(again.status).toBe(200);
    expect(again.body.result).toBe('duplicate');
    expect(await h.github.store.getJob(502)).toBeNull();
  });

  test('a late queued event never moves a completed job backwards', async () => {
    await send(
      workflowJob(
        {
          id: 503,
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2026-10-14T12:00:00Z',
          started_at: '2026-10-14T11:59:00Z',
        },
        'completed'
      )
    );
    await send(workflowJob({ id: 503 }, 'queued'));
    await send(
      workflowJob(
        { id: 503, status: 'in_progress', started_at: '2026-10-14T11:59:00Z' },
        'in_progress'
      )
    );
    expect(await h.github.store.getJob(503)).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
  });

  test('correlates the runner name to a node', async () => {
    await send(
      workflowJob(
        {
          id: 504,
          status: 'in_progress',
          runner_id: 3,
          runner_name: h.runnerName(1, 2),
        },
        'in_progress'
      )
    );
    expect((await h.github.store.getJob(504))?.nodeId).toBe(nodeIdOf(1));
  });

  test('ignores repositories the integration does not monitor, pings and unknown events', async () => {
    const other = workflowJob({ id: 505 });
    other.repository.full_name = 'evil/other';
    expect((await send(other)).body.result).toBe('ignored');
    expect(await h.github.store.getJob(505)).toBeNull();
    expect((await send({ zen: 'ok' }, 'ping')).body.result).toBe('pong');
    expect((await send({}, 'star')).body.result).toBe('ignored');
  });

  test('a workflow_run asks the poller to run now', async () => {
    const reply = await send(
      { action: 'completed', workflow_run: { id: 1 } },
      'workflow_run'
    );
    expect(reply.body.result).toBe('sync-requested');
  });

  test('refuses malformed JSON and an oversized body', async () => {
    const broken = await send('{not json');
    expect(broken.status).toBe(400);
    const huge = await send(JSON.stringify({ blob: 'x'.repeat(70 * 1024) }));
    expect(huge.status).toBe(413);
  });

  test('requires a delivery id', async () => {
    const body = JSON.stringify(workflowJob({ id: 506 }));
    const reply = await h.call('POST', '/v1/github/webhook', {
      body,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'workflow_job',
      },
    });
    expect(reply.status).toBe(400);
  });

  test('does not exist without a webhook secret', async () => {
    const quiet = await createGithubHarness({ webhook: false });
    try {
      const reply = await quiet.call('POST', '/v1/github/webhook', {
        body: '{}',
      });
      expect(reply.status).toBe(404);
    } finally {
      await quiet.close();
    }
  });
});
