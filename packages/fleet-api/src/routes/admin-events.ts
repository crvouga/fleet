import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import { summarize } from '../domain/summary';
import type { AppDeps } from '../deps';
import type { EventQuery } from '../store';

import { adminRoute } from './guards';
import { apiError } from './http';
import { loadViews } from './node-views';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Parsed =
  | { readonly ok: true; readonly query: EventQuery }
  | { readonly ok: false; readonly message: string };

function wholeNumber(
  raw: string | undefined,
  min: number,
  max: number
): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  return value >= min && value <= max ? value : null;
}

interface RawQuery {
  readonly node: string | undefined;
  readonly severity: string | undefined;
  readonly before: number | null | undefined;
  readonly limit: number | null | undefined;
}

function problemWith(raw: RawQuery): string | null {
  const { node, severity } = raw;
  if (node && !NODE_ID_PATTERN.test(node)) {
    return 'node must be a 64 character node id';
  }
  if (severity && severity !== 'warn' && severity !== 'error') {
    return 'severity must be warn or error';
  }
  if (raw.before === null) return 'before must be a positive whole number';
  if (raw.limit === null) return `limit must be between 1 and ${MAX_LIMIT}`;
  return null;
}

function queryOf(raw: RawQuery): EventQuery {
  const { node, severity, before } = raw;
  return {
    limit: raw.limit ?? DEFAULT_LIMIT,
    ...(node ? { nodeId: node } : {}),
    ...(severity === 'warn' || severity === 'error' ? { severity } : {}),
    ...(typeof before === 'number' ? { beforeId: before } : {}),
  };
}

/** `node`, `severity` (warn means warn and error), `before` (an event id) and `limit`. */
export function parseEventQuery(c: Context): Parsed {
  const raw: RawQuery = {
    node: c.req.query('node'),
    severity: c.req.query('severity'),
    before: wholeNumber(c.req.query('before'), 1, Number.MAX_SAFE_INTEGER),
    limit: wholeNumber(c.req.query('limit'), 1, MAX_LIMIT),
  };
  const message = problemWith(raw);
  return message === null
    ? { ok: true, query: queryOf(raw) }
    : { ok: false, message };
}

export function mountAdminEvents(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/events',
    adminRoute(deps, async (c) => {
      const parsed = parseEventQuery(c);
      if (!parsed.ok)
        return apiError(c, 400, 'invalid_request', parsed.message);
      const events = await deps.store.listEvents(parsed.query);
      const last = events[events.length - 1];
      const more = events.length === parsed.query.limit && last !== undefined;
      return c.json({ events, nextBefore: more ? last.id : null });
    })
  );
  app.get(
    '/v1/summary',
    adminRoute(deps, async (c) => c.json(summarize(await loadViews(deps))))
  );
}
