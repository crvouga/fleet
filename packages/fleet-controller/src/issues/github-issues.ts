import { fingerprintIn } from './fingerprint';
import type { FilingEnv } from './env';
import type { IssueTuning, IssueFetch } from './runtime';

/** Why a GitHub call did not work, and whether trying again later can help. */
export interface Failure {
  readonly ok: false;
  /** Network errors, timeouts, 5xx, 429 and rate limits are temporary; the rest are not. */
  readonly temporary: boolean;
  /** How long GitHub asked us to wait, when it said. */
  readonly retryAfterMs: number | null;
  readonly status: number | null;
  /** One actionable sentence. Never contains the token. */
  readonly message: string;
}

export type Outcome<T> = ({ readonly ok: true } & T) | Failure;

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
}

const MAX_MESSAGE = 200;
const MAX_PAGES = 3;
const PAGE_SIZE = 100;
const LOOKBACK_MS = 3_600_000;
/** Clock skew allowed between this controller and GitHub when judging "created after the report". */
const SKEW_MS = 300_000;
const SECOND = 1000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function githubMessage(json: unknown): string {
  const message = record(json)['message'];
  return typeof message === 'string'
    ? message.replace(/\s+/g, ' ').slice(0, MAX_MESSAGE)
    : '';
}

/** The wait GitHub asked for: Retry-After seconds, or the rate-limit reset time. */
export function retryAfterMs(headers: Headers, now: number): number | null {
  const after = Number(headers.get('retry-after'));
  if (
    headers.get('retry-after') !== null &&
    Number.isFinite(after) &&
    after >= 0
  )
    return after * SECOND;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (
    headers.get('x-ratelimit-remaining') === '0' &&
    Number.isFinite(reset) &&
    reset > 0
  )
    return Math.max(0, reset * SECOND - now);
  return null;
}

function isRateLimited(
  status: number,
  headers: Headers,
  message: string
): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    headers.get('retry-after') !== null ||
    headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit|abuse|secondary/i.test(message)
  );
}

function permanentMessage(
  status: number,
  repository: string,
  detail: string
): string {
  const more = detail === '' ? '' : ` GitHub said: ${detail}`;
  if (status === 401)
    return `GitHub rejected the token (401). Check FLEET_ISSUES_GITHUB_TOKEN: it must be valid and not expired.${more}`;
  if (status === 403)
    return `GitHub refused the request (403). The token needs "Issues: write" on ${repository}.${more}`;
  if (status === 404)
    return `GitHub cannot find ${repository}, or the token cannot see it (404). Check FLEET_ISSUES_REPOSITORY and the token's repository access.${more}`;
  if (status === 410)
    return `Issues are disabled or the repository moved (410). Enable issues on ${repository}.${more}`;
  if (status === 422)
    return `GitHub rejected the issue as invalid (422). Check FLEET_ISSUES_LABELS and that issues are enabled.${more}`;
  return `GitHub answered ${status}.${more}`;
}

/** Pure: an HTTP error reply to a Failure. */
export function classifyHttp(
  reply: Reply,
  repository: string,
  now: number
): Failure {
  const detail = githubMessage(reply.json);
  const wait = retryAfterMs(reply.headers, now);
  if (isRateLimited(reply.status, reply.headers, detail))
    return {
      ok: false,
      temporary: true,
      retryAfterMs: wait,
      status: reply.status,
      message: `GitHub is rate limiting issue creation (${reply.status}); it will be retried.`,
    };
  if (reply.status >= 500 || reply.status === 408)
    return {
      ok: false,
      temporary: true,
      retryAfterMs: wait,
      status: reply.status,
      message: `GitHub is having trouble (HTTP ${reply.status}); it will be retried.`,
    };
  return {
    ok: false,
    temporary: false,
    retryAfterMs: null,
    status: reply.status,
    message: permanentMessage(reply.status, repository, detail),
  };
}

function networkFailure(error: unknown): Failure {
  const timedOut =
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError');
  return {
    ok: false,
    temporary: true,
    retryAfterMs: null,
    status: null,
    message: timedOut
      ? 'GitHub did not answer in time; it will be retried.'
      : 'GitHub could not be reached (network error); it will be retried.',
  };
}

export interface Client {
  readonly config: FilingEnv;
  readonly fetch: IssueFetch;
  readonly tuning: IssueTuning;
  readonly now: () => Date;
}

async function request(
  client: Client,
  method: string,
  path: string,
  body?: unknown
): Promise<Outcome<{ reply: Reply }>> {
  try {
    const response = await client.fetch(`${client.config.apiUrl}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(client.tuning.timeoutMs),
      headers: {
        Authorization: `Bearer ${client.config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fleet-controller',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const reply = { status: response.status, headers: response.headers, json };
    if (response.ok) return { ok: true, reply };
    return classifyHttp(
      reply,
      client.config.repository,
      client.now().getTime()
    );
  } catch (error) {
    return networkFailure(error);
  }
}

const repoPath = (client: Client): string =>
  `/repos/${client.config.repository}`;

export interface Created {
  readonly number: number;
  readonly url: string;
}

function created(json: unknown): Created | null {
  const data = record(json);
  const number = data['number'];
  const url = data['html_url'];
  return typeof number === 'number' && typeof url === 'string'
    ? { number, url }
    : null;
}

function createdAfter(issue: Record<string, unknown>, since: Date): boolean {
  const created = Date.parse(String(issue['created_at']));
  return Number.isNaN(created) || created >= since.getTime() - SKEW_MS;
}

function carries(
  issue: Record<string, unknown>,
  fingerprint: string,
  since: Date
): boolean {
  const body = issue['body'];
  return (
    issue['pull_request'] === undefined &&
    typeof body === 'string' &&
    fingerprintIn(body) === fingerprint &&
    createdAfter(issue, since)
  );
}

/**
 * Looks for an OPEN issue, created since the report was, that already carries
 * this fingerprint, so a retry after a crash cannot create a second one. An
 * older or closed issue is a previous occurrence, not this report's.
 */
export async function findByFingerprint(
  client: Client,
  fingerprint: string,
  since: Date
): Promise<Outcome<{ found: Created | null }>> {
  const from = new Date(since.getTime() - LOOKBACK_MS).toISOString();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await request(
      client,
      'GET',
      `${repoPath(client)}/issues?state=open&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}&since=${encodeURIComponent(from)}`
    );
    if (!result.ok) return result;
    const items = Array.isArray(result.reply.json)
      ? (result.reply.json as unknown[])
      : [];
    const found = items
      .map(record)
      .find((issue) => carries(issue, fingerprint, since));
    if (found !== undefined) {
      const made = created(found);
      if (made !== null) return { ok: true, found: made };
    }
    if (items.length < PAGE_SIZE) break;
  }
  return { ok: true, found: null };
}

export async function createIssue(
  client: Client,
  issue: { title: string; body: string }
): Promise<Outcome<{ created: Created }>> {
  const result = await request(client, 'POST', `${repoPath(client)}/issues`, {
    title: issue.title,
    body: issue.body,
    labels: client.config.labels,
  });
  if (!result.ok) return result;
  const made = created(result.reply.json);
  if (made === null)
    return {
      ok: false,
      temporary: true,
      retryAfterMs: null,
      status: result.reply.status,
      message: 'GitHub answered without an issue number; it will be retried.',
    };
  return { ok: true, created: made };
}

export async function commentOn(
  client: Client,
  number: number,
  text: string
): Promise<Outcome<{ done: true }>> {
  const result = await request(
    client,
    'POST',
    `${repoPath(client)}/issues/${number}/comments`,
    { body: text }
  );
  return result.ok ? { ok: true, done: true } : result;
}

/** `open`, `closed`, or null when GitHub no longer has the issue. */
export async function issueState(
  client: Client,
  number: number
): Promise<Outcome<{ state: 'open' | 'closed' | null }>> {
  const result = await request(
    client,
    'GET',
    `${repoPath(client)}/issues/${number}`
  );
  if (!result.ok)
    return result.status === 404 || result.status === 410
      ? { ok: true, state: null }
      : result;
  const state = record(result.reply.json)['state'];
  return { ok: true, state: state === 'closed' ? 'closed' : 'open' };
}
