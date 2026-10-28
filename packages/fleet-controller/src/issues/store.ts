import type { IssueKind, IssueLink, IssueReport, IssueStatus } from './types';

export interface NewReport {
  readonly id: string;
  readonly fingerprint: string;
  readonly kind: IssueKind;
  readonly nodeId: string | null;
  readonly title: string;
  readonly body: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
  /** Who asked, as the audit log names them. Never rendered into a body. */
  readonly createdBy: string;
  readonly now: Date;
}

export interface ReportQuery {
  readonly nodeId?: string;
  readonly status?: IssueStatus;
  /** Only reports created before this one, for paging (newest first). */
  readonly before?: { readonly createdAt: Date; readonly id: string };
  readonly limit: number;
}

export type QueueResult =
  /** Draft or failed became queued. */
  | { readonly outcome: 'queued'; readonly report: IssueReport }
  /** Another report with this fingerprint is already queued or created. */
  | { readonly outcome: 'conflict'; readonly open: IssueReport }
  /** The report is gone or no longer a draft or failed one. */
  | { readonly outcome: 'unavailable'; readonly report: IssueReport | null };

/** Storage for issue reports (`issue_reports`): SQLite and an in-memory twin. */
export interface IssueStore {
  /**
   * One draft per fingerprint: an existing draft is refreshed in place (same id),
   * so repeated previews do not pile up rows.
   */
  saveDraft(input: NewReport): Promise<IssueReport>;
  get(id: string): Promise<IssueReport | null>;
  list(query: ReportQuery): Promise<readonly IssueReport[]>;
  /** The report that is queued or created for this fingerprint, if any. */
  findOpen(fingerprint: string): Promise<IssueReport | null>;
  /**
   * Draft or failed to queued, atomically. The partial unique index on open
   * fingerprints decides a race: the loser gets `conflict`.
   */
  queue(id: string, now: Date): Promise<QueueResult>;
  /**
   * Starts one delivery attempt: only a queued report that is due, and it
   * leaves `nextAttemptAt` at `leaseUntil` so a crash cannot cause a hot loop.
   * Increments `attempts`. Null when another attempt holds it or it is not due.
   */
  claim(id: string, now: Date, leaseUntil: Date): Promise<IssueReport | null>;
  /** Queued reports whose next attempt is due (or never scheduled), oldest first. */
  due(now: Date, limit: number): Promise<readonly IssueReport[]>;
  markCreated(
    id: string,
    number: number,
    url: string,
    now: Date
  ): Promise<void>;
  markRetry(
    id: string,
    nextAttemptAt: Date,
    error: string,
    now: Date
  ): Promise<void>;
  markFailed(id: string, error: string, now: Date): Promise<void>;
  /** This report repeats `of`: it takes `of`'s link and leaves the open slot to it. */
  markDuplicate(id: string, of: IssueReport, now: Date): Promise<void>;
  /** `of` is no longer the open report for its fingerprint (closed on GitHub). */
  retire(id: string, reason: string, now: Date): Promise<void>;
  /** Counts a recurrence on the open report; `commented` stamps the daily comment. */
  touchRecurrence(id: string, now: Date, commented: boolean): Promise<void>;
  /** Open (queued or created) reports for a node, newest first. */
  linksForNode(nodeId: string): Promise<readonly IssueLink[]>;
  /** Open reports that name one of these events. */
  linksForEvents(
    eventIds: readonly number[]
  ): Promise<ReadonlyMap<number, IssueLink>>;
}

export const OPEN_STATUSES: readonly IssueStatus[] = ['queued', 'created'];

export function linkOf(report: IssueReport): IssueLink {
  return {
    id: report.id,
    status: report.status,
    number: report.githubIssueNumber,
    url: report.githubIssueUrl,
  };
}

/** The event id a snapshot was made for, if any. */
export function eventIdOf(
  snapshot: Readonly<Record<string, unknown>>
): number | null {
  const target = snapshot['target'];
  if (typeof target !== 'object' || target === null) return null;
  const id = (target as Record<string, unknown>)['eventId'];
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}
