import type { EventRow, NodeRow } from '../types';

import { readBuildInfo } from './build-info';
import type { TargetContext } from './gather-context';
import {
  clip,
  desiredAndObserved,
  hardware,
  identifiers,
  nodeLogs,
  publicConfig,
  timelineOf,
  type NodeEvidence,
} from './gather-node';
import { jobTimeline, slotLogs, workloadIdentifiers } from './gather-workload';
import type { Subject } from './subject';
import type {
  Classification,
  Diagnostics,
  IssueTarget,
  LogLine,
  TimelineEntry,
} from './types';

/** Everything loaded for one report; `assemble` only arranges it. */
export interface Evidence {
  readonly target: IssueTarget;
  readonly context: TargetContext;
  readonly evidence: NodeEvidence | null;
  readonly events: readonly EventRow[];
  readonly subject: Subject;
  readonly classification: Classification;
  readonly suspected: readonly string[];
  readonly history: readonly Record<string, unknown>[];
  readonly actions: readonly TimelineEntry[];
  readonly auditRequestIds: readonly string[];
  readonly controllerLogs: readonly LogLine[];
  readonly repro: readonly string[] | null;
  readonly testFailures: readonly Record<string, unknown>[];
  readonly now: Date;
}

function targetOf(e: Evidence): Diagnostics['target'] {
  const { target, context } = e;
  return {
    ...(context.node === null ? {} : { nodeId: context.node.id }),
    ...(target.eventId === undefined ? {} : { eventId: target.eventId }),
    ...(target.jobId === undefined ? {} : { jobId: target.jobId }),
    ...(target.operationId === undefined
      ? {}
      : { operationId: target.operationId }),
    ...(target.requestId === undefined ? {} : { requestId: target.requestId }),
  };
}

function identifiersOf(e: Evidence): Record<string, unknown> {
  const { context, evidence } = e;
  return {
    ...(context.node === null || evidence === null
      ? {}
      : { node: identifiers(context.node, evidence.view) }),
    ...(context.job === null
      ? {}
      : { workload: workloadIdentifiers(context.job, context.runner) }),
    ...(context.event === null
      ? {}
      : {
          event: {
            id: context.event.id,
            at: context.event.at.toISOString(),
            kind: context.event.kind,
            severity: context.event.severity,
          },
        }),
    ...(context.operation === null
      ? {}
      : {
          operation: {
            id: context.operation.id,
            kind: context.operation.kind,
            status: context.operation.status,
          },
        }),
  };
}

function nodeVersions(node: NodeRow | null): Record<string, unknown> {
  return {
    agentVersion: node?.agentVersion ?? null,
    nodeRevision: node?.revision ?? null,
    appliedRevision: node?.appliedRevision ?? null,
    closure: node?.observedClosure ?? null,
  };
}

function versionsOf(e: Evidence): Record<string, unknown> {
  const build = readBuildInfo();
  return {
    controllerVersion: build.version,
    controllerCommit: build.commit,
    desiredRevision: e.evidence?.view.desiredRevision ?? null,
    ...nodeVersions(e.context.node),
  };
}

function correlationOf(e: Evidence): Record<string, unknown> {
  const requestId = e.target.requestId ?? null;
  const fromEvent = e.context.event?.data['requestId'];
  return {
    requestId,
    traceId: requestId === null ? null : requestId.replaceAll('-', ''),
    eventRequestId: typeof fromEvent === 'string' ? fromEvent : null,
    auditRequestIds: e.auditRequestIds,
  };
}

function gapsOf(e: Evidence): string[] {
  return [
    ...(e.repro === null
      ? [
          'Reproduction steps: not available. The controller records events and operations, not operator actions beyond the audit log.',
        ]
      : []),
    ...(e.context.node === null
      ? [
          'No node is attached to this report, so desired and observed state are not included.',
        ]
      : []),
  ];
}

function logsOf(e: Evidence): LogLine[] {
  const { node, job } = e.context;
  return [
    ...e.controllerLogs,
    ...(node === null || e.evidence === null
      ? []
      : nodeLogs(node, e.evidence.view)),
    ...slotLogs(node, job),
  ];
}

export function assemble(e: Evidence): Diagnostics {
  const node = e.context.node;
  const split =
    node === null || e.evidence === null
      ? null
      : desiredAndObserved(node, e.evidence);
  return {
    schema: 1,
    kind: e.target.kind,
    generatedAt: e.now.toISOString(),
    target: targetOf(e),
    classification: e.classification,
    message: clip(e.subject.message, 1000),
    identifiers: identifiersOf(e),
    versions: versionsOf(e),
    hardware: node === null ? null : hardware(node),
    desired: split?.desired ?? null,
    observed: split?.observed ?? null,
    effectiveConfig:
      e.evidence === null ? null : publicConfig(e.evidence.effective),
    reconcileHistory: e.history,
    timeline: [
      ...timelineOf(e.events),
      ...(e.context.job === null ? [] : jobTimeline(e.context.job)),
    ],
    logs: logsOf(e),
    actions: e.actions,
    reproduction: e.repro,
    correlation: correlationOf(e),
    testFailures: e.testFailures,
    suspectedArea: e.suspected,
    gaps: gapsOf(e),
  };
}
