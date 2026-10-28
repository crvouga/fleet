import { errorDetails } from '@pkgs/logger';

import {
  effectiveConfig,
  type SettingsSubject,
} from '../domain/effective-config';
import {
  EMPTY_MEMORY,
  observeRunnerHealth,
  openConditions,
  RUNNER_HEALTH_EVENT_KINDS,
  stepRunnerHealth,
  thresholdsOf,
  type HealthEvent,
  type HealthMemory,
} from '../domain/runner-health';
import { loadHealthInput } from '../github/health';
import type { GithubRuntime } from '../github/runtime';
import type { SettingsRow } from '../types';

import type { JobDeps } from './offline-notifier';
import { postWebhook } from './webhook';

const EVENT_WINDOW = 500;
/** Only the fleet scope applies to an event about no node in particular. */
const FLEET_SUBJECT: SettingsSubject = { id: 'fleet', role: null };

/** Timers of conditions still waiting to open or close. Lost on restart, which only delays. */
const memories = new WeakMap<GithubRuntime, HealthMemory>();

async function webhookUrl(
  rows: readonly SettingsRow[],
  deps: JobDeps,
  event: HealthEvent
): Promise<string | null> {
  const node =
    event.nodeId === null ? null : await deps.store.findNode(event.nodeId);
  const config = effectiveConfig(
    rows,
    node === null ? FLEET_SUBJECT : { id: node.id, role: node.role }
  );
  return config.alerts?.webhookUrl ?? null;
}

async function announce(deps: JobDeps, events: readonly HealthEvent[]) {
  const rows = await deps.store.listSettings();
  for (const event of events) {
    await deps.store.addEvent({
      nodeId: event.nodeId,
      nodeLabel: event.nodeLabel,
      kind: event.kind,
      severity: event.severity,
      message: event.message,
      data: event.data,
    });
    deps.log.info('runner health changed', {
      kind: event.kind,
      severity: event.severity,
      node: event.nodeId,
    });
    const url = await webhookUrl(rows, deps, event);
    if (url === null) continue;
    await postWebhook(deps, url, {
      text: event.message,
      kind: event.kind,
      severity: event.severity,
      node: event.nodeId === null ? null : { id: event.nodeId },
      at: deps.now().toISOString(),
    });
  }
}

/**
 * Derives the runner health incidents from the data the GitHub sync just
 * mirrored and records one event per change. Level-triggered and idempotent:
 * the open incidents are read back from the event stream, so a restart, or a
 * second pass over the same data, records nothing new. `fresh` is false when
 * the integration went away: open incidents then close after the usual hold.
 */
export async function runRunnerHealth(
  deps: JobDeps,
  runtime: GithubRuntime,
  fresh: boolean
): Promise<readonly HealthEvent[]> {
  const stored = await deps.store.listEvents({
    kinds: RUNNER_HEALTH_EVENT_KINDS,
    limit: EVENT_WINDOW,
  });
  const open = openConditions(stored);
  // No integration and nothing to close: do not even read the fleet.
  if (!fresh && open.size === 0) return [];
  const now = deps.now();
  const integration = await runtime.store.getIntegration();
  const thresholds = thresholdsOf(integration.policy);
  const input = await loadHealthInput(runtime, deps.store, integration, now);
  const observed = observeRunnerHealth(
    { ...input, active: input.active && fresh },
    thresholds
  );
  const step = stepRunnerHealth(
    observed,
    { open, memory: memories.get(runtime) ?? EMPTY_MEMORY },
    now,
    thresholds.clearSeconds
  );
  memories.set(runtime, step.memory);
  await announce(deps, step.events);
  return step.events;
}

/** Never throws: a failed evaluation is logged and tried again on the next pass. */
export async function runRunnerHealthSafely(
  deps: JobDeps,
  runtime: GithubRuntime,
  fresh: boolean
): Promise<void> {
  try {
    await runRunnerHealth(deps, runtime, fresh);
  } catch (error) {
    deps.log.error('runner health evaluation failed', {
      error: errorDetails(error),
    });
  }
}
