import type { AppDeps } from '../deps';
import type { AuditRow, NodeRow } from '../types';

import type { ControllerErrorRecord } from './errors';
import { clip } from './gather-node';
import type { LogLine, TimelineEntry } from './types';

const NODE_AUDIT = 20;
const NODE_OPERATIONS = 10;
const REQUEST_AUDIT_SCAN = 200;

function auditEntry(row: AuditRow): TimelineEntry {
  return {
    at: row.at.toISOString(),
    source: 'audit',
    kind: row.action,
    severity: row.outcome === 'success' ? 'info' : row.outcome,
    // Roles, never emails: the report is posted outside the controller.
    message: `${row.outcome} by ${row.actorRole ?? 'unknown role'}`,
  };
}

async function operationEntries(
  deps: AppDeps,
  node: NodeRow | null
): Promise<TimelineEntry[]> {
  if (node === null) return [];
  const operations = await deps.store.operations.list({
    nodeId: node.id,
    limit: NODE_OPERATIONS,
  });
  return operations.map((op) => {
    const detail = op.failure ?? op.progress;
    return {
      at: op.requestedAt.toISOString(),
      source: 'operation' as const,
      kind: op.kind,
      severity: op.status === 'failed' ? 'error' : 'info',
      message: clip(detail === null ? op.status : `${op.status}: ${detail}`),
    };
  });
}

async function auditRows(
  deps: AppDeps,
  node: NodeRow | null,
  requestId: string | null
): Promise<AuditRow[]> {
  const forNode =
    node === null
      ? []
      : await deps.store.listAudit({
          targetKind: 'node',
          targetId: node.id,
          limit: NODE_AUDIT,
        });
  if (requestId === null) return [...forNode];
  const scanned = await deps.store.listAudit({ limit: REQUEST_AUDIT_SCAN });
  return [...forNode, ...scanned.filter((row) => row.requestId === requestId)];
}

/** Actions already taken on the node (operations, audit entries), plus the request ids those carried. */
export async function actionsFor(
  deps: AppDeps,
  node: NodeRow | null,
  requestId: string | null
): Promise<{ actions: TimelineEntry[]; auditRequestIds: string[] }> {
  const rows = await auditRows(deps, node, requestId);
  const ids = rows.flatMap((row) =>
    row.requestId === null ? [] : [row.requestId]
  );
  return {
    actions: [...(await operationEntries(deps, node)), ...rows.map(auditEntry)],
    auditRequestIds: [...new Set(ids)],
  };
}

export function controllerLogs(error: ControllerErrorRecord | null): LogLine[] {
  if (error === null) return [];
  const head: LogLine = {
    at: error.at.toISOString(),
    source: `controller ${error.method} ${error.route}`,
    level: 'error',
    message: clip(`${error.name}: ${error.message}`),
  };
  const frames = error.stack.map((frame) => ({
    at: null,
    source: 'stack',
    level: 'error',
    message: clip(frame, 300),
  }));
  return [head, ...frames];
}
