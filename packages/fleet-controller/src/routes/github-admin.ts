import type { Context, Hono } from 'hono';

import type { AppDeps } from '../deps';
import { parseIntegration } from '../github/policy';
import type { GithubRuntime } from '../github/runtime';
import { requestSync } from '../github/sync';
import type { JobQuery } from '../github/types';
import { verifyConnection } from '../github/verify';
import { jobRows, runnersView } from '../github/views';

import { adminRoute, roleOf } from './guards';
import { controllerError, invalidBody, readJson } from './http';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const JOB_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'failed',
  'active',
] as const;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function whole(
  raw: string | undefined,
  min: number,
  max: number
): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  return value >= min && value <= max ? value : null;
}

type Parsed =
  | { readonly ok: true; readonly query: JobQuery }
  | { readonly ok: false; readonly message: string };

function filterProblem(
  status: string | undefined,
  repository: string | undefined,
  node: string | undefined
): string | null {
  if (status && !(JOB_STATUSES as readonly string[]).includes(status))
    return `status must be one of ${JOB_STATUSES.join(', ')}`;
  if (repository && !REPOSITORY.test(repository))
    return 'repository must be owner/name';
  if (node && !/^[0-9a-f]{64}$/.test(node))
    return 'node must be a 64 character node id';
  return null;
}

/** `status`, `repository`, `node`, `before` (a job id) and `limit`. */
export function parseJobQuery(c: Context): Parsed {
  const status = c.req.query('status');
  const repository = c.req.query('repository');
  const node = c.req.query('node');
  const before = whole(c.req.query('before'), 1, Number.MAX_SAFE_INTEGER);
  const limit = whole(c.req.query('limit'), 1, MAX_LIMIT);
  const problem = filterProblem(status, repository, node);
  if (problem !== null) return { ok: false, message: problem };
  if (before === null)
    return { ok: false, message: 'before must be a positive whole number' };
  if (limit === null)
    return { ok: false, message: `limit must be between 1 and ${MAX_LIMIT}` };
  return {
    ok: true,
    query: {
      limit: limit ?? DEFAULT_LIMIT,
      ...(status ? { status: status as (typeof JOB_STATUSES)[number] } : {}),
      ...(repository ? { repository } : {}),
      ...(node ? { nodeId: node } : {}),
      ...(typeof before === 'number' ? { beforeId: before } : {}),
    },
  };
}

function unavailable(c: Context): Response {
  return controllerError(
    c,
    404,
    'github_unavailable',
    'The GitHub integration is not available in this mode.'
  );
}

async function listJobs(deps: AppDeps, runtime: GithubRuntime, c: Context) {
  const parsed = parseJobQuery(c);
  if (!parsed.ok)
    return controllerError(c, 400, 'invalid_request', parsed.message);
  const [jobs, nodes] = await Promise.all([
    runtime.store.listJobs(parsed.query),
    deps.store.listNodes(),
  ]);
  const last = jobs[jobs.length - 1];
  const more = jobs.length === parsed.query.limit && last !== undefined;
  return c.json({
    jobs: jobRows(jobs, nodes, deps.now()),
    nextBefore: more ? last.id : null,
  });
}

async function saveIntegration(
  deps: AppDeps,
  runtime: GithubRuntime,
  c: Context,
  actor: string
): Promise<Response> {
  const body = await readJson(c);
  if (!body.ok) return body.response;
  const parsed = parseIntegration(body.value);
  const role = await roleOf(deps, c);
  if (!parsed.ok) {
    await deps.store.audit({
      actor,
      actorRole: role,
      action: 'github.integration.update',
      targetKind: 'github-integration',
      targetId: '1',
      outcome: 'failed',
      detail: { errors: parsed.errors },
    });
    return invalidBody(c, 'invalid_settings', parsed.errors);
  }
  const saved = await runtime.store.putIntegration(
    parsed.value,
    actor,
    deps.now()
  );
  requestSync(runtime);
  await deps.store.audit({
    actor,
    actorRole: role,
    action: 'github.integration.update',
    targetKind: 'github-integration',
    targetId: '1',
    detail: {
      scope: saved.scope,
      organization: saved.organization,
      repositories: [...saved.repositories],
      runnerGroup: saved.runnerGroup,
      appId: saved.appId,
      installationId: saved.installationId,
      policy: saved.policy,
    },
  });
  return c.json({ integration: saved });
}

async function verify(
  deps: AppDeps,
  runtime: GithubRuntime,
  c: Context,
  actor: string
): Promise<Response> {
  const result = await verifyConnection(runtime);
  const failedChecks = result.checks.filter((check) => !check.ok);
  if (result.ok) {
    await runtime.store.setStatus('ok', null, null);
  } else if (result.temporary) {
    await runtime.store.setStatus(
      'degraded',
      failedChecks[0]?.message ?? null,
      null
    );
  } else {
    const first = failedChecks[0];
    await runtime.store.setStatus(
      'error',
      first ? `${first.code ?? ''}: ${first.message}` : null,
      null
    );
  }
  await deps.store.audit({
    actor,
    actorRole: await roleOf(deps, c),
    action: 'github.verify',
    targetKind: 'github-integration',
    targetId: '1',
    outcome: result.ok ? 'success' : 'failed',
    detail: {
      failed: failedChecks.map((check) => ({
        name: check.name,
        code: check.code ?? null,
      })),
    },
  });
  return c.json(result);
}

/** `GET /v1/runners`, `GET /v1/jobs`, `PUT /v1/github/integration`, `POST /v1/github/verify`. */
export function mountGithubAdmin(app: Hono, deps: AppDeps): void {
  const { github } = deps;
  if (github === undefined) {
    for (const [method, path] of [
      ['GET', '/v1/runners'],
      ['GET', '/v1/jobs'],
      ['PUT', '/v1/github/integration'],
      ['POST', '/v1/github/verify'],
    ] as const) {
      app.on(
        method,
        path,
        adminRoute(deps, async (c) => unavailable(c))
      );
    }
    return;
  }
  app.get(
    '/v1/runners',
    adminRoute(deps, async (c) => {
      const view = await runnersView(github, deps);
      return c.json({ ...view, access: await roleOf(deps, c) });
    })
  );
  app.get(
    '/v1/jobs',
    adminRoute(deps, (c) => listJobs(deps, github, c))
  );
  app.put(
    '/v1/github/integration',
    adminRoute(deps, (c, actor) => saveIntegration(deps, github, c, actor))
  );
  app.post(
    '/v1/github/verify',
    adminRoute(deps, (c, actor) => verify(deps, github, c, actor))
  );
}
