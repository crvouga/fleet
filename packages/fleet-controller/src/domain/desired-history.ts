import type { FleetConfig } from '../config/schema';
import { canonicalJson } from '../config/schema';
import type { Role } from '../types';

/** The desired document as it was recorded: exactly what `desiredFor` returned. */
export interface DesiredSnapshot {
  readonly revision: string;
  readonly role: Role | null;
  readonly closure: string | null;
  readonly values: Omit<FleetConfig, 'alerts'>;
}

export interface DesiredHistoryRow {
  readonly id: number;
  readonly nodeId: string;
  readonly revision: string;
  readonly desired: DesiredSnapshot;
  readonly at: Date;
  /** Why the revision changed: `initial`, or any of `role`, `closure`, `settings`; or a caller's label. */
  readonly cause: string | null;
}

/** Rows kept per node. Older ones are pruned when a new one is recorded. */
export const DESIRED_HISTORY_KEEP = 100;

/** What changed between two documents, derived rather than stored by the caller. */
export function desiredChangeCause(
  previous: DesiredSnapshot | null,
  next: DesiredSnapshot
): string {
  if (previous === null) return 'initial';
  const causes: string[] = [];
  if (previous.role !== next.role) causes.push('role');
  if (previous.closure !== next.closure) causes.push('closure');
  if (canonicalJson(previous.values) !== canonicalJson(next.values))
    causes.push('settings');
  return causes.length > 0 ? causes.join(',') : 'revision';
}

export function isDesiredSnapshot(value: unknown): value is DesiredSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['revision'] === 'string' &&
    typeof record['values'] === 'object' &&
    record['values'] !== null
  );
}

export interface AnnotatedDesiredRow extends DesiredHistoryRow {
  /** The id of an older row with the same revision: this change was a rollback to it. */
  readonly revertsTo: number | null;
}

/** `rows` newest first. A revision that was seen before is a return to it, i.e. a rollback. */
export function annotateHistory(
  rows: readonly DesiredHistoryRow[]
): AnnotatedDesiredRow[] {
  return rows.map((row, index) => ({
    ...row,
    revertsTo:
      rows.slice(index + 1).find((older) => older.revision === row.revision)
        ?.id ?? null,
  }));
}
