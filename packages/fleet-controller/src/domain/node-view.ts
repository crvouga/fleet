import type { FleetConfig } from '../config/schema';
import type { NodeRow, NodeView } from '../types';

import { convergenceOf, desiredFor } from './desired-state';
import { AGE_RECIPIENT_PATTERN } from './desired-validation';
import { offlineAfterSeconds } from './effective-config';
import { statusOf } from './status';

/**
 * The next age recipient a node reported while its identity rotation is
 * pending. Kept in the stored facts (no column); re-checked on the way out.
 */
export function ageRecipientNextOf(row: Pick<NodeRow, 'facts'>): string | null {
  const value = row.facts['ageRecipientNext'];
  return typeof value === 'string' && AGE_RECIPIENT_PATTERN.test(value)
    ? value
    : null;
}

/**
 * A row plus what the dashboard derives from it. `config` is the node's
 * effective settings (resolved against its assigned role): it sets the
 * offline threshold and the desired document the node is judged against.
 */
export function viewOf(row: NodeRow, now: Date, config: FleetConfig): NodeView {
  const desired = desiredFor(row, config);
  return {
    ...row,
    status: statusOf(row, now, offlineAfterSeconds(config)),
    shortId: row.id.slice(0, 4),
    label: row.displayName ?? row.hostname,
    ageSeconds:
      row.lastSeenAt === null
        ? null
        : Math.max(
            0,
            Math.round((now.getTime() - row.lastSeenAt.getTime()) / 1000)
          ),
    hardwareCapabilities: row.hardware?.capabilities ?? [],
    desiredClosure: desired.closure,
    desiredRevision: desired.revision,
    convergence: convergenceOf(row, desired),
    reconcileIssues: row.reconcile?.issues ?? [],
    ageRecipientNext: ageRecipientNextOf(row),
  };
}
