import type { IssueTarget } from './types';

/** `/report-issue?...` for a target. Pure; the server pages and the console share it. */
export function reportUrl(
  target: Partial<IssueTarget> & { kind: IssueTarget['kind'] }
): string {
  const params = new URLSearchParams({ kind: target.kind });
  if (target.nodeId !== undefined) params.set('node', target.nodeId);
  if (target.eventId !== undefined) params.set('event', String(target.eventId));
  if (target.jobId !== undefined) params.set('job', String(target.jobId));
  if (target.operationId !== undefined)
    params.set('operation', target.operationId);
  if (target.requestId !== undefined) params.set('request', target.requestId);
  return `/report-issue?${params.toString()}`;
}
