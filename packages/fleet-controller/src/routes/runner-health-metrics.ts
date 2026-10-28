import type { AppDeps } from '../deps';
import { loadHealthInput, runnerHealthView } from '../github/health';

const HELP: Record<string, string> = {
  fleet_runner_queue_stalled:
    '1 when a queued fleet job has waited past the stall threshold with no idle runner able to take it, else 0.',
  fleet_runners_online:
    'Fleet runners GitHub lists as online. Omitted when the GitHub integration is unconfigured or its mirror is stale.',
  fleet_ci_jobs_queued_oldest_seconds:
    'Seconds the oldest queued fleet job has waited (0 with an empty queue).',
};

/**
 * Prometheus lines for CI runner health, from the mirrored GitHub data. Empty
 * (not zero) without a GitHub integration or while its mirror is stale, so an
 * alert never fires on, or is silenced by, data nobody has.
 */
export async function runnerHealthMetrics(deps: AppDeps): Promise<string[]> {
  const { github } = deps;
  if (github === undefined) return [];
  const integration = await github.store.getIntegration();
  const input = await loadHealthInput(
    github,
    deps.store,
    integration,
    deps.now()
  );
  if (!input.active) return [];
  const view = runnerHealthView(input, integration);
  const lines = {
    fleet_runner_queue_stalled: view.queueStalled ? 1 : 0,
    fleet_runners_online: view.runnersOnline,
    fleet_ci_jobs_queued_oldest_seconds: view.oldestQueuedSeconds,
  };
  return Object.entries(lines).flatMap(([name, value]) => [
    `# HELP ${name} ${HELP[name] ?? ''}`,
    `# TYPE ${name} gauge`,
    `${name} ${value}`,
  ]);
}
