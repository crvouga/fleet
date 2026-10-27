import type { Logger } from './logger';
import { errorDetails } from './error';
import { withLogContext } from './context';

/** Correlate requests without recording URLs, query strings, headers or bodies. */
export async function observeHttp(
  log: Logger,
  request: Request,
  work: () => Promise<Response>,
  route: () => string = () => 'unknown'
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  // Unknown/dynamic segments can contain tokens or personal data. Callers can
  // supply route templates in operation names; never log the raw URL here.
  return withLogContext(
    {
      requestId,
      traceId: requestId.replaceAll('-', ''),
      method: request.method,
    },
    async () => {
      const response = await work().catch((error: unknown) => {
        log.error('http_request_failed', {
          route: route(),
          error: errorDetails(error),
        });
        throw error;
      });
      const status = response.status;
      const level = responseLevel(status, route());
      log[level]('http_request', {
        requestId,
        method: request.method,
        route: route(),
        status,
        durationMs: Math.round(performance.now() - started),
      });
      const headers = new Headers(response.headers);
      headers.set('X-Request-ID', requestId);
      return new Response(response.body, {
        status,
        statusText: response.statusText,
        headers,
      });
    }
  );
}

function responseLevel(status: number, route: string) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return route.startsWith('/health') ? 'debug' : 'info';
}
