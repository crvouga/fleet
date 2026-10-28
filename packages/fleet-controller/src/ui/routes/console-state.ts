import type { Context, Hono } from 'hono';
import { isScope } from '../../config/schema';
import type { EventQuery } from '../../store';
import type { AppDeps } from '../../deps';
import { loadFleet } from '../lib/fleet-data';
import { maskUrl } from '../lib/format';
import { annotateHistory } from '../../domain/desired-history';
import { roleOf } from '../../routes/guards';
import { safeNext } from './guard';

function safeJson(c: Context, value: unknown, status: 200 | 401 | 403 = 200) {
  c.header('Cache-Control', 'no-store');
  return c.body(
    JSON.stringify(value, (key, entry: unknown) =>
      key === 'webhookUrl' && typeof entry === 'string' ? maskUrl(entry) : entry
    ),
    status,
    { 'Content-Type': 'application/json' }
  );
}

async function publicState(deps: AppDeps, c: Context, path: string) {
  const actor = await deps.auth.actor(c);
  if (actor) return { actor };
  const identity = await deps.browserAuth?.identity(c);
  return safeJson(
    c,
    {
      status: identity ? 'denied' : 'signed-out',
      actor: identity?.email ?? null,
      authAvailable: !!deps.browserAuth,
      next: safeNext(c.req.query('next')),
      error: c.req.query('error')
        ? 'OpenID Connect sign-in could not be completed. Please try again.'
        : null,
    },
    path === '/login' || path === '/not-allowed' ? 200 : 401
  );
}

async function details(deps: AppDeps, path: string, query: URLSearchParams) {
  const nodeId = path.match(/^\/nodes\/([a-f0-9]{64})$/)?.[1];
  const scope = path.startsWith('/settings/')
    ? path.slice('/settings/'.length)
    : 'fleet';
  const [events, points, history, desired, credential] = await Promise.all([
    deps.store.listEvents({ limit: 200, ...eventFilters(nodeId, query) }),
    nodeId
      ? deps.store.listHeartbeats(
          nodeId,
          new Date(deps.now().getTime() - 86400_000)
        )
      : [],
    path.startsWith('/settings') && isScope(scope)
      ? deps.store.settingsHistory(scope, 50)
      : [],
    nodeId ? deps.store.desiredHistory(nodeId, 50) : [],
    nodeId ? deps.store.credentialStatus(nodeId) : null,
  ]);
  return {
    events,
    points,
    history,
    desiredHistory: annotateHistory(desired),
    credential,
    nextBefore: events.length === 200 ? events.at(-1)?.id : null,
  };
}

export function registerConsoleState(app: Hono, deps: AppDeps) {
  app.get('/ui/state', async (c) => {
    const target = new URL(
      safeNext(c.req.query('path')),
      'http://fleet.invalid'
    );
    const path = target.pathname;
    const session = await publicState(deps, c, path);
    if (session instanceof Response) return session;
    const fleet = await loadFleet(deps);
    const identity = await deps.browserAuth?.identity(c);
    const entries =
      path === '/access' && identity?.allowed
        ? await deps.browserAuth!.access.entries()
        : [];
    return safeJson(c, {
      status: 'ready',
      path: path + target.search,
      actor: session.actor,
      fleet: { ...fleet, documents: [...fleet.documents] },
      ...(await details(deps, path, target.searchParams)),
      role: await roleOf(deps, c),
      revisions: Object.fromEntries(
        (await deps.store.listSettings()).map((row) => [
          row.scope,
          row.revision,
        ])
      ),
      access: {
        available: !!identity?.allowed,
        emails: entries.map((entry) => entry.email),
        entries: entries.map((entry) => ({
          email: entry.email,
          role: entry.role,
        })),
      },
    });
  });
}

function eventFilters(
  nodeId: string | undefined,
  query: URLSearchParams
): Omit<EventQuery, 'limit'> {
  const node = nodeId ?? query.get('node');
  const severity = query.get('severity');
  const before = Number(query.get('before'));
  return {
    ...(node && /^[a-f0-9]{64}$/.test(node) ? { nodeId: node } : {}),
    ...(severity === 'warn' || severity === 'error' ? { severity } : {}),
    ...(Number.isSafeInteger(before) && before > 0 ? { beforeId: before } : {}),
  };
}
