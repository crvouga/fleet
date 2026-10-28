/**
 * Live GitHub contract check. Runs the controller's real GitHub client against
 * a dedicated TEST GitHub App on a throwaway private repository or organization
 * and proves, end to end, what the fleet needs from GitHub to bring a runner up:
 *
 *   config -> app_jwt -> installation_token -> installation_reach ->
 *   runners_list (paged) -> registration_token -> rate_limit
 *
 * It registers no runner and runs no job. A registration token is minted to
 * prove the permission, its shape and expiry are asserted, and it is dropped:
 * never printed, logged, written to a file or a step summary.
 *
 * Environment (all required together; with none of them set the check skips):
 *   FLEET_LIVE_GITHUB_APP_ID              the test App's numeric ID
 *   FLEET_LIVE_GITHUB_INSTALLATION_ID     the numeric installation ID
 *   FLEET_LIVE_GITHUB_APP_PRIVATE_KEY     the App's RSA private key (PEM)
 *   FLEET_LIVE_GITHUB_TARGET              owner/repo, or the organization name
 *   FLEET_LIVE_GITHUB_SCOPE               repository (default) or organization
 *
 * Exit status: 0 pass or skipped, 1 the contract is broken (act on the
 * message), 2 GitHub was temporarily unavailable or rate limiting (rerun).
 * `--json` prints only the machine-readable result on stdout.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

import { parsePrivateKey } from '../src/github/app-jwt';
import { GithubClient } from '../src/github/client';
import { GithubError } from '../src/github/errors';
import type { FetchLike } from '../src/github/transport';
import type { RunnerTarget } from '../src/github/types';

export const LIVE_VARIABLES = [
  'FLEET_LIVE_GITHUB_APP_ID',
  'FLEET_LIVE_GITHUB_INSTALLATION_ID',
  'FLEET_LIVE_GITHUB_APP_PRIVATE_KEY',
  'FLEET_LIVE_GITHUB_TARGET',
] as const;

const DEFAULT_API_URL = 'https://api.github.com';
const MAX_TOKEN_LIFETIME_MS = 2 * 3600_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,512}$/;
const LOW_REMAINING = 100;

export type CheckName =
  | 'config'
  | 'app_jwt'
  | 'installation_token'
  | 'installation_reach'
  | 'runners_list'
  | 'registration_token'
  | 'rate_limit';

/** Why a check failed, in terms an operator can act on. */
export type Failure =
  | 'invalid_config'
  | 'bad_credential'
  | 'wrong_installation'
  | 'target_unreachable'
  | 'missing_runner_permission'
  | 'missing_runner_write_permission'
  | 'bad_token'
  | 'missing_rate_limit_headers'
  | 'temporary'
  | 'unexpected';

export interface CheckResult {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly failure?: Failure;
  /** The controller's public error code, when GitHub refused. */
  readonly code?: string;
  readonly status?: number;
  readonly message: string;
}

export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string | null;
  readonly resource: string | null;
  readonly usedPercent: number;
}

export interface ContractResult {
  readonly schema: 1;
  readonly outcome: 'pass' | 'fail' | 'skipped';
  /** 0 pass or skipped, 1 contract broken, 2 temporary. */
  readonly exitCode: 0 | 1 | 2;
  readonly scope: 'repository' | 'organization' | null;
  /** Never the full target: it names a private repository. */
  readonly targetHint: string | null;
  readonly checks: readonly CheckResult[];
  readonly runnersTotal: number | null;
  readonly runnersListPages: number | null;
  readonly rateLimit: RateLimit | null;
  readonly message: string;
}

export interface ContractOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Config {
  readonly appId: string;
  readonly installationId: string;
  readonly keyPem: string;
  readonly target: RunnerTarget;
  readonly apiUrl: string;
}

/** What the wrapped fetch saw. It keeps expiry times and rate limits, never a token. */
interface Observed {
  rateLimit: RateLimit | null;
  installationExpiry: string | null;
  runnerListPages: number;
  runnersTotal: number | null;
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

export function redactTarget(target: string): string {
  return target
    .split('/')
    .map((part) => `${part.slice(0, 1)}***`)
    .join('/');
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function rateLimitOf(headers: Headers): RateLimit | null {
  const limit = numberHeader(headers, 'x-ratelimit-limit');
  const remaining = numberHeader(headers, 'x-ratelimit-remaining');
  if (limit === null || remaining === null || limit <= 0) return null;
  const reset = numberHeader(headers, 'x-ratelimit-reset');
  return {
    limit,
    remaining,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource: headers.get('x-ratelimit-resource'),
    usedPercent: Math.round(((limit - remaining) / limit) * 100),
  };
}

async function expiryOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { expires_at?: unknown };
    return typeof body.expires_at === 'string' ? body.expires_at : null;
  } catch {
    return null;
  }
}

/** Wraps fetch to note rate-limit headers, token expiry and list paging. */
function observing(inner: FetchLike, seen: Observed): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init);
    const { pathname } = new URL(String(input));
    seen.rateLimit = rateLimitOf(response.headers) ?? seen.rateLimit;
    if (init?.method === 'GET' && /\/actions\/runners$/.test(pathname))
      seen.runnerListPages += 1;
    if (response.ok && pathname.endsWith('/access_tokens'))
      seen.installationExpiry = await expiryOf(response);
    return response;
  };
}

function readConfig(
  env: ContractOptions['env']
): { skip: true } | { problems: string[] } | { config: Config } {
  const missing = LIVE_VARIABLES.filter((name) => !present(env[name]));
  if (missing.length === LIVE_VARIABLES.length) return { skip: true };
  const problems = missing.map((name) => `${name} is not set`);
  const scope = env['FLEET_LIVE_GITHUB_SCOPE']?.trim() || 'repository';
  const target = env['FLEET_LIVE_GITHUB_TARGET']?.trim() ?? '';
  const appId = env['FLEET_LIVE_GITHUB_APP_ID']?.trim() ?? '';
  const installationId = env['FLEET_LIVE_GITHUB_INSTALLATION_ID']?.trim() ?? '';
  if (scope !== 'repository' && scope !== 'organization')
    problems.push('FLEET_LIVE_GITHUB_SCOPE must be repository or organization');
  if (appId !== '' && !/^[0-9]{1,20}$/.test(appId))
    problems.push('FLEET_LIVE_GITHUB_APP_ID must be a number');
  if (installationId !== '' && !/^[0-9]{1,20}$/.test(installationId))
    problems.push('FLEET_LIVE_GITHUB_INSTALLATION_ID must be a number');
  const shape =
    scope === 'organization'
      ? /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
      : /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (target !== '' && !shape.test(target))
    problems.push(
      `FLEET_LIVE_GITHUB_TARGET must be ${scope === 'organization' ? 'an organization name' : 'owner/repo'}`
    );
  const keyPem = (env['FLEET_LIVE_GITHUB_APP_PRIVATE_KEY'] ?? '')
    .replace(/\\n/g, '\n')
    .trim();
  if (keyPem !== '') {
    try {
      parsePrivateKey(keyPem);
    } catch {
      problems.push('FLEET_LIVE_GITHUB_APP_PRIVATE_KEY is not an RSA PEM key');
    }
  }
  if (problems.length > 0) return { problems };
  return {
    config: {
      appId,
      installationId,
      keyPem,
      target: {
        scope: scope === 'organization' ? 'organization' : 'repository',
        name: target,
      },
      apiUrl: env['FLEET_LIVE_GITHUB_API_URL']?.trim() || DEFAULT_API_URL,
    },
  };
}

function pass(name: CheckName, message: string): CheckResult {
  return { name, ok: true, message };
}

function permissionName(target: RunnerTarget): string {
  return target.scope === 'organization'
    ? "the organization permission 'Self-hosted runners' (Read and write)"
    : "the repository permission 'Administration' (Read and write)";
}

/**
 * Turns a client failure into an actionable result. The distinction between a
 * missing runner permission and every other failure comes from the client's own
 * classification (public code and HTTP status), never from a response body.
 */
export function classifyFailure(
  name: CheckName,
  error: unknown,
  target: RunnerTarget
): CheckResult {
  if (!(error instanceof GithubError)) {
    const kind = error instanceof Error ? error.name : 'error';
    return {
      name,
      ok: false,
      failure: 'unexpected',
      message: `unexpected ${kind}; rerun with the controller's tests to reproduce`,
    };
  }
  const base = { name, ok: false, code: error.code } as const;
  const status = error.status === null ? {} : { status: error.status };
  if (error.temporary) {
    return {
      ...base,
      ...status,
      failure: 'temporary',
      message: `${error.message}; this says nothing about the contract, rerun later`,
    };
  }
  const [failure, message] = permanentFailure(name, error, target);
  return { ...base, ...status, failure, message };
}

function permanentFailure(
  name: CheckName,
  error: GithubError,
  target: RunnerTarget
): [Failure, string] {
  const needs = permissionName(target);
  if (error.code === 'FLEET_GITHUB_KEY' && name === 'app_jwt')
    return [
      'bad_credential',
      'GitHub refused the App JWT: FLEET_LIVE_GITHUB_APP_ID or FLEET_LIVE_GITHUB_APP_PRIVATE_KEY is wrong, or the key was revoked',
    ];
  if (name === 'installation_token' && error.status === 404)
    return [
      'wrong_installation',
      'GitHub does not know this installation: FLEET_LIVE_GITHUB_INSTALLATION_ID is wrong or the App was uninstalled',
    ];
  if (error.status === 403 && name === 'registration_token')
    return [
      'missing_runner_write_permission',
      `the runner list works but a registration token was refused: grant ${needs}`,
    ];
  if (error.status === 403)
    return [
      'missing_runner_permission',
      `GitHub refused with HTTP 403: the App lacks the runner permission; grant ${needs}`,
    ];
  if (error.status === 404 && name !== 'app_jwt')
    return [
      'target_unreachable',
      `GitHub answered HTTP 404 for the ${target.scope}: install the App on it and check FLEET_LIVE_GITHUB_TARGET`,
    ];
  return [
    'bad_credential',
    `${error.message} (${error.code}); check the App credential and installation`,
  ];
}

interface Context {
  readonly client: GithubClient;
  readonly config: Config;
  readonly seen: Observed;
  readonly now: () => Date;
}

type Step = (ctx: Context) => Promise<CheckResult>;

const appJwt: Step = async ({ client }) => {
  const app = await client.getApp();
  return pass(
    'app_jwt',
    `App JWT accepted${app.slug === null ? '' : ` (app ${app.slug})`}`
  );
};

const installationToken: Step = async ({ client, seen, now }) => {
  await client.checkInstallation();
  const expiry = Date.parse(seen.installationExpiry ?? '');
  if (Number.isNaN(expiry) || expiry <= now().getTime()) {
    return {
      name: 'installation_token',
      ok: false,
      failure: 'bad_token',
      message: 'the installation token has no future expiry',
    };
  }
  return pass('installation_token', 'installation token minted, expiry valid');
};

const installationReach: Step = async ({ client, config }) => {
  const names = await client.listInstallationRepositories();
  if (config.target.scope === 'repository') {
    const wanted = config.target.name.toLowerCase();
    if (!names.some((name) => name.toLowerCase() === wanted)) {
      return {
        name: 'installation_reach',
        ok: false,
        failure: 'target_unreachable',
        message: `the installation reaches ${names.length} repositories but not the target: install the App on it`,
      };
    }
  }
  return pass(
    'installation_reach',
    `installation reaches ${names.length} repositories`
  );
};

const runnersList: Step = async ({ client, config, seen }) => {
  const runners = await client.listRunners(config.target);
  seen.runnersTotal = runners.length;
  return pass(
    'runners_list',
    `${runners.length} runners listed in ${Math.max(1, seen.runnerListPages)} page(s)`
  );
};

const registrationToken: Step = async ({ client, config, now }) => {
  const minted = await client.createRegistrationToken(config.target);
  const expiry = Date.parse(minted.expiresAt ?? '');
  const lifetime = expiry - now().getTime();
  const problem = !TOKEN_SHAPE.test(minted.token)
    ? 'the registration token has an unexpected shape'
    : Number.isNaN(expiry) || lifetime <= 0
      ? 'the registration token has no future expiry'
      : lifetime > MAX_TOKEN_LIFETIME_MS
        ? 'the registration token lives longer than two hours'
        : null;
  if (problem !== null)
    return {
      name: 'registration_token',
      ok: false,
      failure: 'bad_token',
      message: problem,
    };
  return pass(
    'registration_token',
    `registration token minted and discarded (expires in ${Math.round(lifetime / 60_000)} min)`
  );
};

const rateLimit: Step = ({ seen }) => {
  const info = seen.rateLimit;
  if (info === null)
    return Promise.resolve({
      name: 'rate_limit' as const,
      ok: false,
      failure: 'missing_rate_limit_headers' as const,
      message:
        'GitHub sent no X-RateLimit headers; the controller cannot see its budget',
    });
  const low =
    info.remaining < LOW_REMAINING ? ' (low: reruns may be refused)' : '';
  return Promise.resolve(
    pass(
      'rate_limit',
      `${info.remaining} of ${info.limit} requests left${info.resource === null ? '' : ` (${info.resource})`}${low}`
    )
  );
};

const STEPS: readonly Step[] = [
  appJwt,
  installationToken,
  installationReach,
  runnersList,
  registrationToken,
  rateLimit,
];

const STEP_NAMES: readonly CheckName[] = [
  'app_jwt',
  'installation_token',
  'installation_reach',
  'runners_list',
  'registration_token',
  'rate_limit',
];

function summary(
  outcome: ContractResult['outcome'],
  checks: readonly CheckResult[]
): ContractResult['message'] {
  const failed = checks.find((check) => !check.ok);
  if (outcome === 'pass') return 'The live GitHub contract holds.';
  return failed === undefined ? 'skipped' : `${failed.name}: ${failed.message}`;
}

function resultOf(
  config: Config,
  checks: CheckResult[],
  seen: Observed
): ContractResult {
  const failed = checks.find((check) => !check.ok);
  const exitCode =
    failed === undefined ? 0 : failed.failure === 'temporary' ? 2 : 1;
  const outcome = failed === undefined ? 'pass' : 'fail';
  const listed = checks.find((c) => c.name === 'runners_list' && c.ok);
  return {
    schema: 1,
    outcome,
    exitCode,
    scope: config.target.scope,
    targetHint: redactTarget(config.target.name),
    checks,
    runnersTotal: listed === undefined ? null : seen.runnersTotal,
    runnersListPages:
      listed === undefined ? null : Math.max(1, seen.runnerListPages),
    rateLimit: seen.rateLimit,
    message: summary(outcome, checks),
  };
}

function skipped(message: string): ContractResult {
  return {
    schema: 1,
    outcome: 'skipped',
    exitCode: 0,
    scope: null,
    targetHint: null,
    checks: [],
    runnersTotal: null,
    runnersListPages: null,
    rateLimit: null,
    message,
  };
}

/** Runs the contract. Never throws: every failure is a classified check. */
export async function runContract(
  options: ContractOptions
): Promise<ContractResult> {
  const parsed = readConfig(options.env);
  if ('skip' in parsed) {
    return skipped(
      `${LIVE_VARIABLES.join(', ')} are not set: the live GitHub contract was skipped, nothing was checked`
    );
  }
  if ('problems' in parsed) {
    const check: CheckResult = {
      name: 'config',
      ok: false,
      failure: 'invalid_config',
      message: parsed.problems.join('; '),
    };
    return {
      ...skipped(`config: ${check.message}`),
      outcome: 'fail',
      exitCode: 1,
      checks: [check],
    };
  }
  const { config } = parsed;
  const seen: Observed = {
    rateLimit: null,
    installationExpiry: null,
    runnerListPages: 0,
    runnersTotal: null,
  };
  const client = new GithubClient({
    apiUrl: config.apiUrl,
    appId: config.appId,
    installationId: config.installationId,
    key: parsePrivateKey(config.keyPem),
    fetch: observing(options.fetch, seen),
    now: options.now,
    retry: { maxAttempts: 2, timeoutMs: 20_000 },
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const ctx: Context = { client, config, seen, now: options.now };
  const checks: CheckResult[] = [
    pass('config', 'configuration is complete and well formed'),
  ];
  for (const [index, step] of STEPS.entries()) {
    try {
      checks.push(await step(ctx));
    } catch (error) {
      checks.push(
        classifyFailure(STEP_NAMES[index] ?? 'config', error, config.target)
      );
    }
    if (checks.at(-1)?.ok === false) break;
  }
  return resultOf(config, checks, seen);
}

const LABEL: Record<ContractResult['outcome'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIPPED',
};

/** A redacted human summary; contains no token, key, App ID or full target name. */
export function humanSummary(result: ContractResult): string {
  const lines = [`Live GitHub contract: ${LABEL[result.outcome]}`];
  if (result.targetHint !== null)
    lines.push(`  target: ${result.scope} ${result.targetHint}`);
  for (const check of result.checks)
    lines.push(
      `  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.message}`
    );
  if (result.rateLimit !== null) {
    const r = result.rateLimit;
    lines.push(
      `  rate limit: ${r.remaining}/${r.limit} left, ${r.usedPercent}% used, resets ${r.resetAt ?? 'unknown'}`
    );
  }
  if (result.outcome !== 'pass') lines.push(`  ${result.message}`);
  return lines.join('\n');
}

function markdown(result: ContractResult): string {
  const rows = result.checks.map(
    (check) =>
      `| ${check.name} | ${check.ok ? 'pass' : 'FAIL'} | ${check.message.replace(/\|/g, '/')} |`
  );
  return [
    `### Live GitHub contract: ${LABEL[result.outcome]}`,
    '',
    '| check | result | detail |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/** The workflow annotation for the outcome; plain text outside GitHub Actions. */
function annotation(result: ContractResult, actions: boolean): string | null {
  if (result.outcome === 'pass') return null;
  const level = result.outcome === 'skipped' ? 'notice' : 'error';
  const title =
    result.outcome === 'skipped'
      ? 'Live GitHub contract skipped'
      : 'Live GitHub contract failed';
  const text = result.message.replace(/[\r\n%]/g, ' ');
  return actions ? `::${level} title=${title}::${text}` : `${title}: ${text}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  const fileAt = argv.indexOf('--result-file');
  const resultFile = fileAt >= 0 ? argv[fileAt + 1] : undefined;
  const result = await runContract({
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  });
  const human = humanSummary(result);
  if (json) console.error(human);
  else console.log(human);
  const note = annotation(result, process.env['GITHUB_ACTIONS'] === 'true');
  if (note !== null) console.log(note);
  if (json) console.log(JSON.stringify(result));
  if (resultFile !== undefined)
    writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary !== undefined && stepSummary !== '')
    appendFileSync(stepSummary, markdown(result));
  return result.exitCode;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
