import type { Context, Hono } from 'hono';

import {
  isScope,
  validateConfig,
  type FleetConfig,
  type Scope,
} from '../../config/schema';
import type { AppDeps } from '../../deps';
import type { NodeView } from '../../types';
import { PageHeader, Shell } from '../layout';
import { takeFlash } from '../lib/flash';
import { loadFleet, type FleetData } from '../lib/fleet-data';
import { scopeLabel } from '../lib/effective';
import {
  draftFromForm,
  draftFromRaw,
  splitErrors,
  type Draft,
  type FormBody,
} from '../lib/settings-form';
import { NotFoundBody } from '../pages/not-found';
import { SettingsBody, type SettingsPageProps } from '../pages/settings';
import { action, back, page, type Handler } from './guard';

const HISTORY_SIZE = 10;
const HISTORY_FETCH = 50;

interface Resolved {
  readonly scope: Scope;
  readonly node: NodeView | null;
}

function resolveScope(raw: string, data: FleetData): Resolved | null {
  if (!isScope(raw)) return null;
  if (!raw.startsWith('node:')) return { scope: raw, node: null };
  const node =
    data.entries.find((e) => `node:${e.view.id}` === raw)?.view ?? null;
  return node === null ? null : { scope: raw, node };
}

function heading(resolved: Resolved): string {
  return resolved.node === null
    ? `${scopeLabel(resolved.scope)} settings`
    : `Settings for ${resolved.node.label}`;
}

interface Attempt {
  readonly draft?: Draft;
  readonly errors?: readonly string[];
  readonly rawError?: string | null;
  readonly rawText?: string | null;
  readonly status?: 200 | 422;
}

interface Session {
  readonly deps: AppDeps;
  readonly actor: string;
}

async function renderSettings(
  c: Context,
  session: Session,
  resolved: Resolved,
  attempt: Attempt = {}
) {
  const { deps, actor } = session;
  const jsonError = settingsJsonError(c, attempt);
  if (jsonError) return jsonError;
  const data = await loadFleet(deps);
  const stored = (data.documents.get(resolved.scope) ?? {}) as FleetConfig;
  const history = await deps.store.settingsHistory(
    resolved.scope,
    HISTORY_SIZE
  );
  const props: SettingsPageProps = {
    scope: resolved.scope,
    node: resolved.node,
    stored,
    draft: attempt.draft ?? (stored as Draft),
    errors: attempt.errors ?? [],
    rawError: attempt.rawError ?? null,
    rawText: attempt.rawText ?? null,
    history,
    documents: data.documents,
    now: data.now,
  };
  return c.html(
    <Shell
      title={heading(resolved)}
      path="/settings"
      actor={actor}
      pendingCount={data.pendingCount}
      flash={takeFlash(c)}
    >
      <PageHeader title="Settings" subtitle={heading(resolved)} />
      <SettingsBody {...props} />
    </Shell>,
    attempt.status ?? 200
  );
}

async function notFound(deps: AppDeps, c: Context, actor: string) {
  const data = await loadFleet(deps);
  return c.html(
    <Shell
      title="Settings not found"
      path="/settings"
      actor={actor}
      pendingCount={data.pendingCount}
      flash={null}
    >
      <NotFoundBody
        what="Settings scope"
        href="/settings"
        link="Back to settings"
      />
    </Shell>,
    404
  );
}

function show(deps: AppDeps, fixed?: string): Handler {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const resolved = resolveScope(fixed ?? c.req.param('scope') ?? '', data);
    return resolved === null
      ? notFound(deps, c, actor)
      : renderSettings(c, { deps, actor }, resolved);
  });
}

interface Parsed {
  readonly draft: Draft;
  readonly rawError: string | null;
  readonly rawText: string | null;
}

function parseSubmission(form: FormBody, stored: FleetConfig): Parsed {
  if (form['mode'] !== 'raw')
    return {
      draft: draftFromForm(form, stored),
      rawError: null,
      rawText: null,
    };
  const text = typeof form['raw'] === 'string' ? form['raw'] : '';
  const raw = draftFromRaw(text, stored);
  return raw.ok
    ? { draft: raw.draft, rawError: null, rawText: text }
    : { draft: stored as Draft, rawError: raw.error, rawText: text };
}

function save(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const resolved = resolveScope(c.req.param('scope') ?? '', data);
    if (resolved === null) return notFound(deps, c, actor);
    const stored = (data.documents.get(resolved.scope) ?? {}) as FleetConfig;
    const parsed = parseSubmission(
      (await c.req.parseBody({ all: true })) as FormBody,
      stored
    );
    if (parsed.rawError !== null)
      return renderSettings(c, { deps, actor }, resolved, {
        ...parsed,
        errors: [],
        status: 422,
      });
    const result = validateConfig(parsed.draft);
    if (!result.ok) {
      return renderSettings(c, { deps, actor }, resolved, {
        draft: parsed.draft,
        errors: result.errors,
        rawText: parsed.rawText,
        status: 422,
      });
    }
    await deps.store.putSettings(resolved.scope, result.value, actor);
    return back(c, `/settings/${resolved.scope}`, {
      kind: 'success',
      text: `${scopeLabel(resolved.scope)} settings saved.`,
    });
  });
}

function restore(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const resolved = resolveScope(c.req.param('scope') ?? '', data);
    if (resolved === null) return notFound(deps, c, actor);
    const form = await c.req.parseBody();
    const id = Number.parseInt(
      typeof form['historyId'] === 'string' ? form['historyId'] : '',
      10
    );
    const entries = await deps.store.settingsHistory(
      resolved.scope,
      HISTORY_FETCH
    );
    const entry = entries.find((e) => e.id === id);
    const here = `/settings/${resolved.scope}`;
    const result = entry === undefined ? null : validateConfig(entry.value);
    if (result === null || !result.ok) {
      return back(c, here, {
        kind: 'error',
        text: 'That version cannot be restored.',
      });
    }
    await deps.store.putSettings(resolved.scope, result.value, actor);
    return back(c, here, {
      kind: 'success',
      text: 'Previous version restored.',
    });
  });
}

export function registerSettings(app: Hono, deps: AppDeps): void {
  app.get('/settings', show(deps, 'fleet'));
  app.get('/settings/:scope', show(deps));
  app.post('/settings/:scope/restore', restore(deps));
  app.post('/settings/:scope', save(deps));
}

export { splitErrors };

function settingsJsonError(c: Context, attempt: Attempt) {
  if (
    attempt.status !== 422 ||
    !c.req.header('accept')?.includes('application/json')
  )
    return null;
  return c.json(
    {
      error: attempt.rawError ?? 'Nothing was saved.',
      errors: attempt.errors ?? [],
    },
    422
  );
}
