/**
 * Vocabulary of one-click issue reporting: what a report is about, what the
 * controller gathered, and how a stored report moves through its states.
 * Nothing here performs I/O. See docs/issue-reporting.md.
 */

export const ISSUE_KINDS = [
  'installer',
  'node',
  'controller',
  'workload',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export function isIssueKind(value: unknown): value is IssueKind {
  return (
    typeof value === 'string' &&
    (ISSUE_KINDS as readonly string[]).includes(value)
  );
}

/** What a person points at. Everything except `kind` is optional and combinable. */
export interface IssueTarget {
  readonly kind: IssueKind;
  readonly nodeId?: string;
  readonly eventId?: number;
  readonly jobId?: number;
  readonly operationId?: string;
  /** An X-Request-ID the controller answered with. */
  readonly requestId?: string;
}

export const ISSUE_STATUSES = [
  'draft',
  'queued',
  'created',
  'failed',
  'duplicate',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Why this report is what it is: a stable code, the component at fault and one sentence. */
export interface Classification {
  readonly code: string;
  readonly component: string;
  readonly summary: string;
}

export interface TimelineEntry {
  readonly at: string;
  readonly source: 'event' | 'operation' | 'audit' | 'desired' | 'job';
  readonly kind: string;
  readonly severity?: string;
  readonly message: string;
}

export interface LogLine {
  readonly at: string | null;
  readonly source: string;
  readonly level: string;
  readonly message: string;
}

/**
 * Everything the controller knew when the report was made. Plain JSON, bounded,
 * and (once built) already redacted. It is stored in `issue_reports.snapshot`
 * so the report survives the node going away, and is embedded in the body.
 */
export interface Diagnostics {
  readonly schema: 1;
  readonly kind: IssueKind;
  readonly generatedAt: string;
  readonly target: {
    readonly nodeId?: string;
    readonly eventId?: number;
    readonly jobId?: number;
    readonly operationId?: string;
    readonly requestId?: string;
  };
  readonly classification: Classification;
  /** The primary error message, as the node or controller reported it. */
  readonly message: string;
  readonly identifiers: Readonly<Record<string, unknown>>;
  readonly versions: Readonly<Record<string, unknown>>;
  readonly hardware: Readonly<Record<string, unknown>> | null;
  readonly desired: Readonly<Record<string, unknown>> | null;
  readonly observed: Readonly<Record<string, unknown>> | null;
  readonly effectiveConfig: Readonly<Record<string, unknown>> | null;
  readonly reconcileHistory: readonly Readonly<Record<string, unknown>>[];
  readonly timeline: readonly TimelineEntry[];
  readonly logs: readonly LogLine[];
  readonly actions: readonly TimelineEntry[];
  readonly reproduction: readonly string[] | null;
  readonly correlation: Readonly<Record<string, unknown>>;
  readonly testFailures: readonly Readonly<Record<string, unknown>>[];
  /** Repo paths worth opening first. */
  readonly suspectedArea: readonly string[];
  /** Things the report could not gather, in words. */
  readonly gaps: readonly string[];
}

/** One class of secret the redactor removed, and how many times. */
export interface RedactionHit {
  readonly class: string;
  readonly count: number;
}

/** The result of building a report: ready to preview, store and send. */
export interface IssueDraft {
  readonly kind: IssueKind;
  readonly nodeId: string | null;
  readonly title: string;
  readonly body: string;
  readonly fingerprint: string;
  readonly classification: Classification;
  readonly correlationId: string | null;
  readonly snapshot: Diagnostics;
  readonly redaction: readonly RedactionHit[];
  /** Section names that were shortened to fit GitHub's body limit. */
  readonly truncated: readonly string[];
}

/** One row of `issue_reports`. */
export interface IssueReport {
  readonly id: string;
  readonly fingerprint: string;
  readonly kind: IssueKind;
  readonly nodeId: string | null;
  readonly status: IssueStatus;
  readonly title: string;
  readonly body: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
  readonly githubIssueNumber: number | null;
  readonly githubIssueUrl: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastError: string | null;
  /** The role of whoever created it (never an email). */
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A report as the pages link to it from an incident. */
export interface IssueLink {
  readonly id: string;
  readonly status: IssueStatus;
  readonly number: number | null;
  readonly url: string | null;
}
