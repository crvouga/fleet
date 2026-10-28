import type { Context, Hono } from 'hono';

import type { AppDeps } from '../deps';
import { isRecord } from '../domain/heartbeat-fields';
import { validOrigin, BINDING_FILE } from '../enrollment/binding';
import {
  DEFAULT_TTL_SECONDS,
  MAX_LABEL,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  validTtl,
  viewOfGrant,
} from '../enrollment/grants';
import { issueGrant, revokeGrant } from '../enrollment/service';
import { isActiveRole, type ActiveRole } from '../types';

import { adminRoute, roleOf } from './guards';
import { controllerError, invalidBody, readJson } from './http';

const LABEL = /^[\x20-\x7e]*$/;

interface IssueBody {
  readonly role: ActiveRole | null;
  readonly label: string | null;
  readonly ttlSeconds: number;
}

function parseLabel(raw: unknown): { label: string | null; error?: string } {
  if (raw === undefined || raw === null) return { label: null };
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (
    typeof raw !== 'string' ||
    trimmed.length > MAX_LABEL ||
    !LABEL.test(trimmed)
  )
    return {
      label: null,
      error: `label must be plain text of at most ${MAX_LABEL} characters`,
    };
  return { label: trimmed.length > 0 ? trimmed : null };
}

function ttlOf(raw: unknown): number | null {
  return raw === undefined ? DEFAULT_TTL_SECONDS : validTtl(raw);
}

function parseIssue(
  input: unknown
): { ok: true; value: IssueBody } | { ok: false; errors: string[] } {
  if (!isRecord(input))
    return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  const role = input['role'] ?? null;
  if (role !== null && !isActiveRole(role))
    errors.push('role must be an active role or null');
  const { label, error } = parseLabel(input['label']);
  if (error !== undefined) errors.push(error);
  const ttl = ttlOf(input['ttlSeconds']);
  if (ttl === null)
    errors.push(
      `ttlSeconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`
    );
  if (errors.length > 0 || ttl === null) return { ok: false, errors };
  return {
    ok: true,
    value: { role: isActiveRole(role) ? role : null, label, ttlSeconds: ttl },
  };
}

function firstOf(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim();
}

/**
 * The controller's own origin as the browser sees it: the request's Origin
 * (already proven same-site by adminRoute for sessions), else the forwarded
 * scheme and host. Never taken from the request body.
 */
export function controllerOrigin(c: Context): string | null {
  const claimed = c.req.header('origin');
  if (claimed !== undefined && validOrigin(claimed)) return claimed;
  const proto =
    firstOf(c.req.header('x-forwarded-proto')) ??
    new URL(c.req.url).protocol.slice(0, -1);
  const host =
    firstOf(c.req.header('x-forwarded-host')) ?? c.req.header('host') ?? '';
  const candidate = `${proto}://${host}`;
  return validOrigin(candidate) ? candidate : null;
}

export function mountEnrollmentGrants(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/enrollment/grants',
    adminRoute(deps, async (c) => {
      const now = deps.now();
      const limit = Math.min(100, Number(c.req.query('limit')) || 50);
      const rows = await deps.store.grants.list(limit);
      return c.json({ grants: rows.map((row) => viewOfGrant(row, now)) });
    })
  );
  app.post(
    '/v1/enrollment/grants',
    adminRoute(deps, async (c, actor) => {
      const body = await readJson(c);
      if (!body.ok) return body.response;
      const parsed = parseIssue(body.value);
      if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
      const origin = controllerOrigin(c);
      if (origin === null)
        return controllerError(
          c,
          400,
          'origin_unknown',
          'The controller cannot tell its own HTTPS origin from this request. Open the dashboard at its public address and try again.'
        );
      const issued = await issueGrant(
        deps,
        { name: actor, role: await roleOf(deps, c) },
        { ...parsed.value, origin }
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ ...issued, file: BINDING_FILE }, 201);
    })
  );
  app.post(
    '/v1/enrollment/grants/:id/revoke',
    adminRoute(deps, async (c, actor) => {
      const grant = await revokeGrant(
        deps,
        { name: actor, role: await roleOf(deps, c) },
        c.req.param('id') ?? ''
      );
      return grant === null
        ? controllerError(c, 404, 'not_found', 'No such installer grant.')
        : c.json({ grant });
    })
  );
}
