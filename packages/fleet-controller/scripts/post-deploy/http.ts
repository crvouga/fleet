/**
 * HTTP for the post-deploy check: bounded retries for a service that is still
 * starting, no redirects (a redirect must never carry the admin token to
 * another origin) and every message passed through `redact`.
 */

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed body, or `undefined` when it is not JSON. */
  readonly json: unknown;
}

export type Fetched =
  | { readonly ok: true; readonly reply: Reply; readonly attempts: number }
  | { readonly ok: false; readonly reason: string; readonly attempts: number };

export interface HttpOptions {
  readonly base: string;
  readonly timeoutMs: number;
  /** Extra attempts after the first for a network error or a 502/503/504. */
  readonly retries: number;
  readonly backoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly redact: (text: string) => string;
  readonly fetch?: typeof fetch;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_BODY_CHARS = 1_000_000;
const TRANSIENT = new Set([502, 503, 504]);

export interface Http {
  get(path: string, token?: string): Promise<Fetched>;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function once(
  options: HttpOptions,
  path: string,
  token: string | undefined
): Promise<Reply> {
  const response = await (options.fetch ?? fetch)(options.base + path, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'fleet-post-deploy-check',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
  });
  const text = (await response.text()).slice(0, MAX_BODY_CHARS);
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: parse(text),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError')
    return 'timed out';
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return error instanceof Error ? error.message : 'request failed';
}

export function createHttp(options: HttpOptions): Http {
  return {
    async get(path, token) {
      let reason = 'no attempt was made';
      for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
        try {
          const reply = await once(options, path, token);
          if (!TRANSIENT.has(reply.status) || attempt > options.retries)
            return { ok: true, reply, attempts: attempt };
          reason = `HTTP ${reply.status}`;
        } catch (error) {
          reason = options.redact(describe(error));
        }
        if (attempt <= options.retries) {
          await options.sleep(
            Math.min(MAX_BACKOFF_MS, options.backoffMs * 2 ** (attempt - 1))
          );
        }
      }
      return { ok: false, reason, attempts: options.retries + 1 };
    },
  };
}
