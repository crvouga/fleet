import type { AppDeps } from '../deps';
import type { EventRow, NodeRow } from '../types';

import { classify, suspectedArea } from './classify';
import { actionsFor, controllerLogs } from './gather-actions';
import { resolveContext, type TargetContext } from './gather-context';
import { assemble, type Evidence } from './gather-assemble';
import {
  installerSteps,
  nodeEvidence,
  reconcileHistory,
  type NodeEvidence,
} from './gather-node';
import { failedJobs } from './gather-workload';
import { reproduction } from './reproduction';
import { subjectOf } from './subject';
import type { Diagnostics, IssueTarget } from './types';

const NODE_EVENTS = 40;
const GLOBAL_EVENTS = 20;

export type Gathered =
  | {
      readonly ok: true;
      readonly diagnostics: Diagnostics;
      readonly node: NodeRow | null;
      readonly role: string | null;
      readonly closure: string | null;
    }
  | { readonly ok: false; readonly error: string };

async function eventsFor(
  deps: AppDeps,
  node: NodeRow | null
): Promise<EventRow[]> {
  if (node !== null)
    return [
      ...(await deps.store.listEvents({ nodeId: node.id, limit: NODE_EVENTS })),
    ];
  const recent = await deps.store.listEvents({ limit: GLOBAL_EVENTS * 3 });
  return recent
    .filter((event) => event.severity !== 'info')
    .slice(0, GLOBAL_EVENTS);
}

async function testFailures(
  deps: AppDeps,
  target: IssueTarget,
  loaded: { context: TargetContext; events: readonly EventRow[] }
): Promise<Record<string, unknown>[]> {
  if (target.kind === 'installer') return installerSteps(loaded.events);
  if (target.kind !== 'workload') return [];
  return failedJobs(deps, loaded.context.job, loaded.context.node);
}

async function load(
  deps: AppDeps,
  target: IssueTarget,
  context: TargetContext
): Promise<Evidence> {
  const node = context.node;
  const evidence: NodeEvidence | null =
    node === null ? null : await nodeEvidence(deps, node);
  const events = await eventsFor(deps, node);
  const subject = subjectOf(context, evidence, events);
  const { actions, auditRequestIds } = await actionsFor(
    deps,
    node,
    context.requestError?.requestId ?? null
  );
  const classification = classify(
    target.kind,
    subject.eventKind,
    subject.message
  );
  return {
    target,
    context,
    evidence,
    events,
    subject,
    classification,
    suspected: suspectedArea(classification),
    history: node === null ? [] : await reconcileHistory(deps, node, events),
    actions,
    auditRequestIds,
    controllerLogs: controllerLogs(context.requestError),
    repro: reproduction({
      event: context.event,
      operation: context.operation,
      events,
    }),
    testFailures: await testFailures(deps, target, { context, events }),
    now: deps.now(),
  };
}

/**
 * Gathers everything the controller knows about a target. Unredacted: callers
 * pass the result through the redactor before it leaves the process.
 */
export async function gatherDiagnostics(
  deps: AppDeps,
  target: IssueTarget
): Promise<Gathered> {
  const resolved = await resolveContext(deps, target);
  if (!resolved.ok) return resolved;
  const evidence = await load(deps, target, resolved.context);
  const node = resolved.context.node;
  return {
    ok: true,
    diagnostics: assemble(evidence),
    node,
    role: node?.role ?? node?.observedRole ?? null,
    closure:
      evidence.evidence?.view.desiredClosure ?? node?.observedClosure ?? null,
  };
}
