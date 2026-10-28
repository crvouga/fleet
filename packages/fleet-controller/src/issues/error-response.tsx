import { logContext } from '@pkgs/logger';
import type { Context } from 'hono';

import type { AppDeps } from '../deps';
import { controllerError } from '../routes/http';

import { describeError } from './errors';
import { reportUrl } from './links';

function requestIdOf(): string | null {
  const id = logContext()['requestId'];
  return typeof id === 'string' ? id : null;
}

function wantsPage(c: Context): boolean {
  if (c.req.path.startsWith('/v1/')) return false;
  return c.req.header('accept')?.includes('text/html') === true;
}

function errorPage(message: string, requestId: string | null) {
  const link =
    requestId === null ? null : reportUrl({ kind: 'controller', requestId });
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="robots" content="noindex" />
        <title>Something went wrong · Fleet controller</title>
      </head>
      <body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
        <h1>Something went wrong</h1>
        <p>{message}</p>
        {requestId === null ? null : (
          <p>
            Request ID: <code>{requestId}</code>
          </p>
        )}
        {link === null ? null : (
          <p>
            <a href={link}>Report this problem</a> (sign in as an administrator
            to file it).
          </p>
        )}
        <p>
          <a href="/">Back to the overview</a>
        </p>
      </body>
    </html>
  );
}

/**
 * The answer to an unhandled error. The body keeps its JSON shape for API
 * callers; the request id travels in `X-Request-ID` (set for every response)
 * and `X-Fleet-Report` names the page that turns it into an issue. A browser
 * navigation gets a small page with the id and a Report link. The error is
 * remembered (bounded, in memory) so the report can include it.
 */
export function internalError(
  c: Context,
  deps: AppDeps,
  error: unknown,
  message: string
): Response | Promise<Response> {
  const requestId = requestIdOf();
  if (requestId !== null) {
    deps.issues?.errors.record(
      describeError(error, {
        requestId,
        at: deps.now(),
        method: c.req.method,
        route: c.req.routePath,
        status: 500,
      })
    );
    c.header('X-Fleet-Report', reportUrl({ kind: 'controller', requestId }));
  }
  if (wantsPage(c)) return c.html(errorPage(message, requestId), 500);
  return controllerError(c, 500, 'internal', message);
}
