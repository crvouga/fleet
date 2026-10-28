import type { AppDeps } from '../deps';
import { desiredFor } from '../domain/desired-state';
import { viewOf } from '../domain/node-view';
import type { FleetConfig } from '../config/schema';
import { readFacts } from '../ui/lib/facts';
import { effectiveFor } from '../ui/lib/fleet-data';
import { maskUrl } from '../ui/lib/format';
import type { EventRow, NodeRow, NodeView } from '../types';

import type { LogLine, TimelineEntry } from './types';

const MAX_MESSAGE = 500;
const RECONCILE_KINDS = new Set([
  'revision',
  'role_converged',
  'reconcile_blocked',
  'rollback',
  'role_assigned',
]);

export const clip = (text: string, max = MAX_MESSAGE): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

export interface NodeEvidence {
  readonly view: NodeView;
  readonly effective: FleetConfig;
}

export async function nodeEvidence(
  deps: AppDeps,
  node: NodeRow
): Promise<NodeEvidence> {
  const settings = await deps.store.listSettings();
  const documents = new Map(
    settings.map((row) => [row.scope, row.value as FleetConfig])
  );
  const effective = effectiveFor(node, documents);
  return { view: viewOf(node, deps.now(), effective), effective };
}

/** Effective settings with the webhook URL reduced to its origin: its path usually carries the secret. */
export function publicConfig(config: FleetConfig): Record<string, unknown> {
  const alerts = config.alerts;
  return {
    ...config,
    ...(alerts === undefined
      ? {}
      : { alerts: { ...alerts, webhookUrl: maskUrl(alerts.webhookUrl) } }),
  };
}

export function identifiers(
  node: NodeRow,
  view: NodeView
): Record<string, unknown> {
  return {
    nodeId: node.id,
    shortId: view.shortId,
    hostname: node.hostname,
    label: view.label,
    assignedRole: node.role,
    observedRole: node.observedRole,
    approval: node.approval,
    status: view.status,
    enrolledVia: node.enrolledVia,
    firstSeenAt: node.firstSeenAt.toISOString(),
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
  };
}

export function hardware(node: NodeRow): Record<string, unknown> {
  const facts = readFacts(node);
  return {
    capabilities: node.hardware?.capabilities ?? [],
    cpuCores: facts.cpuCores,
    cpuModel: facts.cpuModel,
    memoryTotalMiB: facts.memTotalMiB,
    memoryUsedPercent: facts.memUsedPercent,
    load1: facts.load1,
    nixDiskUsedPercent: facts.nixUsedPercent,
    bootDiskUsedPercent: facts.bootUsedPercent,
    kernel: facts.kernel,
    arch: facts.arch,
    uptimeSeconds: facts.uptimeSeconds,
    addressCount: facts.addresses.length,
  };
}

export function desiredAndObserved(
  node: NodeRow,
  evidence: NodeEvidence
): { desired: Record<string, unknown>; observed: Record<string, unknown> } {
  const facts = readFacts(node);
  const { view } = evidence;
  return {
    desired: { ...desiredFor(node, evidence.effective) },
    observed: {
      role: node.observedRole,
      closure: node.observedClosure,
      revision: node.revision,
      appliedDesiredRevision: node.appliedRevision,
      desiredRevision: view.desiredRevision,
      convergence: view.convergence,
      reconcilePhase: node.reconcile?.phase ?? null,
      reconcileIssues: node.reconcile?.issues ?? [],
      rolledBack: facts.rolledBack,
      healthFailure: facts.healthFailure,
      failedUnits: facts.failedUnits,
      syncPaused: facts.paused,
      readinessIssues: facts.readinessIssues ?? [],
    },
  };
}

function eventEntry(event: EventRow): TimelineEntry {
  return {
    at: event.at.toISOString(),
    source: 'event',
    kind: event.kind,
    severity: event.severity,
    message: clip(event.message),
  };
}

export const timelineOf = (events: readonly EventRow[]): TimelineEntry[] =>
  events.map(eventEntry);

export async function reconcileHistory(
  deps: AppDeps,
  node: NodeRow,
  events: readonly EventRow[]
): Promise<Record<string, unknown>[]> {
  const history = await deps.store.desiredHistory(node.id, 10);
  const changes = history.map((row) => ({
    at: row.at.toISOString(),
    source: 'desired',
    revision: row.revision,
    cause: row.cause,
    role: row.desired.role,
    closure: row.desired.closure,
  }));
  const reports = events
    .filter((event) => RECONCILE_KINDS.has(event.kind))
    .map((event) => ({ ...eventEntry(event) }));
  return [...changes, ...reports];
}

function logOf(level: string, source: string, message: string): LogLine {
  return { at: null, source, level, message: clip(message) };
}

/** Allowlisted telemetry logs plus every problem the node itself named. */
export function nodeLogs(node: NodeRow, view: NodeView): LogLine[] {
  const facts = readFacts(node);
  const telemetry = (facts.telemetry?.logs ?? []).map((line) => ({
    at: line.at,
    source: line.source,
    level: line.level,
    message: clip(line.message),
  }));
  const issues = view.reconcileIssues.map((issue) =>
    logOf('error', 'reconcile', issue)
  );
  const readiness = (facts.readinessIssues ?? []).map((issue) =>
    logOf('warn', 'readiness', issue)
  );
  const units = facts.failedUnits.map((unit) =>
    logOf('error', 'systemd', `unit failed: ${unit}`)
  );
  const health =
    facts.healthFailure === null
      ? []
      : [logOf('error', 'health', facts.healthFailure)];
  return [...issues, ...health, ...units, ...readiness, ...telemetry];
}

/** Events a person would call installer or enrollment trouble. */
export function installerSteps(
  events: readonly EventRow[]
): Record<string, unknown>[] {
  return events
    .filter((event) => event.severity !== 'info')
    .filter((event) =>
      /install|bootstrap|enroll|readiness|registered|reregistered/i.test(
        `${event.kind} ${event.message}`
      )
    )
    .map((event) => ({ ...eventEntry(event) }));
}
