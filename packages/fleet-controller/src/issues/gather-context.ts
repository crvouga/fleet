import type { AppDeps } from '../deps';
import type { Operation } from '../domain/operations';
import type { CiJob, RunnerRecord } from '../github/types';
import type { EventRow, NodeRow } from '../types';

import type { ControllerErrorRecord } from './errors';
import type { IssueTarget } from './types';

/** The records a target points at, loaded once. Everything else is derived from these. */
export interface TargetContext {
  readonly node: NodeRow | null;
  readonly event: EventRow | null;
  readonly job: CiJob | null;
  readonly runner: RunnerRecord | null;
  readonly operation: Operation | null;
  readonly requestError: ControllerErrorRecord | null;
}

export type Resolved =
  | { readonly ok: true; readonly context: TargetContext }
  | { readonly ok: false; readonly error: string };

const NODE_ID = /^[0-9a-f]{64}$/;

async function eventById(deps: AppDeps, id: number): Promise<EventRow | null> {
  const rows = await deps.store.listEvents({ beforeId: id + 1, limit: 1 });
  return rows[0]?.id === id ? rows[0] : null;
}

async function jobContext(
  deps: AppDeps,
  id: number
): Promise<{ job: CiJob; runner: RunnerRecord | null } | null> {
  const github = deps.github;
  if (github === undefined) return null;
  const job = await github.store.getJob(id);
  if (job === null) return null;
  const runners = job.runnerId === null ? [] : await github.store.listRunners();
  return { job, runner: runners.find((r) => r.id === job.runnerId) ?? null };
}

function missing(what: string): Resolved {
  return { ok: false, error: `No such ${what}.` };
}

interface Found {
  event: EventRow | null;
  job: CiJob | null;
  runner: RunnerRecord | null;
  operation: Operation | null;
}

async function lookup(
  deps: AppDeps,
  target: IssueTarget
): Promise<Found | string> {
  const found: Found = {
    event: null,
    job: null,
    runner: null,
    operation: null,
  };
  if (target.eventId !== undefined) {
    found.event = await eventById(deps, target.eventId);
    if (found.event === null) return 'event';
  }
  if (target.jobId !== undefined) {
    const resolved = await jobContext(deps, target.jobId);
    if (resolved === null) return 'job';
    found.job = resolved.job;
    found.runner = resolved.runner;
  }
  if (target.operationId !== undefined) {
    found.operation = await deps.store.operations.get(target.operationId);
    if (found.operation === null) return 'operation';
  }
  return found;
}

/** The node the target is about: named, or the one the event, job or operation belongs to. */
function nodeIdFor(target: IssueTarget, found: Found): string | null {
  return (
    target.nodeId ??
    found.event?.nodeId ??
    found.job?.nodeId ??
    found.operation?.nodeId ??
    null
  );
}

export async function resolveContext(
  deps: AppDeps,
  target: IssueTarget
): Promise<Resolved> {
  if (target.nodeId !== undefined && !NODE_ID.test(target.nodeId))
    return missing('node');
  const found = await lookup(deps, target);
  if (typeof found === 'string') return missing(found);
  const nodeId = nodeIdFor(target, found);
  const node = nodeId === null ? null : await deps.store.findNode(nodeId);
  if (target.nodeId !== undefined && node === null) return missing('node');
  const requestError =
    target.requestId === undefined
      ? null
      : (deps.issues?.errors.find(target.requestId) ?? null);
  return { ok: true, context: { node, ...found, requestError } };
}
