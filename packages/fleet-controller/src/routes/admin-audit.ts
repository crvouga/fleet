import type { Hono } from 'hono';

import type { AppDeps } from '../deps';

import { adminRoute, requireAdmin } from './guards';
import { invalidBody } from './http';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TEXT = /^[A-Za-z0-9@._:/+-]{1,200}$/;

function queryErrors(query: Readonly<Record<string, string>>): string[] {
  const errors: string[] = [];
  for (const key of ['kind', 'target', 'actor'])
    if (query[key] !== undefined && !TEXT.test(query[key]))
      errors.push(`${key} must be short plain text`);
  const before = query['before'];
  if (before !== undefined && !/^[1-9]\d{0,15}$/.test(before))
    errors.push('before must be an audit entry id');
  const limit = query['limit'];
  if (limit !== undefined && !/^[1-9]\d{0,3}$/.test(limit))
    errors.push('limit must be a whole number');
  return errors;
}

function auditQuery(query: Readonly<Record<string, string>>) {
  const limit = Math.min(Number(query['limit'] ?? DEFAULT_LIMIT), MAX_LIMIT);
  return {
    limit,
    filter: {
      limit: limit + 1,
      ...(query['kind'] === undefined ? {} : { targetKind: query['kind'] }),
      ...(query['target'] === undefined ? {} : { targetId: query['target'] }),
      ...(query['actor'] === undefined ? {} : { actor: query['actor'] }),
      ...(query['before'] === undefined
        ? {}
        : { beforeId: Number(query['before']) }),
    },
  };
}

/**
 * `GET /v1/audit?kind=&target=&actor=&before=&limit=`: the append-only audit
 * trail, newest first. Administrators only: it names who did what to which node.
 */
export function mountAdminAudit(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/audit',
    adminRoute(deps, async (c, actor) => {
      const denied = await requireAdmin(deps, c, actor, 'audit.read');
      if (denied !== null) return denied;
      const errors = queryErrors(c.req.query());
      if (errors.length > 0) return invalidBody(c, 'invalid_request', errors);
      const { limit, filter } = auditQuery(c.req.query());
      const rows = await deps.store.listAudit(filter);
      const entries = rows.slice(0, limit);
      return c.json({
        entries,
        nextBefore: rows.length > limit ? (entries.at(-1)?.id ?? null) : null,
      });
    })
  );
}
