import { ContractError, github } from './openapi';
import { UPSTREAM } from './selection';

/** Same shape as the controller's `FetchLike` and the issues client's `IssueFetch`. */
export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly requestHeaders: Headers;
  readonly requestBody: unknown;
  readonly status: number;
  readonly responseHeaders: Headers;
  readonly responseBody: unknown;
}

function parsed(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Wraps a fetch so every request the client sends and every answer it gets is
 * kept for the contract assertions. The answer handed back is untouched.
 */
export function recordingFetch(inner: Fetch = fetch): {
  fetch: Fetch;
  exchanges: Exchange[];
} {
  const exchanges: Exchange[] = [];
  const wrapped: Fetch = async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url
    );
    const body = init?.body;
    exchanges.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      requestHeaders: new Headers(init?.headers),
      requestBody: typeof body === 'string' ? parsed(body) : null,
      status: response.status,
      responseHeaders: response.headers,
      responseBody: parsed(await response.clone().text()),
    });
    return response;
  };
  return { fetch: wrapped, exchanges };
}

const API_VERSION = /(\d{4}-\d{2}-\d{2})\.json$/.exec(UPSTREAM.file)?.[1];

function requestHeaderProblems(ex: Exchange): string[] {
  const h = ex.requestHeaders;
  const problems: string[] = [];
  if (!/^Bearer \S+$/.test(h.get('authorization') ?? ''))
    problems.push('Authorization must be "Bearer <token>"');
  if (h.get('accept') !== 'application/vnd.github+json')
    problems.push('Accept must be application/vnd.github+json');
  if (h.get('x-github-api-version') !== API_VERSION)
    problems.push(
      `X-GitHub-Api-Version must be ${API_VERSION}, the version of the vendored description`
    );
  if ((h.get('user-agent') ?? '') === '')
    problems.push('GitHub rejects requests without a User-Agent');
  if (ex.requestBody !== null && h.get('content-type') !== 'application/json')
    problems.push('a JSON body needs Content-Type: application/json');
  return problems;
}

function attempt(run: () => string[]): string[] {
  try {
    return run();
  } catch (error) {
    if (error instanceof ContractError) return [error.message];
    throw error;
  }
}

/** Every way one exchange departs from GitHub's published contract. Empty when it conforms. */
export function exchangeProblems(ex: Exchange): string[] {
  const { method, path, status } = ex;
  const label = `${method} ${path}${ex.query.size === 0 ? '' : `?${ex.query.toString()}`}`;
  const problems = [
    ...requestHeaderProblems(ex),
    ...attempt(() =>
      github.requestProblems(method, path, ex.query, ex.requestBody)
    ),
    ...attempt(() =>
      github.responseProblems(method, path, status, ex.responseBody)
    ),
    ...github.headerProblems(ex.responseHeaders),
  ];
  const json = ex.responseHeaders.get('content-type') ?? '';
  if (ex.responseBody !== null && !json.includes('application/json'))
    problems.push(`answer ${status} has a body but content-type "${json}"`);
  return problems.map((problem) => `${label} -> ${status}: ${problem}`);
}

/** `METHOD template status`, for the operations an exchange exercised. */
export function coverageKey(ex: Exchange): string {
  const op = github.find(ex.method, ex.path);
  return `${ex.method.toUpperCase()} ${op?.template ?? ex.path} ${ex.status}`;
}

export function allProblems(exchanges: readonly Exchange[]): string[] {
  return exchanges.flatMap(exchangeProblems);
}
