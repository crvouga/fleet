import type { Context, Hono } from 'hono';

import {
  isScope,
  validateConfig,
  type FleetConfig,
  type Scope,
} from '../config/schema';
import { effectiveConfig } from '../domain/effective-config';
import type { AppDeps } from '../deps';
import type { SettingsRow } from '../types';

import { adminRoute } from './guards';
import { apiError, invalidBody, readJson } from './http';

const DEFAULT_HISTORY = 50;
const MAX_HISTORY = 200;

function scopeOf(c: Context): Scope | null {
  const raw = c.req.param('scope') ?? '';
  return isScope(raw) ? raw : null;
}

function badScope(c: Context): Response {
  return apiError(
    c,
    400,
    'invalid_scope',
    'The scope must be fleet, role:<role> or node:<64 hex id>.'
  );
}

/** The stored document, or an empty one for a scope nobody has written yet. */
function documentOf(scope: Scope, row: SettingsRow | null) {
  return {
    scope,
    value: row?.value ?? {},
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

async function showScope(
  deps: AppDeps,
  c: Context,
  scope: Scope
): Promise<Response> {
  const row = await deps.store.getSettings(scope);
  if (!scope.startsWith('node:')) return c.json(documentOf(scope, row));
  const node = await deps.store.findNode(scope.slice('node:'.length));
  if (node === null) return apiError(c, 404, 'not_found', 'No such node.');
  const settings = await deps.store.listSettings();
  return c.json({
    ...documentOf(scope, row),
    effective: effectiveConfig(settings, node),
  });
}

async function replaceScope(
  deps: AppDeps,
  c: Context,
  scope: Scope,
  actor: string
): Promise<Response> {
  const body = await readJson(c);
  if (!body.ok) return body.response;
  const checked = validateConfig(body.value);
  if (!checked.ok) return invalidBody(c, 'invalid_settings', checked.errors);
  if (
    scope.startsWith('node:') &&
    (await deps.store.findNode(scope.slice('node:'.length))) === null
  ) {
    return apiError(c, 404, 'not_found', 'No such node.');
  }
  const row = await deps.store.putSettings(
    scope,
    checked.value as FleetConfig,
    actor
  );
  return c.json(documentOf(scope, row));
}

function historyLimit(c: Context): number | null {
  const raw = c.req.query('limit');
  if (raw === undefined || raw === '') return DEFAULT_HISTORY;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_HISTORY
    ? value
    : null;
}

export function mountAdminSettings(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/settings',
    adminRoute(deps, async (c) =>
      c.json({ settings: await deps.store.listSettings() })
    )
  );
  app.get(
    '/v1/settings/:scope/history',
    adminRoute(deps, async (c) => {
      const scope = scopeOf(c);
      const limit = historyLimit(c);
      if (scope === null) return badScope(c);
      if (limit === null)
        return apiError(
          c,
          400,
          'invalid_request',
          `limit must be between 1 and ${MAX_HISTORY}`
        );
      return c.json({
        history: await deps.store.settingsHistory(scope, limit),
      });
    })
  );
  app.get(
    '/v1/settings/:scope',
    adminRoute(deps, async (c) => {
      const scope = scopeOf(c);
      return scope === null ? badScope(c) : showScope(deps, c, scope);
    })
  );
  app.put(
    '/v1/settings/:scope',
    adminRoute(deps, async (c, actor) => {
      const scope = scopeOf(c);
      return scope === null ? badScope(c) : replaceScope(deps, c, scope, actor);
    })
  );
}
