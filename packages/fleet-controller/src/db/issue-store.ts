import type {
  IssueStore,
  NewReport,
  QueueResult,
  ReportQuery,
} from '../issues/store';
import { linkOf } from '../issues/store';
import type { IssueLink, IssueReport } from '../issues/types';

import type { Db } from './client';
import { toIssueReport } from './issue-rows';
import { numberOrNull, text } from './rows';

async function select(db: Db, id: string): Promise<IssueReport | null> {
  const rows = await db`select * from issue_reports where id = ${id}`;
  return rows[0] === undefined ? null : toIssueReport(rows[0]);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}

async function upsertDraft(db: Db, input: NewReport): Promise<void> {
  const snapshot = JSON.stringify(input.snapshot);
  const existing = await db`
    select id from issue_reports where fingerprint = ${input.fingerprint} and status = 'draft'`;
  if (existing[0] !== undefined) {
    await db`
      update issue_reports
      set title = ${input.title}, body = ${input.body}, snapshot = ${snapshot},
          correlation_id = ${input.correlationId}, node_id = ${input.nodeId}, updated_at = ${input.now}
      where id = ${text(existing[0], 'id')}`;
    return;
  }
  await db`
    insert into issue_reports
      (id, fingerprint, kind, node_id, status, title, body, snapshot, correlation_id, created_by, created_at, updated_at)
    values (${input.id}, ${input.fingerprint}, ${input.kind}, ${input.nodeId}, 'draft', ${input.title},
      ${input.body}, ${snapshot}, ${input.correlationId}, ${input.createdBy}, ${input.now}, ${input.now})`;
}

export class SqliteIssueStore implements IssueStore {
  constructor(private readonly db: Db) {}

  async saveDraft(input: NewReport): Promise<IssueReport> {
    await this.db.begin((tx) => upsertDraft(tx, input));
    const rows = await this.db`
      select * from issue_reports where fingerprint = ${input.fingerprint} and status = 'draft'
      order by created_at desc limit 1`;
    if (rows[0] === undefined) throw new Error('issue draft was not stored');
    return toIssueReport(rows[0]);
  }

  get(id: string): Promise<IssueReport | null> {
    return select(this.db, id);
  }

  async list(query: ReportQuery): Promise<readonly IssueReport[]> {
    const node = query.nodeId ?? null;
    const status = query.status ?? null;
    const at = query.before?.createdAt ?? null;
    const id = query.before?.id ?? null;
    const rows = await this.db`
      select * from issue_reports
      where (${node} is null or node_id = ${node})
        and (${status} is null or status = ${status})
        and (${at} is null or created_at < ${at} or (created_at = ${at} and id < ${id}))
      order by created_at desc, id desc limit ${query.limit}`;
    return rows.map(toIssueReport);
  }

  async findOpen(fingerprint: string): Promise<IssueReport | null> {
    const rows = await this.db`
      select * from issue_reports
      where fingerprint = ${fingerprint} and status in ('queued', 'created') limit 1`;
    return rows[0] === undefined ? null : toIssueReport(rows[0]);
  }

  async queue(id: string, now: Date): Promise<QueueResult> {
    try {
      const changed = await this.db`
        update issue_reports
        set status = 'queued', attempts = 0, next_attempt_at = null, last_error = null, updated_at = ${now}
        where id = ${id} and status in ('draft', 'failed')`;
      const report = await select(this.db, id);
      if (changed.count > 0 && report !== null)
        return { outcome: 'queued', report };
      return { outcome: 'unavailable', report };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const report = await select(this.db, id);
      const open =
        report === null ? null : await this.findOpen(report.fingerprint);
      if (open === null) throw error;
      return { outcome: 'conflict', open };
    }
  }

  async claim(
    id: string,
    now: Date,
    leaseUntil: Date
  ): Promise<IssueReport | null> {
    const changed = await this.db`
      update issue_reports
      set attempts = attempts + 1, next_attempt_at = ${leaseUntil}, updated_at = ${now}
      where id = ${id} and status = 'queued'
        and (next_attempt_at is null or next_attempt_at <= ${now})`;
    return changed.count > 0 ? select(this.db, id) : null;
  }

  async due(now: Date, limit: number): Promise<readonly IssueReport[]> {
    const rows = await this.db`
      select * from issue_reports
      where status = 'queued' and (next_attempt_at is null or next_attempt_at <= ${now})
      order by created_at asc limit ${limit}`;
    return rows.map(toIssueReport);
  }

  async markCreated(
    id: string,
    number: number,
    url: string,
    now: Date
  ): Promise<void> {
    await this.db`
      update issue_reports
      set status = 'created', github_issue_number = ${number}, github_issue_url = ${url},
          next_attempt_at = null, last_error = null, updated_at = ${now}
      where id = ${id}`;
  }

  async markRetry(
    id: string,
    nextAttemptAt: Date,
    error: string,
    now: Date
  ): Promise<void> {
    await this.db`
      update issue_reports set next_attempt_at = ${nextAttemptAt}, last_error = ${error}, updated_at = ${now}
      where id = ${id} and status = 'queued'`;
  }

  async markFailed(id: string, error: string, now: Date): Promise<void> {
    await this.db`
      update issue_reports set status = 'failed', next_attempt_at = null, last_error = ${error}, updated_at = ${now}
      where id = ${id}`;
  }

  async markDuplicate(id: string, of: IssueReport, now: Date): Promise<void> {
    await this.db`
      update issue_reports
      set status = 'duplicate', github_issue_number = ${of.githubIssueNumber},
          github_issue_url = ${of.githubIssueUrl}, next_attempt_at = null, last_error = null, updated_at = ${now}
      where id = ${id}`;
  }

  async retire(id: string, reason: string, now: Date): Promise<void> {
    await this.db`
      update issue_reports set status = 'duplicate', next_attempt_at = null, last_error = ${reason}, updated_at = ${now}
      where id = ${id}`;
  }

  async touchRecurrence(
    id: string,
    now: Date,
    commented: boolean
  ): Promise<void> {
    await this.db.begin(async (tx) => {
      const rows = await tx`
        select json_extract(snapshot, '$.recurrence.count') as count,
               json_extract(snapshot, '$.recurrence.lastCommentAt') as last
        from issue_reports where id = ${id}`;
      const row = rows[0];
      if (row === undefined) return;
      const last = typeof row['last'] === 'string' ? row['last'] : null;
      const recurrence = JSON.stringify({
        count: (numberOrNull(row, 'count') ?? 0) + 1,
        lastCommentAt: commented ? now.toISOString() : last,
      });
      await tx`update issue_reports set snapshot = json_set(snapshot, '$.recurrence', json(${recurrence})) where id = ${id}`;
    });
  }

  async linksForNode(nodeId: string): Promise<readonly IssueLink[]> {
    const rows = await this.db`
      select * from issue_reports
      where node_id = ${nodeId} and status in ('queued', 'created')
      order by created_at desc, id desc limit 50`;
    return rows.map((row) => linkOf(toIssueReport(row)));
  }

  async linksForEvents(
    eventIds: readonly number[]
  ): Promise<ReadonlyMap<number, IssueLink>> {
    const out = new Map<number, IssueLink>();
    if (eventIds.length === 0) return out;
    const rows = await this.db`
      select *, json_extract(snapshot, '$.target.eventId') as event_id from issue_reports
      where status in ('queued', 'created')
        and json_extract(snapshot, '$.target.eventId') in (select value from json_each(${JSON.stringify(eventIds)}))
      order by created_at desc, id desc`;
    for (const row of rows) {
      const eventId = numberOrNull(row, 'event_id');
      if (eventId !== null && !out.has(eventId))
        out.set(eventId, linkOf(toIssueReport(row)));
    }
    return out;
  }
}
