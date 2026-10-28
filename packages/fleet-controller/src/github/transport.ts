import { GithubError, refusal } from './errors';
import type { Circuit } from './circuit';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface RetryPolicy {
  /** Attempts per call, including the first. */
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
  /** A wait longer than this is not slept: the error goes to the caller to back off. */
  readonly maxInlineWaitMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseMs: 500,
  maxMs: 10_000,
  maxInlineWaitMs: 15_000,
  timeoutMs: 30_000,
};

export interface Transport {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** In [0, 1): jitter. Injected so tests are deterministic. */
  readonly random: () => number;
  readonly retry: RetryPolicy;
  readonly circuit: Circuit;
}

export interface GithubRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly bearer: string;
  readonly body?: unknown;
  /** Which refusal wording a 401/404 gets. */
  readonly kind: 'installation' | 'target';
}

const RATE_LIMIT_TEXT = /rate limit/i;

function waitFromHeaders(headers: Headers, now: Date): number | null {
  const after = Number(headers.get('retry-after'));
  if (headers.has('retry-after') && Number.isFinite(after) && after >= 0) {
    return Math.max(1000, after * 1000);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
    return Math.max(1000, reset * 1000 - now.getTime());
  }
  return null;
}

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

function rateLimited(waitMs: number | null, status: number): GithubError {
  const seconds = waitMs === null ? null : Math.ceil(waitMs / 1000);
  const suffix = seconds === null ? '' : `; retry after ${seconds} s`;
  return new GithubError(
    'FLEET_GITHUB_RATE_LIMITED',
    `GitHub rate limit reached${suffix}`,
    { temporary: true, status, retryAfterMs: waitMs }
  );
}

/** What a non-2xx answer means. Never quotes the body. */
export async function classify(
  response: Response,
  req: GithubRequest,
  now: Date
): Promise<GithubError> {
  const { status } = response;
  const wait = waitFromHeaders(response.headers, now);
  if (status === 429) return rateLimited(wait, status);
  if (status === 403) {
    const secondary = RATE_LIMIT_TEXT.test(await messageOf(response));
    if (wait !== null || secondary) return rateLimited(wait, status);
  }
  if (status === 408 || status >= 500) {
    return new GithubError(
      'FLEET_GITHUB_UNAVAILABLE',
      'GitHub is temporarily unavailable',
      { temporary: true, status, retryAfterMs: wait }
    );
  }
  return refusal(status, req.kind);
}

async function attempt(t: Transport, req: GithubRequest): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t.retry.timeoutMs);
  let response: Response;
  try {
    response = await t.fetch(`${t.apiUrl}${req.path}`, {
      method: req.method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${req.bearer}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fleet-controller',
        ...(req.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
  } catch {
    throw new GithubError(
      'FLEET_GITHUB_UNAVAILABLE',
      'GitHub could not be reached',
      {
        temporary: true,
      }
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw await classify(response, req, t.now());
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new GithubError(
      'FLEET_GITHUB_UNAVAILABLE',
      'GitHub sent an unreadable answer',
      {
        temporary: true,
        status: response.status,
      }
    );
  }
}

function delayFor(t: Transport, error: GithubError, tries: number): number {
  const exponential = Math.min(
    t.retry.maxMs,
    t.retry.baseMs * 2 ** (tries - 1)
  );
  const jittered = Math.round(exponential * (0.5 + t.random() / 2));
  return Math.max(jittered, error.retryAfterMs ?? 0);
}

/**
 * One GitHub call. A temporary failure is retried with bounded exponential
 * backoff and jitter (or GitHub's own Retry-After / reset time); a wait longer
 * than `maxInlineWaitMs` is returned to the caller instead of slept, so a rate
 * limit makes a sync back off rather than hold a request open.
 */
export async function send(t: Transport, req: GithubRequest): Promise<unknown> {
  for (let tries = 1; ; tries += 1) {
    t.circuit.check();
    try {
      const result = await attempt(t, req);
      t.circuit.success();
      return result;
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      if (!error.temporary) {
        // GitHub answered: the service is reachable, the request is what failed.
        t.circuit.success();
        throw error;
      }
      t.circuit.failure(error.retryAfterMs);
      const wait = delayFor(t, error, tries);
      const last = tries >= t.retry.maxAttempts;
      if (last || wait > t.retry.maxInlineWaitMs) throw error;
      await t.sleep(wait);
    }
  }
}
