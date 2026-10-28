import { createLogger, errorDetails } from '@pkgs/logger';

import type { Operation } from '../domain/operations';
import type { Store } from '../store';
import type { AuditOutcome, NodeRow, Severity } from '../types';

/** What the operations service needs: storage and a clock. */
export interface OpsDeps {
  readonly store: Store;
  readonly now: () => Date;
}

const log = createLogger({ name: 'fleet-operations' });

/** Never throws: a failing audit or event write must not undo or hide the action. */
export async function auditAction(
  deps: OpsDeps,
  entry: {
    readonly actor: string;
    readonly action: string;
    readonly targetKind?: string;
    readonly targetId: string | null;
    readonly outcome?: AuditOutcome;
    readonly detail?: Readonly<Record<string, unknown>>;
  }
): Promise<void> {
  try {
    await deps.store.audit({ targetKind: 'node', ...entry });
  } catch (error) {
    log.error('audit write failed', {
      action: entry.action,
      error: errorDetails(error),
    });
  }
}

export interface NodeEventDraft {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export async function nodeEvent(
  deps: OpsDeps,
  node: Pick<NodeRow, 'id' | 'hostname' | 'displayName'>,
  event: NodeEventDraft
): Promise<void> {
  try {
    await deps.store.addEvent({
      nodeId: node.id,
      nodeLabel: node.displayName ?? node.hostname,
      kind: event.kind,
      severity: event.severity,
      message: event.message,
      data: event.data ?? {},
    });
  } catch (error) {
    log.error('event write failed', {
      kind: event.kind,
      error: errorDetails(error),
    });
  }
}

export function logFailure(
  message: string,
  op: Pick<Operation, 'id' | 'kind'>,
  error: unknown
): void {
  log.error(message, {
    operation: op.id,
    kind: op.kind,
    error: errorDetails(error),
  });
}
