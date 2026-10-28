import {
  commentOn,
  createIssue,
  findByFingerprint,
  issueState,
  type Client,
  type Created,
  type Failure,
} from './github-issues';
import { redactText } from './redact';
import type { IssuesRuntime, IssueTuning } from './runtime';
import type { IssueReport } from './types';

/** What one delivery attempt did to a report. */
export type Attempt =
  | {
      readonly result: 'created';
      readonly report: IssueReport;
      readonly reused: boolean;
    }
  | {
      readonly result: 'retry';
      readonly report: IssueReport;
      readonly reason: string;
    }
  | {
      readonly result: 'failed';
      readonly report: IssueReport;
      readonly reason: string;
    }
  | { readonly result: 'skipped'; readonly report: IssueReport | null };

const MAX_ERROR = 400;

/**
 * Exponential backoff with equal jitter: half the delay is fixed, half random,
 * bounded by `capMs`. GitHub's own Retry-After wins when it asks for longer.
 */
export function retryDelayMs(
  attempt: number,
  tuning: IssueTuning,
  random: () => number,
  hintMs: number | null
): number {
  const exponential = Math.min(
    tuning.capMs,
    tuning.baseMs * 2 ** Math.max(0, attempt - 1)
  );
  const jittered = exponential / 2 + (exponential / 2) * random();
  const hint = hintMs === null ? 0 : Math.min(hintMs, tuning.maxRetryAfterMs);
  return Math.round(Math.max(jittered, hint));
}

function clientOf(rt: IssuesRuntime): Client | null {
  return rt.config === null
    ? null
    : { config: rt.config, fetch: rt.fetch, tuning: rt.tuning, now: rt.now };
}

function clean(rt: IssuesRuntime, message: string): string {
  return redactText(message, { literals: rt.literals }).slice(0, MAX_ERROR);
}

async function remoteIssue(
  client: Client,
  report: IssueReport
): Promise<{ ok: true; issue: Created; reused: boolean } | Failure> {
  const existing = await findByFingerprint(
    client,
    report.fingerprint,
    report.createdAt
  );
  if (!existing.ok) return existing;
  if (existing.found !== null)
    return { ok: true, issue: existing.found, reused: true };
  const made = await createIssue(client, {
    title: report.title,
    body: report.body,
  });
  return made.ok ? { ok: true, issue: made.created, reused: false } : made;
}

async function settleFailure(
  rt: IssuesRuntime,
  claimed: IssueReport,
  failure: Failure
): Promise<Attempt> {
  const now = rt.now();
  const message = clean(rt, failure.message);
  const exhausted = claimed.attempts >= rt.tuning.maxAttempts;
  if (!failure.temporary || exhausted) {
    const reason = failure.temporary
      ? `${message} Gave up after ${claimed.attempts} attempts. Open the report and press "Create GitHub issue" to try again.`
      : message;
    await rt.store.markFailed(claimed.id, reason, now);
    return {
      result: 'failed',
      report: (await rt.store.get(claimed.id)) ?? claimed,
      reason,
    };
  }
  const delay = retryDelayMs(
    claimed.attempts,
    rt.tuning,
    rt.random,
    failure.retryAfterMs
  );
  await rt.store.markRetry(
    claimed.id,
    new Date(now.getTime() + delay),
    message,
    now
  );
  return {
    result: 'retry',
    report: (await rt.store.get(claimed.id)) ?? claimed,
    reason: message,
  };
}

/**
 * One delivery attempt. Idempotent: the attempt is claimed first (so two
 * callers cannot both send), and before creating anything GitHub is searched
 * for an issue carrying the report's fingerprint marker, so a crash between
 * "GitHub created it" and "we saved the number" cannot produce a second issue.
 */
export async function attemptReport(
  rt: IssuesRuntime,
  id: string
): Promise<Attempt> {
  const client = clientOf(rt);
  if (client === null)
    return { result: 'skipped', report: await rt.store.get(id) };
  const now = rt.now();
  const claimed = await rt.store.claim(
    id,
    now,
    new Date(now.getTime() + rt.tuning.leaseMs)
  );
  if (claimed === null)
    return { result: 'skipped', report: await rt.store.get(id) };
  const remote = await remoteIssue(client, claimed);
  if (!remote.ok) return settleFailure(rt, claimed, remote);
  await rt.store.markCreated(
    claimed.id,
    remote.issue.number,
    remote.issue.url,
    rt.now()
  );
  rt.log.info('issue report delivered', {
    report: claimed.id,
    issue: remote.issue.number,
    reused: remote.reused,
  });
  return {
    result: 'created',
    report: (await rt.store.get(claimed.id)) ?? claimed,
    reused: remote.reused,
  };
}

/**
 * The report this one repeats, if it is still open on GitHub. A report whose
 * issue was closed (or deleted) is retired so the recurrence files a new one.
 */
export async function liveOpenReport(
  rt: IssuesRuntime,
  open: IssueReport
): Promise<IssueReport | null> {
  const client = clientOf(rt);
  if (
    client === null ||
    open.status !== 'created' ||
    open.githubIssueNumber === null
  )
    return open;
  const state = await issueState(client, open.githubIssueNumber);
  if (!state.ok || state.state === 'open') return open;
  await rt.store.retire(
    open.id,
    'The GitHub issue was closed; a new report replaces it.',
    rt.now()
  );
  return null;
}

function recurrenceText(rt: IssuesRuntime, report: IssueReport): string {
  const node =
    report.nodeId === null ? 'no node' : `node ${report.nodeId.slice(0, 12)}`;
  return `Seen again at ${rt.now().toISOString()} (${report.kind}, ${node}). No new issue was opened; report ${report.id}.`;
}

/** Counts a recurrence on the open report and, at most once per interval, comments on its issue. */
export async function recordRecurrence(
  rt: IssuesRuntime,
  open: IssueReport,
  again: IssueReport
): Promise<void> {
  const client = clientOf(rt);
  const previous = open.snapshot['recurrence'];
  const last =
    typeof previous === 'object' && previous !== null
      ? (previous as Record<string, unknown>)['lastCommentAt']
      : null;
  const lastAt = typeof last === 'string' ? Date.parse(last) : Number.NaN;
  const due =
    Number.isNaN(lastAt) ||
    rt.now().getTime() - lastAt >= rt.tuning.commentEveryMs;
  let commented = false;
  if (
    client !== null &&
    due &&
    open.status === 'created' &&
    open.githubIssueNumber !== null
  ) {
    const result = await commentOn(
      client,
      open.githubIssueNumber,
      recurrenceText(rt, again)
    );
    commented = result.ok;
    if (!result.ok)
      rt.log.warn('issue recurrence comment failed', {
        issue: open.githubIssueNumber,
        status: result.status,
      });
  }
  await rt.store.touchRecurrence(open.id, rt.now(), commented);
}
