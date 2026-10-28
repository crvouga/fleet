import { DEFAULT_ISSUE_LABELS } from './env';
import { newIssueUrl } from './prefill';
import type { IssuesRuntime } from './runtime';
import type { IssueDraft, IssueLink, IssueReport, RedactionHit } from './types';
import { linkOf } from './store';

/** How filing works right now, in words the preview page can show. */
export interface SubmissionInfo {
  /** True when a token and repository are configured: "Create GitHub issue" works. */
  readonly configured: boolean;
  readonly reason: string | null;
  /** A prefilled "new issue" address, when the repository is known. */
  readonly newIssueUrl: string | null;
}

export interface ReportView {
  readonly id: string | null;
  readonly status: IssueReport['status'] | 'unsaved';
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly fingerprint: string;
  readonly classification: {
    code: string;
    component: string;
    summary: string;
  } | null;
  readonly redaction: readonly RedactionHit[];
  readonly truncated: readonly string[];
  readonly duplicate: IssueLink | null;
  readonly githubIssueNumber: number | null;
  readonly githubIssueUrl: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly submission: SubmissionInfo;
}

const NOT_CONFIGURED =
  'Filing from the controller is not configured. Set FLEET_ISSUES_REPOSITORY (owner/name) and FLEET_ISSUES_GITHUB_TOKEN (a fine-grained token with Issues: write) in deployment.env and restart. Until then, copy the report below.';
const NO_REPOSITORY =
  ' Without FLEET_ISSUES_REPOSITORY the controller cannot even prefill a link, so paste the report into the issue tracker you use.';

export function submissionFor(
  runtime: IssuesRuntime | undefined,
  report: { title: string; body: string }
): SubmissionInfo {
  if (runtime === undefined)
    return {
      configured: false,
      reason:
        'Issue reporting is not available in this mode. Copy the report below.',
      newIssueUrl: null,
    };
  const link =
    runtime.repository === null
      ? null
      : newIssueUrl({
          origin: runtime.webOrigin,
          repository: runtime.repository,
          title: report.title,
          body: report.body,
          labels: runtime.config?.labels ?? DEFAULT_ISSUE_LABELS,
        });
  if (runtime.config !== null)
    return { configured: true, reason: null, newIssueUrl: link };
  return {
    configured: false,
    reason: NOT_CONFIGURED + (link === null ? NO_REPOSITORY : ''),
    newIssueUrl: link,
  };
}

function metaOf(snapshot: Readonly<Record<string, unknown>>): {
  redaction: RedactionHit[];
  truncated: string[];
  classification: ReportView['classification'];
} {
  const redaction = Array.isArray(snapshot['redaction'])
    ? (snapshot['redaction'] as RedactionHit[])
    : [];
  const truncated = Array.isArray(snapshot['truncated'])
    ? (snapshot['truncated'] as string[])
    : [];
  const c = snapshot['classification'];
  const classification =
    typeof c === 'object' && c !== null
      ? (c as NonNullable<ReportView['classification']>)
      : null;
  return { redaction, truncated, classification };
}

/** A stored report as the API and the pages show it. */
export function viewOfReport(
  report: IssueReport,
  runtime: IssuesRuntime | undefined,
  duplicate: IssueLink | null = null
): ReportView {
  return {
    id: report.id,
    status: report.status,
    title: report.title,
    body: report.body,
    kind: report.kind,
    fingerprint: report.fingerprint,
    ...metaOf(report.snapshot),
    duplicate,
    githubIssueNumber: report.githubIssueNumber,
    githubIssueUrl: report.githubIssueUrl,
    attempts: report.attempts,
    nextAttemptAt: report.nextAttemptAt?.toISOString() ?? null,
    lastError: report.lastError,
    submission: submissionFor(runtime, report),
  };
}

/** A draft that was not saved (a viewer's preview, or no runtime). */
export function viewOfDraft(
  draft: IssueDraft,
  runtime: IssuesRuntime | undefined,
  duplicate: IssueLink | null
): ReportView {
  return {
    id: null,
    status: 'unsaved',
    title: draft.title,
    body: draft.body,
    kind: draft.kind,
    fingerprint: draft.fingerprint,
    classification: draft.classification,
    redaction: draft.redaction,
    truncated: draft.truncated,
    duplicate,
    githubIssueNumber: null,
    githubIssueUrl: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    submission: submissionFor(runtime, draft),
  };
}

export { linkOf };
