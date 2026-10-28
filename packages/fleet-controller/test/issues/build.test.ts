import { afterEach, describe, expect, test } from 'bun:test';

import { buildDraft } from '../../src/issues/build';
import type { IssueTarget } from '../../src/issues/types';

import { recordControllerError, REQUEST_ID, seedEvents, withJob } from './seed';
import { IDS, issueHarness, type IssueHarness } from './support';

let current: IssueHarness | null = null;
afterEach(() => current?.api.stop());

async function harness(): Promise<IssueHarness> {
  current = await issueHarness();
  return current;
}

async function draftFor(h: IssueHarness, target: IssueTarget, limit?: number) {
  const built = await buildDraft(h.deps, target, {
    literals: [],
    ...(limit === undefined ? {} : { limit }),
  });
  if (!built.ok) throw new Error(built.error);
  return built.draft;
}

const SECTIONS = [
  '## Summary',
  '## Classification',
  '## Environment and versions',
  '## Desired vs observed',
  '## Timeline',
  '## Logs and errors',
  '## Actions already attempted',
  '## Reproduction',
  '## Suspected area (where to look in the repo)',
  '## Acceptance criteria',
  '## Diagnostics (JSON)',
  '## Fingerprint',
];

function expectSections(body: string): void {
  let from = 0;
  for (const heading of SECTIONS) {
    const at = body.indexOf(heading, from);
    expect(at, `${heading} is present and in order`).toBeGreaterThanOrEqual(
      from
    );
    from = at;
  }
}

describe('a node report', () => {
  test('has every section, identifiers, versions, desired vs observed and the failure', async () => {
    const h = await harness();
    const events = await seedEvents(h);
    const draft = await draftFor(h, {
      kind: 'node',
      nodeId: IDS.rolledBack,
      eventId: events.rollback,
    });
    expectSections(draft.body);
    expect(draft.classification).toMatchObject({
      code: 'rollback',
      component: 'fleet-sync',
    });
    expect(draft.title).toMatch(/^\[Fleet node\] Node rolled back/);
    expect(draft.body).toContain('runner never became healthy');
    expect(draft.body).toContain('controllerVersion');
    expect(draft.body).toContain('controllerCommit');
    expect(draft.body).toContain('desiredRevision');
    expect(draft.body).toContain('cpuModel');
    expect(draft.body).toContain('packages/fleet/scripts/fleet-sync.sh');
    expect(draft.body).toContain(
      'fleet-issue-fingerprint:' + draft.fingerprint
    );
    expect(draft.body.length).toBeLessThan(65_536);
    expect(draft.snapshot.target.eventId).toBe(events.rollback);
    expect(draft.nodeId).toBe(IDS.rolledBack);
  });

  test('the reproduction lists the events before the failure, or says it is not available', async () => {
    const h = await harness();
    const events = await seedEvents(h);
    const withEvent = await draftFor(h, {
      kind: 'node',
      nodeId: IDS.rolledBack,
      eventId: events.rollback,
    });
    expect(withEvent.snapshot.reproduction?.[0]).toContain(
      'updated from 7a1b3c4 to 9f3c2a1'
    );
    const without = await draftFor(h, { kind: 'node', nodeId: IDS.rolledBack });
    expect(without.snapshot.reproduction).toBeNull();
    expect(without.body).toContain('## Reproduction\n\nNot available.');
  });

  test('actions already attempted come from operations and audit, with roles and no emails', async () => {
    const h = await harness();
    await h.deps.store.audit({
      actor: 'chris@example.test',
      actorRole: 'admin',
      action: 'node.restart',
      targetKind: 'node',
      targetId: IDS.rolledBack,
      requestId: REQUEST_ID,
    });
    await h.deps.store.operations.create(
      {
        id: 'op-1',
        kind: 'drain',
        nodeId: IDS.rolledBack,
        requestedBy: 'chris@example.test',
        requestedAt: h.now(),
        progress: 'waiting for jobs',
        idempotencyKey: null,
        detail: {},
      },
      []
    );
    const draft = await draftFor(h, { kind: 'node', nodeId: IDS.rolledBack });
    expect(draft.body).toContain('node.restart');
    expect(draft.body).toContain('by admin');
    expect(draft.body).toContain('waiting for jobs');
    expect(draft.body).not.toContain('chris@example.test');
    expect(JSON.stringify(draft.snapshot)).not.toContain('chris@example.test');
    expect(draft.snapshot.correlation['auditRequestIds']).toEqual([REQUEST_ID]);
  });

  test('refuses a node that does not exist instead of describing nothing', async () => {
    const h = await harness();
    const built = await buildDraft(h.deps, {
      kind: 'node',
      nodeId: 'ab'.repeat(32),
    });
    expect(built).toEqual({ ok: false, error: 'No such node.' });
    const event = await buildDraft(h.deps, { kind: 'node', eventId: 9999 });
    expect(event).toEqual({ ok: false, error: 'No such event.' });
  });
});

describe('an installer report', () => {
  test('lists the failed installer steps from the node events', async () => {
    const h = await harness();
    const events = await seedEvents(h);
    const draft = await draftFor(h, {
      kind: 'installer',
      nodeId: IDS.pending,
      eventId: events.installer,
    });
    expectSections(draft.body);
    expect(draft.classification.component).toBe('installer');
    expect(draft.snapshot.testFailures[0]).toMatchObject({ kind: 'install' });
    expect(draft.body).toContain('packages/fleet/wizard/diagnostics.py');
  });
});

describe('a controller report', () => {
  test('carries the request id, trace id and the recorded error with its stack', async () => {
    const h = await harness();
    recordControllerError(
      h,
      new TypeError('cannot read property of undefined')
    );
    const draft = await draftFor(h, {
      kind: 'controller',
      requestId: REQUEST_ID,
    });
    expectSections(draft.body);
    expect(draft.classification.code).toBe('controller-error');
    expect(draft.body).toContain(REQUEST_ID);
    expect(draft.body).toContain(REQUEST_ID.replaceAll('-', ''));
    expect(draft.body).toContain(
      'TypeError: cannot read property of undefined'
    );
    expect(draft.correlationId).toBe(REQUEST_ID);
    expect(draft.body).toContain('No node is attached');
  });

  test('a request id the controller no longer remembers still builds, with the id and a gap', async () => {
    const h = await harness();
    const draft = await draftFor(h, {
      kind: 'controller',
      requestId: 'aaaaaaaa-0000-4000-8000-000000000000',
    });
    expect(draft.body).toContain('aaaaaaaa-0000-4000-8000-000000000000');
    expect(draft.body).toContain('No error message was recorded');
  });
});

describe('a workload report', () => {
  test('names the job, run, repository, runner, node and the other failed jobs', async () => {
    const h = await harness();
    withJob(h);
    const draft = await draftFor(h, { kind: 'workload', jobId: 77 });
    expectSections(draft.body);
    expect(draft.classification.code).toBe('ci-job-failed');
    expect(draft.body).toContain('acme/app');
    expect(draft.body).toContain('unit tests');
    expect(draft.body).toContain('"runId": 9');
    expect(draft.snapshot.testFailures[0]).toMatchObject({
      jobId: 77,
      isTarget: true,
    });
    expect(draft.body).toContain('packages/fleet/scripts/runner_job.py');
    expect(draft.nodeId).toBe(IDS.online);
  });

  test('an unknown job is refused', async () => {
    const h = await harness();
    withJob(h);
    expect(
      await buildDraft(h.deps, { kind: 'workload', jobId: 12345 })
    ).toEqual({ ok: false, error: 'No such job.' });
  });
});

describe('size limit', () => {
  test("a huge report is cut to GitHub's limit, largest sections first, with markers", async () => {
    const h = await harness();
    const events = await seedEvents(h);
    for (let i = 0; i < 400; i += 1)
      await h.deps.store.addEvent({
        nodeId: IDS.rolledBack,
        nodeLabel: 'n',
        kind: 'noise',
        severity: 'warn',
        message: `line ${i} ${'x'.repeat(400)}`,
      });
    const draft = await draftFor(
      h,
      { kind: 'node', nodeId: IDS.rolledBack, eventId: events.rollback },
      20_000
    );
    expect(draft.body.length).toBeLessThanOrEqual(20_000);
    expect(draft.truncated.length).toBeGreaterThan(0);
    expect(draft.body).toMatch(/\[truncated \d+ lines\]/);
    expectSections(draft.body);
    expect(() =>
      JSON.parse(
        /```json\n([\s\S]*?)\n```\n\n## Fingerprint/.exec(
          draft.body.slice(draft.body.indexOf('## Diagnostics (JSON)'))
        )![1]!
      )
    ).not.toThrow();
  });

  test('the default limit stays under 65,536 characters even for enormous inputs', async () => {
    const h = await harness();
    for (let i = 0; i < 300; i += 1)
      await h.deps.store.addEvent({
        nodeId: IDS.rolledBack,
        nodeLabel: 'n',
        kind: 'noise',
        severity: 'warn',
        message: 'y'.repeat(5000),
      });
    const draft = await draftFor(h, { kind: 'node', nodeId: IDS.rolledBack });
    expect(draft.body.length).toBeLessThan(65_536);
  });
});

describe('fingerprints', () => {
  test('the same failure with different ids, numbers and times has one fingerprint', async () => {
    const h = await harness();
    const add = (message: string) =>
      h.deps.store.addEvent({
        nodeId: IDS.online,
        nodeLabel: 'n',
        kind: 'reconcile_blocked',
        severity: 'warn',
        message,
      });
    await add(
      `FLEET_SECRETS_RECIPIENT_MISSING: age1${'a'.repeat(58)} is not a recipient of secrets/fleet.yaml at 9f3c2a1`
    );
    await add(
      `FLEET_SECRETS_RECIPIENT_MISSING: age1${'b'.repeat(58)} is not a recipient of secrets/fleet.yaml at 1234abc`
    );
    const [second, first] = await h.deps.store.listEvents({ limit: 2 });
    const a = await draftFor(h, {
      kind: 'node',
      nodeId: IDS.online,
      eventId: first!.id,
    });
    const b = await draftFor(h, {
      kind: 'node',
      nodeId: IDS.online,
      eventId: second!.id,
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test('a different failure, kind or role has a different fingerprint', async () => {
    const h = await harness();
    const events = await seedEvents(h);
    const rollback = await draftFor(h, {
      kind: 'node',
      nodeId: IDS.rolledBack,
      eventId: events.rollback,
    });
    const blocked = await draftFor(h, {
      kind: 'node',
      nodeId: IDS.online,
      eventId: events.blocked,
    });
    expect(rollback.fingerprint).not.toBe(blocked.fingerprint);
    expect(rollback.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});
