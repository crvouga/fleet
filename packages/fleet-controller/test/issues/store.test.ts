import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../src/db/client';
import { SqliteIssueStore } from '../../src/db/issue-store';
import { MemoryIssueStore } from '../../src/issues/memory-store';
import type { IssueStore, NewReport } from '../../src/issues/store';

const directory = mkdtempSync(join(tmpdir(), 'fleet-issues-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const T = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, seconds));
const NODE = 'ab'.repeat(32);

function report(id: string, extra: Partial<NewReport> = {}): NewReport {
  return {
    id,
    fingerprint: 'f'.repeat(32),
    kind: 'node',
    nodeId: null,
    title: `title ${id}`,
    body: `body ${id}`,
    snapshot: { target: { eventId: 5 } },
    correlationId: null,
    createdBy: 'tester',
    now: T(0),
    ...extra,
  };
}

const IMPLEMENTATIONS: readonly [string, () => Promise<IssueStore>][] = [
  ['memory', async () => new MemoryIssueStore()],
  [
    'sqlite',
    async () =>
      new SqliteIssueStore(
        await createDb({ path: join(directory, `${crypto.randomUUID()}.db`) })
      ),
  ],
];

for (const [name, make] of IMPLEMENTATIONS) {
  describe(`issue store (${name})`, () => {
    test('one draft per fingerprint: a second preview refreshes it in place', async () => {
      const store = await make();
      const first = await store.saveDraft(report('a'));
      const again = await store.saveDraft(
        report('b', { title: 'newer', now: T(5) })
      );
      expect(again.id).toBe(first.id);
      expect(again).toMatchObject({ title: 'newer', status: 'draft' });
      expect(await store.list({ limit: 10 })).toHaveLength(1);
      expect(
        (await store.saveDraft(report('c', { fingerprint: 'e'.repeat(32) }))).id
      ).toBe('c');
    });

    test('queue is atomic and the open fingerprint is unique', async () => {
      const store = await make();
      await store.saveDraft(report('a'));
      expect((await store.queue('a', T(1))).outcome).toBe('queued');
      expect((await store.queue('a', T(2))).outcome).toBe('unavailable');
      await store.markFailed('a', 'nope', T(3));
      await store.saveDraft(report('b'));
      expect((await store.queue('b', T(4))).outcome).toBe('queued');
      const conflict = await store.queue('a', T(5));
      expect(conflict.outcome).toBe('conflict');
      expect(conflict.outcome === 'conflict' && conflict.open.id).toBe('b');
      expect((await store.findOpen('f'.repeat(32)))?.id).toBe('b');
      expect((await store.queue('missing', T(6))).outcome).toBe('unavailable');
    });

    test('claim starts one attempt, leases it, and only when due', async () => {
      const store = await make();
      await store.saveDraft(report('a'));
      await store.queue('a', T(0));
      expect(await store.claim('a', T(1), T(11))).toMatchObject({
        attempts: 1,
        nextAttemptAt: T(11),
      });
      expect(await store.claim('a', T(2), T(12))).toBeNull();
      expect(await store.due(T(5), 10)).toHaveLength(0);
      expect((await store.due(T(11), 10)).map((r) => r.id)).toEqual(['a']);
      await store.markRetry('a', T(60), 'HTTP 503', T(12));
      expect(await store.claim('a', T(30), T(40))).toBeNull();
      expect(await store.claim('a', T(60), T(70))).toMatchObject({
        attempts: 2,
      });
      expect(await store.claim('missing', T(60), T(70))).toBeNull();
    });

    test('created, failed, duplicate and retired states', async () => {
      const store = await make();
      await store.saveDraft(report('a'));
      await store.queue('a', T(0));
      await store.markCreated('a', 7, 'https://github.com/o/r/issues/7', T(1));
      expect(await store.get('a')).toMatchObject({
        status: 'created',
        githubIssueNumber: 7,
        lastError: null,
        nextAttemptAt: null,
      });
      await store.saveDraft(report('b'));
      const open = (await store.findOpen('f'.repeat(32)))!;
      await store.markDuplicate('b', open, T(2));
      expect(await store.get('b')).toMatchObject({
        status: 'duplicate',
        githubIssueNumber: 7,
      });
      await store.retire('a', 'closed', T(3));
      expect(await store.findOpen('f'.repeat(32))).toBeNull();
      expect(await store.get('a')).toMatchObject({
        status: 'duplicate',
        lastError: 'closed',
      });
    });

    test('recurrence counts and stamps the daily comment', async () => {
      const store = await make();
      await store.saveDraft(report('a'));
      await store.queue('a', T(0));
      await store.markCreated('a', 1, 'u', T(1));
      await store.touchRecurrence('a', T(10), true);
      await store.touchRecurrence('a', T(20), false);
      expect((await store.get('a'))!.snapshot['recurrence']).toEqual({
        count: 2,
        lastCommentAt: T(10).toISOString(),
      });
    });

    test('links for a node and for the events a report names; closed or failed ones do not show', async () => {
      const store = await make();
      await store.saveDraft(report('a', { nodeId: NODE }));
      await store.queue('a', T(0));
      await store.markCreated('a', 3, 'https://github.com/o/r/issues/3', T(1));
      await store.saveDraft(
        report('x', {
          fingerprint: 'd'.repeat(32),
          nodeId: NODE,
          snapshot: { target: { eventId: 9 } },
        })
      );
      expect((await store.linksForNode(NODE)).map((l) => l.number)).toEqual([
        3,
      ]);
      const events = await store.linksForEvents([5, 9, 11]);
      expect([...events.keys()]).toEqual([5]);
      expect(events.get(5)).toMatchObject({
        id: 'a',
        number: 3,
        status: 'created',
      });
      expect((await store.linksForEvents([])).size).toBe(0);
    });

    test('lists newest first with a cursor and filters', async () => {
      const store = await make();
      for (const [i, id] of ['a', 'b', 'c'].entries())
        await store.saveDraft(
          report(id, {
            fingerprint: String(i).repeat(32),
            nodeId: i === 0 ? NODE : null,
            now: T(i),
          })
        );
      const page = await store.list({ limit: 2 });
      expect(page.map((r) => r.id)).toEqual(['c', 'b']);
      const next = await store.list({
        limit: 2,
        before: { createdAt: page[1]!.createdAt, id: page[1]!.id },
      });
      expect(next.map((r) => r.id)).toEqual(['a']);
      expect(
        (await store.list({ limit: 5, nodeId: NODE })).map((r) => r.id)
      ).toEqual(['a']);
      expect(await store.list({ limit: 5, status: 'queued' })).toEqual([]);
    });
  });
}

describe('the database enforces what the app relies on', () => {
  test('two open reports for one fingerprint are impossible even by direct insert', async () => {
    const db = await createDb({ path: join(directory, 'index.db') });
    const insert = (id: string, status: string) =>
      db`insert into issue_reports (id, fingerprint, kind, status, title, body, created_by)
         values (${id}, ${'9'.repeat(32)}, 'node', ${status}, 't', 'b', 'x')`;
    await insert('one', 'created');
    await expect(insert('two', 'queued')).rejects.toThrow(/UNIQUE/);
    await insert('three', 'failed');
    await insert('four', 'duplicate');
    await insert('five', 'draft');
    await expect(insert('six', 'bogus')).rejects.toThrow();
    await db.close();
  });
});
