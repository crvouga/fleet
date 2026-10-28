import { errorDetails } from '@pkgs/logger';

import { attemptReport, type Attempt } from '../issues/delivery';
import type { IssueReport } from '../issues/types';

import type { JobDeps } from './offline-notifier';

const BATCH = 5;
const ACTOR = 'system:issue-sync';

/** Retries are routine; only the end of a report's delivery is worth an audit row. */
async function auditEnd(
  deps: JobDeps,
  report: IssueReport,
  attempt: Attempt
): Promise<boolean> {
  if (attempt.result !== 'created' && attempt.result !== 'failed') return false;
  const settled = attempt.report;
  await deps.store.audit({
    actor: ACTOR,
    action: 'issue.deliver',
    targetKind: 'issue',
    targetId: report.id,
    outcome: attempt.result === 'created' ? 'success' : 'failed',
    detail: {
      fingerprint: report.fingerprint,
      kind: report.kind,
      issue: settled.githubIssueNumber,
      attempts: settled.attempts,
    },
  });
  return true;
}

/**
 * The scheduler's issue task: sends every queued report whose retry time has
 * come. Level-triggered and idempotent: each attempt is claimed first, and a
 * report that GitHub already has (a crash between create and save) is found
 * by its fingerprint marker instead of being created twice. Does nothing when
 * the operator has not configured filing. Returns how many reports finished.
 */
export async function runIssueSyncJob(deps: JobDeps): Promise<number> {
  const runtime = deps.issues;
  if (runtime === undefined || runtime.config === null) return 0;
  let finished = 0;
  for (const report of await runtime.store.due(deps.now(), BATCH)) {
    try {
      const attempt = await attemptReport(runtime, report.id);
      if (await auditEnd(deps, report, attempt)) finished += 1;
    } catch (error) {
      deps.log.error('issue delivery failed', {
        report: report.id,
        error: errorDetails(error),
      });
    }
  }
  return finished;
}
