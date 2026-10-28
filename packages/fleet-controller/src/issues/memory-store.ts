import {
  eventIdOf,
  linkOf,
  OPEN_STATUSES,
  type IssueStore,
  type NewReport,
  type QueueResult,
  type ReportQuery,
} from './store';
import type { IssueLink, IssueReport } from './types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Entry = Mutable<IssueReport>;

/** In-memory twin of SqliteIssueStore, including the open-fingerprint uniqueness rule. */
export class MemoryIssueStore implements IssueStore {
  private readonly rows = new Map<string, Entry>();

  private copy(entry: Entry): IssueReport {
    return { ...entry, snapshot: structuredClone(entry.snapshot) };
  }

  private openFor(fingerprint: string, except?: string): Entry | undefined {
    return [...this.rows.values()].find(
      (row) =>
        row.fingerprint === fingerprint &&
        row.id !== except &&
        OPEN_STATUSES.includes(row.status)
    );
  }

  async saveDraft(input: NewReport): Promise<IssueReport> {
    const existing = [...this.rows.values()].find(
      (row) => row.fingerprint === input.fingerprint && row.status === 'draft'
    );
    const entry: Entry = existing ?? {
      id: input.id,
      fingerprint: input.fingerprint,
      kind: input.kind,
      nodeId: input.nodeId,
      status: 'draft',
      title: '',
      body: '',
      snapshot: {},
      correlationId: null,
      githubIssueNumber: null,
      githubIssueUrl: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
    Object.assign(entry, {
      title: input.title,
      body: input.body,
      snapshot: structuredClone(input.snapshot),
      correlationId: input.correlationId,
      nodeId: input.nodeId,
      updatedAt: input.now,
    });
    this.rows.set(entry.id, entry);
    return this.copy(entry);
  }

  async get(id: string): Promise<IssueReport | null> {
    const entry = this.rows.get(id);
    return entry === undefined ? null : this.copy(entry);
  }

  async list(query: ReportQuery): Promise<readonly IssueReport[]> {
    const before = query.before;
    return [...this.rows.values()]
      .filter(
        (row) => query.nodeId === undefined || row.nodeId === query.nodeId
      )
      .filter(
        (row) => query.status === undefined || row.status === query.status
      )
      .filter(
        (row) =>
          before === undefined ||
          row.createdAt.getTime() < before.createdAt.getTime() ||
          (row.createdAt.getTime() === before.createdAt.getTime() &&
            row.id < before.id)
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : -1)
      )
      .slice(0, query.limit)
      .map((row) => this.copy(row));
  }

  async findOpen(fingerprint: string): Promise<IssueReport | null> {
    const entry = this.openFor(fingerprint);
    return entry === undefined ? null : this.copy(entry);
  }

  async queue(id: string, now: Date): Promise<QueueResult> {
    const entry = this.rows.get(id);
    if (
      entry === undefined ||
      (entry.status !== 'draft' && entry.status !== 'failed')
    )
      return {
        outcome: 'unavailable',
        report: entry === undefined ? null : this.copy(entry),
      };
    const open = this.openFor(entry.fingerprint, id);
    if (open !== undefined)
      return { outcome: 'conflict', open: this.copy(open) };
    Object.assign(entry, {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: now,
    });
    return { outcome: 'queued', report: this.copy(entry) };
  }

  async claim(
    id: string,
    now: Date,
    leaseUntil: Date
  ): Promise<IssueReport | null> {
    const entry = this.rows.get(id);
    if (entry === undefined || entry.status !== 'queued') return null;
    if (
      entry.nextAttemptAt !== null &&
      entry.nextAttemptAt.getTime() > now.getTime()
    )
      return null;
    Object.assign(entry, {
      attempts: entry.attempts + 1,
      nextAttemptAt: leaseUntil,
      updatedAt: now,
    });
    return this.copy(entry);
  }

  async due(now: Date, limit: number): Promise<readonly IssueReport[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'queued')
      .filter(
        (row) =>
          row.nextAttemptAt === null ||
          row.nextAttemptAt.getTime() <= now.getTime()
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((row) => this.copy(row));
  }

  private update(id: string, patch: Partial<Entry>): void {
    const entry = this.rows.get(id);
    if (entry !== undefined) Object.assign(entry, patch);
  }

  async markCreated(
    id: string,
    number: number,
    url: string,
    now: Date
  ): Promise<void> {
    this.update(id, {
      status: 'created',
      githubIssueNumber: number,
      githubIssueUrl: url,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: now,
    });
  }

  async markRetry(
    id: string,
    nextAttemptAt: Date,
    error: string,
    now: Date
  ): Promise<void> {
    this.update(id, { nextAttemptAt, lastError: error, updatedAt: now });
  }

  async markFailed(id: string, error: string, now: Date): Promise<void> {
    this.update(id, {
      status: 'failed',
      nextAttemptAt: null,
      lastError: error,
      updatedAt: now,
    });
  }

  async markDuplicate(id: string, of: IssueReport, now: Date): Promise<void> {
    this.update(id, {
      status: 'duplicate',
      githubIssueNumber: of.githubIssueNumber,
      githubIssueUrl: of.githubIssueUrl,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: now,
    });
  }

  async retire(id: string, reason: string, now: Date): Promise<void> {
    this.update(id, {
      status: 'duplicate',
      nextAttemptAt: null,
      lastError: reason,
      updatedAt: now,
    });
  }

  async touchRecurrence(
    id: string,
    now: Date,
    commented: boolean
  ): Promise<void> {
    const entry = this.rows.get(id);
    if (entry === undefined) return;
    const previous = entry.snapshot['recurrence'] as
      { count?: number; lastCommentAt?: string } | undefined;
    entry.snapshot = {
      ...entry.snapshot,
      recurrence: {
        count: (previous?.count ?? 0) + 1,
        lastCommentAt: commented
          ? now.toISOString()
          : (previous?.lastCommentAt ?? null),
      },
    };
  }

  async linksForNode(nodeId: string): Promise<readonly IssueLink[]> {
    return (await this.list({ nodeId, limit: 50 }))
      .filter((row) => OPEN_STATUSES.includes(row.status))
      .map(linkOf);
  }

  async linksForEvents(
    eventIds: readonly number[]
  ): Promise<ReadonlyMap<number, IssueLink>> {
    const wanted = new Set(eventIds);
    const out = new Map<number, IssueLink>();
    for (const row of this.rows.values()) {
      const id = eventIdOf(row.snapshot);
      if (
        id !== null &&
        wanted.has(id) &&
        OPEN_STATUSES.includes(row.status) &&
        !out.has(id)
      )
        out.set(id, linkOf(row));
    }
    return out;
  }
}
