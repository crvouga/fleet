import type { Logger } from '@pkgs/logger';

const WEBHOOK_TIMEOUT_MS = 5000;

export interface WebhookDeps {
  readonly fetch: typeof fetch;
  readonly log: Logger;
  readonly timeoutMs?: number;
}

/** True for an https URL. Anything else is never contacted. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * POSTs a JSON notice. Best effort: no redirects are followed, the request is
 * bounded by a timeout, and every failure is logged and swallowed. Resolves
 * true only when the endpoint answered 2xx.
 */
export async function postWebhook(
  deps: WebhookDeps,
  url: string,
  payload: Readonly<Record<string, unknown>>
): Promise<boolean> {
  if (!isHttpsUrl(url)) {
    deps.log.warn('webhook skipped: url is not https');
    return false;
  }
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'fleet-api',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) deps.log.warn('webhook refused', { status: res.status });
    return res.ok;
  } catch (err: unknown) {
    deps.log.warn('webhook failed', {
      error: err instanceof Error ? err.name : 'error',
    });
    return false;
  }
}
