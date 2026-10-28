import type { AppDeps } from '../deps';
import { loadConfig } from '../routes/node-config';
import type { NodeRow } from '../types';

import { isGithubError } from './errors';
import { RUNNER_ROLE } from './runner-defaults';
import type { GithubRuntime } from './runtime';
import type { Integration, RunnerTarget } from './types';

export interface RegistrationRequest {
  readonly slot: number;
  readonly repository?: string;
  /** A node reuses it for retries of one registration attempt. */
  readonly idempotencyKey?: string;
}

export interface RegistrationGrant {
  readonly token: string;
  readonly scope: 'repository' | 'organization';
  readonly url: string;
  readonly target: string;
  readonly runnerGroup: string | null;
  readonly expiresAt: string | null;
}

export type RegistrationOutcome =
  | { readonly ok: true; readonly grant: RegistrationGrant }
  | {
      readonly ok: false;
      readonly status: 403 | 409 | 422 | 503;
      readonly error:
        'runner_not_allowed' | 'github_refused' | 'github_unavailable';
      readonly code: string;
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

const REPLAY_MS = 120_000;
const DEFAULT_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 300;
const MAX_REPLAYS = 1000;

interface Replay {
  readonly at: number;
  readonly grant: RegistrationGrant;
}

/** Mints for one (node, slot, target) at a time; a retry within two minutes replays. */
const inflight = new WeakMap<
  GithubRuntime,
  Map<string, Promise<RegistrationOutcome>>
>();
const replays = new WeakMap<GithubRuntime, Map<string, Replay>>();

function mapOf<T>(
  table: WeakMap<GithubRuntime, Map<string, T>>,
  runtime: GithubRuntime
): Map<string, T> {
  let found = table.get(runtime);
  if (found === undefined) {
    found = new Map();
    table.set(runtime, found);
  }
  return found;
}

function denied(code: string, message: string): RegistrationOutcome {
  return { ok: false, status: 403, error: 'runner_not_allowed', code, message };
}

/** Why this node may not register a runner right now, or null. */
export async function eligibility(
  deps: AppDeps,
  node: NodeRow
): Promise<
  | { readonly refusal: RegistrationOutcome }
  | { readonly assigned: readonly string[] }
> {
  if (node.approval !== 'approved')
    return {
      refusal: denied('node_not_approved', 'This node is not approved.'),
    };
  if (node.role !== RUNNER_ROLE)
    return {
      refusal: denied(
        'role_runs_no_runners',
        'This node runs a role without runners.'
      ),
    };
  const config = await loadConfig(deps.store, node);
  if (config.runners?.cordoned === true || config.runners?.enabled === false)
    return {
      refusal: denied(
        'runners_drained',
        'Runner admission is closed for this node (cordoned or disabled).'
      ),
    };
  return { assigned: config.runners?.repositories ?? [] };
}

function resolveTarget(
  integration: Integration,
  assigned: readonly string[],
  request: RegistrationRequest
): RunnerTarget | RegistrationOutcome {
  const slotRepository =
    assigned.length === 0
      ? undefined
      : assigned[(request.slot - 1) % assigned.length];
  const wanted =
    request.repository ??
    (integration.scope === 'repository' ? slotRepository : undefined);
  if (wanted !== undefined) {
    return assigned.includes(wanted)
      ? { scope: 'repository', name: wanted }
      : denied(
          'repository_not_assigned',
          'That repository is not assigned to this node.'
        );
  }
  return integration.scope === 'organization'
    ? { scope: 'organization', name: integration.organization }
    : denied(
        'no_repository_assigned',
        'No repository is assigned to this node.'
      );
}

async function mint(
  runtime: GithubRuntime,
  target: RunnerTarget
): Promise<RegistrationOutcome> {
  const connection = await runtime.connect();
  if (!connection.ok) {
    return {
      ok: false,
      status: 422,
      error: 'github_refused',
      code: connection.code,
      message: connection.message,
    };
  }
  try {
    const made = await connection.client.createRegistrationToken(target);
    return {
      ok: true,
      grant: {
        token: made.token,
        scope: target.scope,
        url: `https://github.com/${target.name}`,
        target: target.name,
        runnerGroup:
          target.scope === 'organization'
            ? connection.integration.runnerGroup
            : null,
        expiresAt: made.expiresAt,
      },
    };
  } catch (error) {
    if (!isGithubError(error)) throw error;
    if (error.temporary) {
      const seconds = Math.ceil(
        (error.retryAfterMs ?? DEFAULT_RETRY_SECONDS * 1000) / 1000
      );
      return {
        ok: false,
        status: 503,
        error: 'github_unavailable',
        code: error.code,
        message: error.message,
        retryAfterSeconds: Math.min(MAX_RETRY_SECONDS, Math.max(1, seconds)),
      };
    }
    return {
      ok: false,
      status: 422,
      error: 'github_refused',
      code: error.code,
      message: error.message,
    };
  }
}

function audit(
  deps: AppDeps,
  node: NodeRow,
  request: RegistrationRequest,
  outcome: RegistrationOutcome
) {
  return deps.store.audit({
    actor: `node:${node.id.slice(0, 8)}`,
    action: 'runner.registration',
    targetKind: 'node',
    targetId: node.id,
    outcome: outcome.ok
      ? 'success'
      : outcome.status === 403
        ? 'denied'
        : 'failed',
    detail: {
      slot: request.slot,
      ...(outcome.ok
        ? {
            scope: outcome.grant.scope,
            target: outcome.grant.target,
            expiresAt: outcome.grant.expiresAt,
          }
        : { code: outcome.code, repository: request.repository ?? null }),
    },
  });
}

/** Shares one GitHub call among concurrent requests; a retry with a key replays. */
async function dedupe(
  runtime: GithubRuntime,
  scope: {
    readonly node: string;
    readonly request: RegistrationRequest;
    readonly target: RunnerTarget;
  },
  work: () => Promise<RegistrationOutcome>
): Promise<RegistrationOutcome> {
  const { request } = scope;
  const now = runtime.now().getTime();
  const replay = mapOf(replays, runtime);
  const replayKey = `${scope.node}:${request.slot}:${request.idempotencyKey ?? ''}`;
  const known =
    request.idempotencyKey === undefined ? undefined : replay.get(replayKey);
  if (
    known !== undefined &&
    now - known.at < REPLAY_MS &&
    known.grant.target === scope.target.name
  )
    return { ok: true, grant: known.grant };
  const key = `${scope.node}:${request.slot}:${scope.target.name}`;
  const running = mapOf(inflight, runtime);
  const shared = running.get(key);
  if (shared !== undefined) return shared;
  const started = work().then((outcome) => {
    if (outcome.ok && request.idempotencyKey !== undefined) {
      replay.set(replayKey, { at: now, grant: outcome.grant });
      if (replay.size > MAX_REPLAYS)
        replay.delete(replay.keys().next().value as string);
    }
    return outcome;
  });
  running.set(key, started);
  try {
    return await started;
  } finally {
    running.delete(key);
  }
}

/**
 * A short-lived registration token for one runner slot of an approved, assigned,
 * not-drained node. Concurrent requests for the same (node, slot, target) share
 * one GitHub call; a retry with the same idempotency key replays the answer for
 * two minutes. The token is never audited, logged or stored.
 */
export async function registerRunner(
  deps: AppDeps,
  runtime: GithubRuntime,
  node: NodeRow,
  request: RegistrationRequest
): Promise<RegistrationOutcome> {
  const allowed = await eligibility(deps, node);
  if ('refusal' in allowed) {
    await audit(deps, node, request, allowed.refusal);
    return allowed.refusal;
  }
  const integration = await runtime.store.getIntegration();
  const target = resolveTarget(integration, allowed.assigned, request);
  if ('ok' in target) {
    await audit(deps, node, request, target);
    return target;
  }
  let minted = false;
  const outcome = await dedupe(
    runtime,
    { node: node.id, request, target },
    async () => {
      minted = true;
      return mint(runtime, target);
    }
  );
  if (minted) await audit(deps, node, request, outcome);
  return outcome;
}
