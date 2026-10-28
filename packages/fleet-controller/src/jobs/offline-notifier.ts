import { errorDetails, type Logger } from '@pkgs/logger';

import {
  effectiveConfig,
  offlineAfterSeconds,
} from '../domain/effective-config';
import type { GithubRuntime } from '../github/runtime';
import type { IssuesRuntime } from '../issues/runtime';
import type { Store } from '../store';
import type { NodeRow } from '../types';

import { postWebhook } from './webhook';

export interface JobDeps {
  readonly store: Store;
  readonly now: () => Date;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>;
  readonly log: Logger;
  /** The GitHub integration, when the controller runs it (jobs/github-sync.ts). */
  readonly github?: GithubRuntime | undefined;
  /** One-click issue reporting, when the controller runs it (jobs/issue-sync.ts). */
  readonly issues?: IssuesRuntime | undefined;
  /** Heartbeat history retention in days (jobs/retention.ts); 30 when absent. */
  readonly heartbeatRetentionDays?: number | undefined;
}

/** The smallest `alerts.offlineAfterSeconds` the schema allows. */
const MIN_OFFLINE_AFTER_SECONDS = 60;

function silentSeconds(node: NodeRow, now: Date): number {
  const since = node.lastSeenAt ?? node.approvedAt ?? node.firstSeenAt;
  return (now.getTime() - since.getTime()) / 1000;
}

async function announce(
  deps: JobDeps,
  node: NodeRow,
  webhookUrl: string | null | undefined,
  now: Date
): Promise<boolean> {
  const label = node.displayName ?? node.hostname;
  const silent = Math.round(silentSeconds(node, now));
  // The claim is atomic: when sweeps overlap, only one of them announces.
  if (!(await deps.store.claimOfflineNotice(node.id, now))) return false;
  await deps.store.addEvent({
    nodeId: node.id,
    nodeLabel: label,
    kind: 'offline',
    severity: 'error',
    message: `${label} has not reported for ${silent} seconds`,
    data: {
      silentSeconds: silent,
      lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    },
  });
  if (webhookUrl === undefined || webhookUrl === null) return true;
  await postWebhook(deps, webhookUrl, {
    text: `${label} (${node.role ?? 'unassigned'}) is offline: no report for ${silent} seconds`,
    kind: 'offline',
    node: { id: node.id, label, role: node.role, hostname: node.hostname },
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    at: now.toISOString(),
  });
  return true;
}

/**
 * One pass of the offline notifier. Each outage is announced once: the node is
 * marked before anything else, and a report from the node clears the mark.
 * Returns how many nodes were announced.
 */
export async function runOfflineSweep(deps: JobDeps): Promise<number> {
  const now = deps.now();
  const settings = await deps.store.listSettings();
  const candidates = await deps.store.nodesDueOfflineNotice(
    now,
    MIN_OFFLINE_AFTER_SECONDS
  );
  let announced = 0;
  for (const node of candidates) {
    const config = effectiveConfig(settings, node);
    if (silentSeconds(node, now) <= offlineAfterSeconds(config)) continue;
    try {
      if (await announce(deps, node, config.alerts?.webhookUrl, now))
        announced += 1;
    } catch (err: unknown) {
      deps.log.error('offline notice failed', {
        node: node.id,
        error: errorDetails(err),
      });
    }
  }
  return announced;
}
