import { randomUUID } from 'node:crypto';

import type { AppDeps } from '../deps';

import { buildDraft, type SnapshotMeta } from './build';
import {
  attemptReport,
  liveOpenReport,
  recordRecurrence,
  type Attempt,
} from './delivery';
import { linkOf } from './store';
import type { IssueDraft, IssueLink, IssueReport, IssueTarget } from './types';

export interface Who {
  /** As the audit log names the actor. Stored with the report; never rendered into a body. */
  readonly actor: string;
  readonly role: 'admin' | 'viewer';
  readonly requestId?: string | null;
}

export type Preview =
  | {
      readonly ok: true;
      readonly draft: IssueDraft;
      /** The stored draft; null when nothing was persisted (a viewer, or no runtime). */
      readonly report: IssueReport | null;
      /** An open report with the same fingerprint, if there is one. */
      readonly duplicate: IssueLink | null;
    }
  | { readonly ok: false; readonly error: string };

export function secretsOf(deps: AppDeps): string[] {
  const { env } = deps;
  return [
    env.adminToken,
    env.adminTokenNext,
    env.github?.webhookSecret,
    env.issues?.token,
    ...(deps.issues?.literals ?? []),
  ].filter(
    (value): value is string => typeof value === 'string' && value !== ''
  );
}

interface AuditEntry {
  readonly action: string;
  readonly report: IssueReport | IssueDraft;
  readonly extra?: Record<string, unknown>;
}

async function audit(
  deps: AppDeps,
  who: Who,
  entry: AuditEntry
): Promise<void> {
  const { report } = entry;
  try {
    await deps.store.audit({
      actor: who.actor,
      actorRole: who.role,
      action: entry.action,
      targetKind: 'issue',
      targetId: 'id' in report ? report.id : report.fingerprint,
      requestId: who.requestId ?? null,
      detail: {
        kind: report.kind,
        fingerprint: report.fingerprint,
        ...entry.extra,
      },
    });
  } catch {
    // Reporting must not fail because the audit row could not be written.
  }
}

/** The snapshot as stored: the redacted diagnostics plus what was redacted and cut. */
export function snapshotOf(draft: IssueDraft): Record<string, unknown> {
  const meta: SnapshotMeta = {
    redaction: draft.redaction,
    truncated: draft.truncated,
  };
  return { ...draft.snapshot, ...meta };
}

/**
 * Builds the redacted report for a target. An admin's preview is saved as a
 * draft, so the diagnostics survive the node going away and the person
 * confirms exactly what they saw. A viewer's preview saves nothing.
 */
export async function previewReport(
  deps: AppDeps,
  who: Who,
  target: IssueTarget
): Promise<Preview> {
  const built = await buildDraft(deps, target, { literals: secretsOf(deps) });
  if (!built.ok) return built;
  const { draft } = built;
  const runtime = deps.issues;
  if (runtime === undefined)
    return { ok: true, draft, report: null, duplicate: null };
  const open = await runtime.store.findOpen(draft.fingerprint);
  const duplicate = open === null ? null : linkOf(open);
  if (who.role !== 'admin') return { ok: true, draft, report: null, duplicate };
  const report = await runtime.store.saveDraft({
    id: randomUUID(),
    fingerprint: draft.fingerprint,
    kind: draft.kind,
    nodeId: draft.nodeId,
    title: draft.title,
    body: draft.body,
    snapshot: snapshotOf(draft),
    correlationId: draft.correlationId,
    createdBy: who.actor,
    now: deps.now(),
  });
  await audit(deps, who, {
    action: 'issue.preview',
    report,
    extra: { duplicateOf: duplicate?.id ?? null },
  });
  return { ok: true, draft, report, duplicate };
}

export type Submission =
  | { readonly outcome: 'not_found' }
  /** Filing is off. The draft is intact and usable by copy and paste. */
  | { readonly outcome: 'not_configured'; readonly report: IssueReport }
  /** An open report already covers this failure; `report` is that one. */
  | {
      readonly outcome: 'duplicate';
      readonly report: IssueReport;
      readonly own: IssueReport;
    }
  /** Already queued or created: nothing was sent again. */
  | { readonly outcome: 'existing'; readonly report: IssueReport }
  | {
      readonly outcome: 'submitted';
      readonly report: IssueReport;
      readonly attempt: Attempt;
    };

async function asDuplicate(
  deps: AppDeps,
  who: Who,
  own: IssueReport,
  open: IssueReport
): Promise<Submission> {
  const runtime = deps.issues!;
  await runtime.store.markDuplicate(own.id, open, deps.now());
  await recordRecurrence(runtime, open, own).catch((error: unknown) => {
    runtime.log.warn('issue recurrence not recorded', {
      report: open.id,
      error: String(error),
    });
  });
  const marked = (await runtime.store.get(own.id)) ?? own;
  await audit(deps, who, {
    action: 'issue.duplicate',
    report: marked,
    extra: { of: open.id, issue: open.githubIssueNumber },
  });
  return { outcome: 'duplicate', report: open, own: marked };
}

/** The open report for a fingerprint, after checking GitHub still has it open. */
async function openFor(
  deps: AppDeps,
  own: IssueReport
): Promise<IssueReport | null> {
  const runtime = deps.issues!;
  const open = await runtime.store.findOpen(own.fingerprint);
  return open === null || open.id === own.id
    ? null
    : liveOpenReport(runtime, open);
}

type Early = Extract<
  Submission,
  { outcome: 'not_found' | 'not_configured' | 'existing' }
>;

/** The answers that need no delivery: unknown id, already sent, or filing is off. */
async function early(deps: AppDeps, id: string): Promise<Early | IssueReport> {
  const runtime = deps.issues;
  const report = runtime === undefined ? null : await runtime.store.get(id);
  if (runtime === undefined || report === null) return { outcome: 'not_found' };
  if (
    report.status === 'queued' ||
    report.status === 'created' ||
    report.status === 'duplicate'
  )
    return { outcome: 'existing', report };
  if (runtime.config === null) return { outcome: 'not_configured', report };
  return report;
}

/**
 * Sends a saved draft to GitHub (or queues it). Safe to repeat: a report that
 * is already queued or created is returned as is, and a second report for the
 * same failure becomes a `duplicate` of the first instead of a second issue.
 */
export async function submitReport(
  deps: AppDeps,
  who: Who,
  id: string
): Promise<Submission> {
  const report = await early(deps, id);
  if ('outcome' in report) return report;
  const runtime = deps.issues!;
  const open = await openFor(deps, report);
  if (open !== null) return asDuplicate(deps, who, report, open);
  const queued = await runtime.store.queue(id, deps.now());
  if (queued.outcome === 'conflict')
    return asDuplicate(deps, who, report, queued.open);
  if (queued.outcome === 'unavailable')
    return queued.report === null
      ? { outcome: 'not_found' }
      : { outcome: 'existing', report: queued.report };
  const attempt = await attemptReport(runtime, id);
  const settled = attempt.report ?? queued.report;
  await audit(deps, who, {
    action: 'issue.create',
    report: settled,
    extra: {
      status: settled.status,
      issue: settled.githubIssueNumber,
      attempts: settled.attempts,
    },
  });
  return { outcome: 'submitted', report: settled, attempt };
}
