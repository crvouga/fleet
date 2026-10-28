import { afterEach, describe, expect, test } from 'bun:test';

import { buildDraft } from '../../src/issues/build';
import { ADMIN_TOKEN } from '../support/controller';

import { recordControllerError, seedEvents } from './seed';
import {
  between,
  CONTEXTS,
  opaque,
  SECRET_SHAPES,
  seeded,
  type Secret,
} from './secrets';
import { IDS, issueHarness, request, type IssueHarness } from './support';

let current: IssueHarness | null = null;
afterEach(() => current?.api.stop());

const WEBHOOK_SECRET = 'webhook-secret-for-tests-0123456789';

/** Every known secret shape, planted in every place the builder reads. */
async function plant(h: IssueHarness, seed: number): Promise<Secret[]> {
  const rnd = seeded(seed);
  const secrets = SECRET_SHAPES.map((make) => make(rnd));
  const wrap = (secret: Secret) =>
    CONTEXTS[between(rnd, 0, CONTEXTS.length - 1)]!(secret.text);
  const keyed = [
    'password',
    'FLEET_ADMIN_TOKEN',
    'apiKey',
    'wifi_psk',
    'secretHash',
  ].map((key) => ({
    name: key,
    text: `${key}=${opaque(rnd)}`,
    core: opaque(rnd),
  }));
  keyed.forEach((entry) => {
    entry.core = entry.text.slice(entry.text.indexOf('=') + 1);
  });
  const all = [...secrets, ...keyed];
  const store = h.deps.store;
  for (const secret of all) {
    await store.addEvent({
      nodeId: IDS.rolledBack,
      nodeLabel: 'n',
      kind: 'rollback',
      severity: 'error',
      message: `rolled back: ${wrap(secret)}`,
      data: { detail: secret.text, token: secret.core },
    });
  }
  const node = await store.findNode(IDS.rolledBack);
  store.updateSeeded(IDS.rolledBack, {
    reconcile: { phase: 'blocked', issues: all.slice(0, 8).map(wrap) },
    facts: {
      ...node!.facts,
      sync: { rolledBack: true, healthFailure: wrap(all[0]!), paused: false },
      failedUnits: all.slice(0, 3).map((s) => `${s.text}.service`),
    },
    note: all[1]!.text,
    displayName: 'rack-1',
  });
  await store.operations.create(
    {
      id: 'op-canary',
      kind: 'drain',
      nodeId: IDS.rolledBack,
      requestedBy: 'someone@example.test',
      requestedAt: h.now(),
      progress: wrap(all[2]!),
      idempotencyKey: null,
      detail: {},
    },
    []
  );
  await store.putSettings(
    'fleet',
    {
      alerts: {
        webhookUrl: `https://hooks.example.test/${all[3]!.core}/path?token=${all[4]!.core}`,
      },
    },
    'tester'
  );
  return all;
}

function expectNoSecret(
  label: string,
  text: string,
  secrets: readonly Secret[],
  extra: readonly string[]
): void {
  for (const secret of secrets)
    expect(text, `${label} leaked ${secret.name}`).not.toContain(secret.core);
  for (const value of extra)
    expect(text, `${label} leaked a configured secret`).not.toContain(value);
}

describe('canary: no known secret shape survives the whole pipeline', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: title, body, snapshot, stored draft, JSON and HTML`, async () => {
      const h = await issueHarness();
      current = h;
      const secrets = await plant(h, seed);
      const events = await seedEvents(h);
      const configured = [ADMIN_TOKEN, h.api.token, WEBHOOK_SECRET];
      Object.assign(h.deps.env, {
        adminToken: ADMIN_TOKEN,
        github: { webhookSecret: WEBHOOK_SECRET, apiUrl: 'x' },
      });
      await h.deps.store.addEvent({
        nodeId: IDS.rolledBack,
        nodeLabel: 'n',
        kind: 'rollback',
        severity: 'error',
        message: `leak ${ADMIN_TOKEN} and ${h.api.token} and ${WEBHOOK_SECRET}`,
      });
      const built = await buildDraft(
        h.deps,
        { kind: 'node', nodeId: IDS.rolledBack, eventId: events.rollback },
        {
          literals: configured,
        }
      );
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const { draft } = built;
      expectNoSecret('title', draft.title, secrets, configured);
      expectNoSecret('body', draft.body, secrets, configured);
      expectNoSecret(
        'snapshot',
        JSON.stringify(draft.snapshot),
        secrets,
        configured
      );
      expect(draft.redaction.length).toBeGreaterThan(0);

      const reply = await request(h, 'POST', '/v1/issues/preview', {
        json: { kind: 'node', node: IDS.rolledBack },
      });
      const text = await reply.text();
      expectNoSecret('preview JSON', text, secrets, configured);
      const stored = await h.memory.list({ limit: 10 });
      expect(stored.length).toBe(1);
      expectNoSecret(
        'stored draft',
        JSON.stringify(stored),
        secrets,
        configured
      );

      const page = await request(
        h,
        'GET',
        `/report-issue?kind=node&node=${IDS.rolledBack}`
      );
      expectNoSecret('HTML page', await page.text(), secrets, configured);
    });
  }

  test('a controller error that carries secrets in its message and stack never reaches the report', async () => {
    const h = await issueHarness();
    current = h;
    const rnd = seeded(99);
    const secrets = SECRET_SHAPES.map((make) => make(rnd));
    const error = new Error(
      `db failed: ${secrets.map((s) => s.text).join(' | ')} password=hunter2-hunter2`
    );
    error.stack = `Error: x\n    at ${secrets[0]!.text} (file.ts:1:1)\n    at fn (/app/${secrets[1]!.text}.ts:2:2)`;
    recordControllerError(h, error);
    const reply = await request(h, 'POST', '/v1/issues/preview', {
      json: {
        kind: 'controller',
        request: '6f1c7a8e-1111-4222-8333-944455556666',
      },
    });
    const text = await reply.text();
    expectNoSecret('controller report', text, secrets, ['hunter2-hunter2']);
    expect(text).toContain('db failed');
  });

  test('the full node id never appears; its short form does', async () => {
    const h = await issueHarness();
    current = h;
    const events = await seedEvents(h);
    const built = await buildDraft(h.deps, {
      kind: 'node',
      nodeId: IDS.rolledBack,
      eventId: events.rollback,
    });
    if (!built.ok) throw new Error(built.error);
    expect(built.draft.body).not.toContain(IDS.rolledBack);
    expect(built.draft.body).toContain(`node:${IDS.rolledBack.slice(0, 12)}`);
    expect(built.draft.nodeId).toBe(IDS.rolledBack);
  });

  test('actor emails never appear, even when an event message names them', async () => {
    const h = await issueHarness();
    current = h;
    await h.deps.store.addEvent({
      nodeId: IDS.rolledBack,
      nodeLabel: 'n',
      kind: 'rollback',
      severity: 'error',
      message: 'approved by someone@example.test then rolled back',
    });
    const built = await buildDraft(h.deps, {
      kind: 'node',
      nodeId: IDS.rolledBack,
    });
    if (!built.ok) throw new Error(built.error);
    expect(built.draft.body).not.toContain('someone@example.test');
    expect(built.draft.redaction.some((hit) => hit.class === 'email')).toBe(
      true
    );
  });
});
