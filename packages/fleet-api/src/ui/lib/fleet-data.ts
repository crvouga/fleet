import { resolveConfig, type FleetConfig } from '../../config/schema';
import type { AppDeps } from '../../deps';
import { DEFAULT_OFFLINE_AFTER_SECONDS, viewOf } from '../../domain/status';
import { summarize } from '../../domain/summary';
import type { FleetSummary, NodeView } from '../../types';
import { readFacts, type NodeFacts } from './facts';

export const DEFAULT_DISK_ALERT_PERCENT = 90;

/** A node as the pages need it: the view, what it reported and what is wrong. */
export interface FleetEntry {
  readonly view: NodeView;
  readonly facts: NodeFacts;
  readonly effective: FleetConfig;
  readonly diskAlertPercent: number;
  /** True when the node runs a different revision than main. */
  readonly behind: boolean;
}

export type ScopeDocuments = ReadonlyMap<string, FleetConfig>;

export interface FleetData {
  readonly now: Date;
  readonly entries: readonly FleetEntry[];
  readonly summary: FleetSummary;
  readonly latest: string | null;
  readonly documents: ScopeDocuments;
  readonly pendingCount: number;
}

export function isBehind(view: NodeView, latest: string | null): boolean {
  if (latest === null || view.revision === null) return false;
  if (view.approval !== 'approved') return false;
  return !(
    latest.startsWith(view.revision) || view.revision.startsWith(latest)
  );
}

export function effectiveFor(
  view: NodeView,
  documents: ScopeDocuments
): FleetConfig {
  return resolveConfig({
    fleet: documents.get('fleet') ?? {},
    role: documents.get(`role:${view.role}`) ?? {},
    node: documents.get(`node:${view.id}`) ?? {},
  });
}

function toEntry(
  view: NodeView,
  documents: ScopeDocuments,
  latest: string | null
): FleetEntry {
  const effective = effectiveFor(view, documents);
  return {
    view,
    facts: readFacts(view),
    effective,
    diskAlertPercent:
      effective.disk?.alertPercent ?? DEFAULT_DISK_ALERT_PERCENT,
    behind: isBehind(view, latest),
  };
}

/** Everything every page needs, from one pass over the store. */
export async function loadFleet(deps: AppDeps): Promise<FleetData> {
  const now = deps.now();
  const [rows, settings, latest] = await Promise.all([
    deps.store.listNodes(),
    deps.store.listSettings(),
    deps.revisions.latest().catch(() => null),
  ]);
  const documents: ScopeDocuments = new Map(
    settings.map((row) => [row.scope, row.value as FleetConfig])
  );
  const views = rows.map((row) => {
    const config = resolveConfig({
      fleet: documents.get('fleet') ?? {},
      role: documents.get(`role:${row.role}`) ?? {},
      node: documents.get(`node:${row.id}`) ?? {},
    });
    return viewOf(
      row,
      now,
      config.alerts?.offlineAfterSeconds ?? DEFAULT_OFFLINE_AFTER_SECONDS
    );
  });
  const summary = summarize(views);
  return {
    now,
    entries: views.map((view) => toEntry(view, documents, latest)),
    summary,
    latest,
    documents,
    pendingCount: summary.byStatus.pending,
  };
}
