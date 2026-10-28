import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Store } from '../store';

import { jobFromGithub, record, repositoryOf, text } from './normalize';
import { nodeForRunner, parseRunnerName } from './runner-names';
import type { GithubRuntime } from './runtime';
import { requestSync } from './sync';

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const DELIVERY = /^[A-Za-z0-9-]{8,64}$/;

/** Constant-time check of `X-Hub-Signature-256` over the raw body. */
export function validSignature(
  secret: string,
  body: string,
  header: string | undefined
): boolean {
  const claimed = SIGNATURE.exec(header ?? '')?.[1];
  if (claimed === undefined) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(claimed, 'hex'));
}

export function validDelivery(id: string | undefined): id is string {
  return id !== undefined && DELIVERY.test(id);
}

export type WebhookResult =
  'ignored' | 'job' | 'sync-requested' | 'pong' | 'duplicate';

async function monitored(
  runtime: GithubRuntime,
  repository: string
): Promise<boolean> {
  const integration = await runtime.store.getIntegration();
  if (integration.status === 'unconfigured') return false;
  if (integration.repositories.length > 0)
    return integration.repositories.includes(repository);
  const owner = repository.split('/')[0] ?? '';
  return (
    integration.scope === 'organization' && owner === integration.organization
  );
}

async function handleJob(
  runtime: GithubRuntime,
  store: Store,
  payload: Record<string, unknown>
): Promise<WebhookResult> {
  const repository = repositoryOf(payload['repository']);
  if (repository === null || !(await monitored(runtime, repository)))
    return 'ignored';
  const job = jobFromGithub(
    payload['workflow_job'],
    repository,
    'webhook',
    runtime.now()
  );
  if (job === null) return 'ignored';
  const identity =
    job.runnerName === null ? null : parseRunnerName(job.runnerName);
  const node =
    identity === null ? null : nodeForRunner(identity, await store.listNodes());
  await runtime.store.upsertJobs([{ ...job, nodeId: node?.id ?? null }]);
  return 'job';
}

/**
 * A verified webhook. `workflow_job` events are stored at once (an older state
 * never replaces a newer one); `workflow_run` events ask the poller to run now.
 * Everything else is ignored, and polling remains the source of truth.
 */
export async function handleWebhook(
  runtime: GithubRuntime,
  store: Store,
  event: string | undefined,
  payload: unknown
): Promise<WebhookResult> {
  const body = record(payload);
  if (event === 'ping') return 'pong';
  if (event === 'workflow_job' && text(body['action']) !== null)
    return handleJob(runtime, store, body);
  if (event === 'workflow_run') {
    requestSync(runtime);
    return 'sync-requested';
  }
  return 'ignored';
}
