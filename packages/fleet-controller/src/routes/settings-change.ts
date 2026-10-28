import type { FleetConfig, Scope } from '../config/schema';
import type { AppDeps } from '../deps';
import { SettingsConflictError } from '../domain/settings-conflict';
import {
  analyzeSettingsChange,
  unacknowledged,
  type SettingsImpact,
  type SettingsIssue,
} from '../domain/settings-impact';
import type { SettingsRow } from '../types';

export type ChangeCause = 'put' | 'restore';

export interface ChangeRequest {
  readonly scope: Scope;
  readonly value: FleetConfig;
  readonly actor: string;
  /** The revision the caller based the change on. Required for a scope that exists. */
  readonly expectedRevision?: number | undefined;
  /** Codes of blocking issues the caller has read and accepts. */
  readonly acknowledge: readonly string[];
  readonly dryRun: boolean;
  readonly cause: ChangeCause;
  /** Restore only: the history entry being restored. */
  readonly restoredFrom?: number;
}

export type ChangeOutcome =
  | {
      readonly kind: 'dry_run';
      readonly revision: number;
      readonly impact: SettingsImpact;
      readonly blockedBy: readonly SettingsIssue[];
      readonly conflict: boolean;
      readonly preconditionMissing: boolean;
    }
  | {
      readonly kind: 'written';
      readonly row: SettingsRow;
      readonly impact: SettingsImpact;
    }
  | {
      readonly kind: 'conflict';
      readonly current: number;
      readonly expected: number;
    }
  | { readonly kind: 'precondition_required'; readonly current: number }
  | {
      readonly kind: 'unsafe';
      readonly issues: readonly SettingsIssue[];
      readonly impact: SettingsImpact;
    };

const ACTIONS: Readonly<Record<ChangeCause, string>> = {
  put: 'settings.put',
  restore: 'settings.restore',
};

/** The label stored as the author of a write; a rollback says so. */
export function authorLabel(request: ChangeRequest): string {
  return request.cause === 'restore' && request.restoredFrom !== undefined
    ? `${request.actor} (rollback to #${request.restoredFrom})`
    : request.actor;
}

async function failed(
  deps: AppDeps,
  request: ChangeRequest,
  detail: Record<string, unknown>
): Promise<void> {
  await deps.store.audit({
    actor: request.actor,
    actorRole: 'admin',
    action: ACTIONS[request.cause],
    targetKind: 'settings',
    targetId: request.scope,
    outcome: 'failed',
    detail,
  });
}

/** Records the desired documents the change produced, with their predecessors. Best effort. */
async function recordImpact(
  deps: AppDeps,
  scope: Scope,
  impact: SettingsImpact
): Promise<void> {
  try {
    for (const change of impact.changes) {
      await deps.store.recordDesired(change.nodeId, change.before);
      await deps.store.recordDesired(
        change.nodeId,
        change.after,
        `settings:${scope}`
      );
    }
  } catch {
    // Diagnostic history never blocks a settings write.
  }
}

interface Assessment {
  readonly current: number;
  /** The scope exists but the request named no revision. */
  readonly missing: boolean;
  /** The request named a revision that is no longer the stored one. */
  readonly stale: boolean;
  readonly impact: SettingsImpact;
  readonly blocked: readonly SettingsIssue[];
}

async function assess(
  deps: AppDeps,
  request: ChangeRequest
): Promise<Assessment> {
  const existing = await deps.store.getSettings(request.scope);
  const current = existing?.revision ?? 0;
  const impact = analyzeSettingsChange({
    scope: request.scope,
    proposed: request.value,
    rows: await deps.store.listSettings(),
    nodes: await deps.store.listNodes(),
  });
  return {
    current,
    missing: request.expectedRevision === undefined && existing !== null,
    stale:
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current,
    impact,
    blocked: unacknowledged(impact.issues, request.acknowledge),
  };
}

/** The reason the write must not happen (and its audit entry), or null when it may. */
async function refusal(
  deps: AppDeps,
  request: ChangeRequest,
  found: Assessment
): Promise<ChangeOutcome | null> {
  if (found.missing)
    return { kind: 'precondition_required', current: found.current };
  if (found.stale) {
    const expected = request.expectedRevision ?? 0;
    await failed(deps, request, {
      reason: 'conflict',
      expected,
      current: found.current,
    });
    return { kind: 'conflict', current: found.current, expected };
  }
  if (found.blocked.length === 0) return null;
  await failed(deps, request, {
    reason: 'unacknowledged_warnings',
    codes: found.blocked.map((issue) => issue.code),
  });
  return { kind: 'unsafe', issues: found.blocked, impact: found.impact };
}

async function write(
  deps: AppDeps,
  request: ChangeRequest,
  found: Assessment
): Promise<ChangeOutcome> {
  try {
    const row = await deps.store.putSettings(
      request.scope,
      request.value,
      authorLabel(request),
      request.expectedRevision ?? 0
    );
    await deps.store.audit({
      actor: request.actor,
      actorRole: 'admin',
      action: ACTIONS[request.cause],
      targetKind: 'settings',
      targetId: request.scope,
      detail: {
        fromRevision: found.current,
        toRevision: row.revision,
        changedNodes: found.impact.changes.length,
        acknowledged: found.impact.issues
          .filter((issue) => request.acknowledge.includes(issue.code))
          .map((issue) => issue.code),
        ...(request.restoredFrom === undefined
          ? {}
          : { restoredFrom: request.restoredFrom }),
      },
    });
    await recordImpact(deps, request.scope, found.impact);
    return { kind: 'written', row, impact: found.impact };
  } catch (error) {
    if (!(error instanceof SettingsConflictError)) throw error;
    await failed(deps, request, {
      reason: 'conflict',
      expected: error.expected,
      current: error.current,
    });
    return {
      kind: 'conflict',
      current: error.current,
      expected: error.expected,
    };
  }
}

/**
 * The one way settings are written, from the API and the dashboard alike:
 * precondition, optimistic concurrency, impact analysis, acknowledgement,
 * the atomic write, and the audit entry.
 */
export async function changeSettings(
  deps: AppDeps,
  request: ChangeRequest
): Promise<ChangeOutcome> {
  const found = await assess(deps, request);
  if (request.dryRun)
    return {
      kind: 'dry_run',
      revision: found.current,
      impact: found.impact,
      blockedBy: found.blocked,
      conflict: found.stale,
      preconditionMissing: found.missing,
    };
  return (await refusal(deps, request, found)) ?? write(deps, request, found);
}
