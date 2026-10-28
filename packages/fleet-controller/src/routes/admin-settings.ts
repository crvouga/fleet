import type { Context, Hono } from 'hono';

import {
  isScope,
  validateConfig,
  type FleetConfig,
  type Scope,
} from '../config/schema';
import { effectiveConfig } from '../domain/effective-config';
import { isRecord } from '../domain/heartbeat-fields';
import type { SettingsImpact } from '../domain/settings-impact';
import type { AppDeps } from '../deps';
import { maskUrl } from '../ui/lib/format';
import type { SettingsRow } from '../types';

import { mayWrite } from '../auth/roles';

import { mountAccessSafety } from './access-safety';
import { adminRoute, roleOf } from './guards';
import { controllerError, invalidBody, readJson } from './http';
import {
  changeSettings,
  type ChangeOutcome,
  type ChangeRequest,
} from './settings-change';
import {
  dryRunRequested,
  readPreconditions,
  readWriteRequest,
} from './settings-request';

const DEFAULT_HISTORY = 50;
const MAX_HISTORY = 200;

function scopeOf(c: Context): Scope | null {
  const raw = c.req.param('scope') ?? '';
  return isScope(raw) ? raw : null;
}

function badScope(c: Context): Response {
  return controllerError(
    c,
    400,
    'invalid_scope',
    'The scope must be fleet, role:<role> or node:<64 hex id>.'
  );
}

/** A viewer reads everything but secrets: the alert webhook URL may carry a token. */
function readable<T extends object>(value: T, viewer: boolean): T {
  const alerts = (value as { alerts?: { webhookUrl?: unknown } }).alerts;
  if (!viewer || typeof alerts?.webhookUrl !== 'string') return value;
  return {
    ...value,
    alerts: { ...alerts, webhookUrl: maskUrl(alerts.webhookUrl) },
  };
}

/** The stored document, or an empty one for a scope nobody has written yet. */
function documentOf(scope: Scope, row: SettingsRow | null, viewer = false) {
  return {
    scope,
    value: readable(row?.value ?? {}, viewer),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    revision: row?.revision ?? 0,
  };
}

async function showScope(
  deps: AppDeps,
  c: Context,
  scope: Scope
): Promise<Response> {
  const viewer = !mayWrite(await roleOf(deps, c));
  const row = await deps.store.getSettings(scope);
  c.header('ETag', `"${row?.revision ?? 0}"`);
  if (!scope.startsWith('node:')) return c.json(documentOf(scope, row, viewer));
  const node = await deps.store.findNode(scope.slice('node:'.length));
  if (node === null)
    return controllerError(c, 404, 'not_found', 'No such node.');
  const settings = await deps.store.listSettings();
  return c.json({
    ...documentOf(scope, row, viewer),
    effective: readable(effectiveConfig(settings, node), viewer),
  });
}

function impactJson(impact: SettingsImpact) {
  return {
    totalNodes: impact.totalNodes,
    changedNodes: impact.changes.map((change) => ({
      nodeId: change.nodeId,
      label: change.label,
      fromRevision: change.before.revision,
      toRevision: change.after.revision,
      fromClosure: change.before.closure,
      toClosure: change.after.closure,
    })),
    issues: impact.issues,
  };
}

/** Maps a ChangeOutcome to the HTTP contract (see docs/access-and-config-safety.md). */
function respond(c: Context, scope: Scope, outcome: ChangeOutcome): Response {
  switch (outcome.kind) {
    case 'dry_run': {
      const wouldWrite =
        !outcome.conflict &&
        !outcome.preconditionMissing &&
        outcome.blockedBy.length === 0;
      return c.json({
        dryRun: true,
        scope,
        revision: outcome.revision,
        wouldWrite,
        conflict: outcome.conflict,
        preconditionMissing: outcome.preconditionMissing,
        acknowledgementRequired: outcome.blockedBy.map((i) => i.code),
        ...impactJson(outcome.impact),
      });
    }
    case 'precondition_required':
      return c.json(
        {
          error: 'precondition_required',
          message: `Send If-Match: ${outcome.current} (the current revision of ${scope}) so a concurrent change is not overwritten. GET the scope to read it.`,
          currentRevision: outcome.current,
        },
        428
      );
    case 'conflict':
      return c.json(
        {
          error: 'conflict',
          message: `${scope} changed since you loaded it: it is at revision ${outcome.current}, you based your change on ${outcome.expected}. Reload, review and apply your change again.`,
          currentRevision: outcome.current,
          expectedRevision: outcome.expected,
        },
        409
      );
    case 'unsafe':
      return c.json(
        {
          error: 'unsafe_change',
          message: `${outcome.issues.map((i) => i.message).join(' ')} Run it with ?dryRun=1 to review, then repeat the request acknowledging: ${outcome.issues.map((i) => i.code).join(', ')}.`,
          issues: outcome.issues,
          acknowledge: outcome.issues.map((i) => i.code),
        },
        422
      );
    case 'written':
      c.header('ETag', `"${outcome.row.revision}"`);
      return c.json({
        ...documentOf(scope, outcome.row),
        ...impactJson(outcome.impact),
      });
  }
}

async function replaceScope(
  deps: AppDeps,
  c: Context,
  scope: Scope,
  actor: string
): Promise<Response> {
  const request = await readWriteRequest(c);
  if (!request.ok) return request.response;
  const checked = validateConfig(request.value.document);
  if (!checked.ok) return invalidBody(c, 'invalid_settings', checked.errors);
  if (
    scope.startsWith('node:') &&
    (await deps.store.findNode(scope.slice('node:'.length))) === null
  ) {
    return controllerError(c, 404, 'not_found', 'No such node.');
  }
  const change: ChangeRequest = {
    scope,
    value: checked.value as FleetConfig,
    actor,
    expectedRevision: request.value.expectedRevision,
    acknowledge: request.value.acknowledge,
    dryRun: dryRunRequested(c),
    cause: 'put',
  };
  return respond(c, scope, await changeSettings(deps, change));
}

/** `{ historyId, expectedRevision?, acknowledge? }`: write an earlier version again. */
async function restoreScope(
  deps: AppDeps,
  c: Context,
  scope: Scope,
  actor: string
): Promise<Response> {
  const body = await readJson(c);
  if (!body.ok) return body.response;
  const record = isRecord(body.value) ? body.value : {};
  const historyId = record['historyId'];
  if (typeof historyId !== 'number' || !Number.isInteger(historyId))
    return controllerError(
      c,
      400,
      'invalid_request',
      'historyId must be the id of an entry from the scope history.'
    );
  const checked = readPreconditions(c, record);
  if (!checked.ok) return checked.response;
  const entry = (await deps.store.settingsHistory(scope, MAX_HISTORY)).find(
    (candidate) => candidate.id === historyId
  );
  const valid = entry === undefined ? null : validateConfig(entry.value);
  if (valid === null || !valid.ok)
    return controllerError(
      c,
      404,
      'not_found',
      'That version is not in the recent history or can no longer be restored.'
    );
  const change: ChangeRequest = {
    scope,
    value: valid.value as FleetConfig,
    actor,
    ...checked.value,
    dryRun: dryRunRequested(c),
    cause: 'restore',
    restoredFrom: historyId,
  };
  return respond(c, scope, await changeSettings(deps, change));
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
  // Credential rotation, revocation and desired history share this admin surface.
  mountAccessSafety(app, deps);
  app.get(
    '/v1/settings',
    adminRoute(deps, async (c) => {
      const viewer = !mayWrite(await roleOf(deps, c));
      const settings = await deps.store.listSettings();
      return c.json({
        settings: settings.map((row) => ({
          ...row,
          value: readable(row.value, viewer),
        })),
      });
    })
  );
  app.get(
    '/v1/settings/:scope/history',
    adminRoute(deps, async (c) => {
      const scope = scopeOf(c);
      const limit = historyLimit(c);
      if (scope === null) return badScope(c);
      if (limit === null)
        return controllerError(
          c,
          400,
          'invalid_request',
          `limit must be between 1 and ${MAX_HISTORY}`
        );
      const viewer = !mayWrite(await roleOf(deps, c));
      const history = await deps.store.settingsHistory(scope, limit);
      return c.json({
        history: history.map((row) => ({
          ...row,
          value: readable(row.value, viewer),
        })),
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
  app.post(
    '/v1/settings/:scope/restore',
    adminRoute(deps, async (c, actor) => {
      const scope = scopeOf(c);
      return scope === null ? badScope(c) : restoreScope(deps, c, scope, actor);
    })
  );
}
