import type { Fetched, Http, Reply } from './http';
import type { Report } from './report';

export interface CheckOptions {
  readonly adminToken: string;
  readonly wrongToken: string;
  readonly expectSchema: number;
  readonly requireGithub: boolean;
}

export interface Ctx {
  readonly http: Http;
  readonly report: Report;
  readonly options: CheckOptions;
}

/** The highest schema this script knows how to probe from the outside. */
export const KNOWN_SCHEMA = 3;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function unreachable(c: Ctx, name: string, got: Fetched & { ok: false }) {
  c.report.fail(
    name,
    `no answer after ${got.attempts} attempts (${got.reason}). The service is not up or not reachable at this URL: check that the deploy finished, the service is running and the address and port are right.`
  );
}

/** A reply, or null after recording why there is none. */
async function reply(c: Ctx, name: string, path: string, token?: string) {
  const got = await c.http.get(path, token);
  if (got.ok) return got.reply;
  unreachable(c, name, got);
  return null;
}

function noStore(c: Ctx, name: string, answer: Reply): void {
  const cache = answer.headers.get('cache-control') ?? '';
  if (!cache.toLowerCase().includes('no-store'))
    c.report.fail(
      name,
      `response lacks "Cache-Control: no-store" (got "${cache}"). A proxy or CDN in front of the controller may be rewriting headers, or an old release is serving; admin responses must never be cached.`
    );
}

/** /health must answer 200 with ok: the database and the heartbeat schema are readable. */
export async function checkHealth(c: Ctx): Promise<boolean> {
  const answer = await reply(c, 'health', '/health');
  if (answer === null) return false;
  if (answer.status !== 200 || record(answer.json)['ok'] !== true) {
    c.report.fail(
      'health',
      `GET /health answered HTTP ${answer.status}, not 200 {"ok":true}. The process is up but not healthy (database or schema); read the controller logs for a "health check failed" or schema error.`
    );
    return false;
  }
  c.report.pass('health', 'HTTP 200 {"ok":true}');
  noStore(c, 'health headers', answer);
  return true;
}

/** Nobody gets in without the admin token: no credentials and a wrong one are both 401. */
export async function checkAuthBoundary(c: Ctx): Promise<void> {
  const cases: [string, string | undefined][] = [
    ['no credentials', undefined],
    ['a wrong admin token', c.options.wrongToken],
  ];
  for (const [label, token] of cases) {
    const answer = await reply(c, 'auth boundary', '/v1/nodes', token);
    if (answer === null) return;
    if (answer.status === 401) {
      c.report.pass('auth boundary', `GET /v1/nodes with ${label} is 401`);
      noStore(c, 'auth boundary headers', answer);
    } else {
      c.report.fail(
        'auth boundary',
        `GET /v1/nodes with ${label} answered HTTP ${answer.status}, expected 401. The admin API must refuse unauthenticated callers: do not expose this deployment until that is fixed.`
      );
    }
  }
}

function authorizedProblem(answer: Reply): string | null {
  if (answer.status === 401)
    return 'the controller rejected FLEET_ADMIN_TOKEN (HTTP 401). The token given to this check is not the one the controller runs with (a rotation not yet deployed, or the wrong secret).';
  if (answer.status !== 200)
    return `HTTP ${answer.status}, expected 200. Read the controller logs for the failing request.`;
  return null;
}

async function authorized(
  c: Ctx,
  name: string,
  path: string
): Promise<Reply | null> {
  const answer = await reply(c, name, path, c.options.adminToken);
  if (answer === null) return null;
  const problem = authorizedProblem(answer);
  if (problem !== null) {
    c.report.fail(name, `GET ${path}: ${problem}`);
    return null;
  }
  noStore(c, name, answer);
  return answer;
}

/** The admin token works and the nodes list is the shape the dashboard reads. Returns false if the token is refused. */
export async function checkNodes(c: Ctx): Promise<boolean> {
  const answer = await authorized(c, 'nodes', '/v1/nodes');
  if (answer === null) return false;
  const nodes = record(answer.json)['nodes'];
  if (!Array.isArray(nodes)) {
    c.report.fail('nodes', 'GET /v1/nodes did not return a "nodes" array.');
    return false;
  }
  if (/secret_?hash/i.test(answer.text))
    c.report.fail(
      'nodes',
      'GET /v1/nodes exposes a secret hash field; node secrets must never leave the database.'
    );
  else c.report.pass('nodes', `authenticated, ${nodes.length} node(s) listed`);
  return true;
}

export async function checkSummary(c: Ctx): Promise<void> {
  const answer = await authorized(c, 'summary', '/v1/summary');
  if (answer === null) return;
  if (Object.keys(record(answer.json)).length === 0)
    c.report.fail('summary', 'GET /v1/summary returned no fields.');
  else c.report.pass('summary', 'readable');
}

export async function checkAudit(c: Ctx): Promise<void> {
  const answer = await authorized(c, 'audit', '/v1/audit?limit=1');
  if (answer === null) return;
  if (Array.isArray(record(answer.json)['entries']))
    c.report.pass('audit', 'audit log readable');
  else
    c.report.fail('audit', 'GET /v1/audit did not return an "entries" array.');
}

/** Schema 3 shows from outside as: the audit log, settings revisions and operations all answer. */
export async function checkSchema(c: Ctx): Promise<void> {
  const wanted = c.options.expectSchema;
  if (wanted > KNOWN_SCHEMA) {
    c.report.fail(
      'schema',
      `--expect-schema ${wanted}: this check only knows how to probe up to schema ${KNOWN_SCHEMA}. Update scripts/post-deploy/checks.ts with the new schema's markers.`
    );
    return;
  }
  if (wanted < KNOWN_SCHEMA) {
    c.report.pass('schema', `no probes for schema ${wanted}; skipped`);
    return;
  }
  const hint =
    'An older release is serving or the database upgrade did not run. Read the controller start-up logs for a schema error, and do not delete the database.';
  const settings = await authorized(c, 'schema', '/v1/settings/fleet');
  const operations = await authorized(c, 'schema', '/v1/operations?limit=1');
  if (settings === null || operations === null) {
    c.report.fail('schema', `schema ${wanted} markers are missing. ${hint}`);
    return;
  }
  if (typeof record(settings.json)['revision'] !== 'number')
    c.report.fail('schema', `settings carry no revision (schema 2). ${hint}`);
  else
    c.report.pass(
      'schema',
      `schema ${wanted} markers present (revisions, operations, audit)`
    );
}

type GithubState =
  | { readonly state: 'ready' | 'unconfigured' | 'unavailable' }
  | { readonly state: 'degraded' | 'error'; readonly detail: string };

function githubStateOf(answer: Reply): GithubState | null {
  if (answer.status === 404) return { state: 'unavailable' };
  if (answer.status !== 200) return null;
  const integration = record(record(answer.json)['integration']);
  const status = integration['status'];
  if (status === 'ok') return { state: 'ready' };
  if (status === 'unconfigured') return { state: 'unconfigured' };
  const last = integration['lastError'];
  const detail = typeof last === 'string' ? last.slice(0, 200) : 'no detail';
  if (status === 'degraded' || status === 'error')
    return { state: status, detail };
  return null;
}

const GITHUB_ADVICE: Record<string, string> = {
  ready: 'GitHub integration is connected and syncing',
  unconfigured:
    'GitHub integration is not configured (optional: runners and jobs stay empty). Open Runners in the dashboard to connect it',
  unavailable:
    'GitHub integration is not available in this deployment mode (optional)',
};

/** Reports `unconfigured`, `ready` and `error` apart; only `error` (or anything short of ready with --require-github) fails. */
export async function checkGithub(c: Ctx): Promise<void> {
  const answer = await reply(c, 'github', '/v1/runners', c.options.adminToken);
  if (answer === null) return;
  const found = githubStateOf(answer);
  if (found === null) {
    c.report.fail(
      'github',
      `GET /v1/runners answered HTTP ${answer.status} with an unexpected body.`
    );
    return;
  }
  noStore(c, 'github', answer);
  const detail =
    'detail' in found
      ? found.detail
      : (GITHUB_ADVICE[found.state] ?? found.state);
  const required = c.options.requireGithub;
  if (found.state === 'ready') c.report.pass('github', `ready: ${detail}`);
  else if (found.state === 'error')
    c.report.fail(
      'github',
      `error: ${detail}. The integration is configured but GitHub refuses it: Verify connection on the Runners page names the permission, installation or key to fix.`
    );
  else if (required)
    c.report.fail(
      'github',
      `${found.state}, but --require-github was set: ${detail}`
    );
  else if (found.state === 'degraded')
    c.report.warn(
      'github',
      `degraded: ${detail}. The controller retries by itself; look again if it persists.`
    );
  else c.report.pass('github', `${found.state}: ${detail}`);
}
