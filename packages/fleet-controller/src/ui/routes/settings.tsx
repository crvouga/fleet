import type { Context, Hono } from 'hono';

import {
  isScope,
  validateConfig,
  type FleetConfig,
  type Scope,
} from '../../config/schema';
import { mayWrite } from '../../auth/roles';
import type { AppDeps } from '../../deps';
import type { SettingsImpact } from '../../domain/settings-impact';
import { roleOf } from '../../routes/guards';
import {
  changeSettings,
  type ChangeOutcome,
  type ChangeRequest,
} from '../../routes/settings-change';
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
import { readSafetyFields } from '../lib/settings-safety-form';
import { NotFoundBody } from '../pages/not-found';
import { SettingsBody, type SettingsPageProps } from '../pages/settings';
import { NO_SAFETY, type SettingsSafety } from '../pages/settings-safety';
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
  readonly status?: 200 | 409 | 422 | 428;
  readonly safety?: Partial<SettingsSafety>;
  /** What a script (the console) receives instead of a page. */
  readonly json?: Record<string, unknown>;
}

interface Session {
  readonly deps: AppDeps;
  readonly actor: string;
}

/** The page's props: the stored document, the person's draft, and the safety state. */
function pagePropsOf(
  resolved: Resolved,
  data: FleetData,
  attempt: Attempt,
  loaded: {
    readonly history: SettingsPageProps['history'];
    readonly revision: number;
    readonly readOnly: boolean;
  }
): SettingsPageProps {
  const stored = (data.documents.get(resolved.scope) ?? {}) as FleetConfig;
  return {
    scope: resolved.scope,
    node: resolved.node,
    stored,
    draft: attempt.draft ?? (stored as Draft),
    errors: attempt.errors ?? [],
    rawError: attempt.rawError ?? null,
    rawText: attempt.rawText ?? null,
    history: loaded.history,
    documents: data.documents,
    now: data.now,
    safety: {
      ...NO_SAFETY,
      revision: loaded.revision,
      readOnly: loaded.readOnly,
      ...attempt.safety,
    },
  };
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
  const [history, row, role] = await Promise.all([
    deps.store.settingsHistory(resolved.scope, HISTORY_SIZE),
    deps.store.getSettings(resolved.scope),
    roleOf(deps, c),
  ]);
  const props = pagePropsOf(resolved, data, attempt, {
    history,
    revision: row?.revision ?? 0,
    readOnly: !mayWrite(role),
  });
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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function previewText(impact: SettingsImpact): string {
  const need = impact.issues.filter((issue) => issue.blocking);
  return [
    `Preview: nothing was saved. ${plural(impact.changes.length, 'node')} of ${impact.totalNodes} would receive a new desired document.`,
    ...need.map((issue) => `Needs acknowledgement: ${issue.message}`),
  ].join(' ');
}

interface Sent {
  readonly resolved: Resolved;
  readonly actor: string;
  readonly draft: Draft;
  readonly rawText: string | null;
  readonly whenWritten: string;
  /** Warning boxes already ticked stay ticked after a refusal. */
  readonly acknowledged: readonly string[];
}

/** Turns what the safety layer decided into the page, or the JSON the console reads. */
async function answer(
  deps: AppDeps,
  c: Context,
  sent: Sent,
  outcome: ChangeOutcome
): Promise<Response> {
  const session = { deps, actor: sent.actor };
  const here = `/settings/${sent.resolved.scope}`;
  const keep = { draft: sent.draft, rawText: sent.rawText };
  switch (outcome.kind) {
    case 'written':
      return back(c, here, {
        kind: 'success',
        text: `${sent.whenWritten} ${plural(outcome.impact.changes.length, 'node')} will converge on the next heartbeat.`,
      });
    case 'dry_run':
      if (c.req.header('accept')?.includes('application/json'))
        return c.json({
          flash: { kind: 'success', text: previewText(outcome.impact) },
        });
      return renderSettings(c, session, sent.resolved, {
        ...keep,
        safety: { preview: outcome.impact, issues: outcome.blockedBy },
      });
    case 'conflict': {
      // Keep the OLD revision so saving again cannot overwrite the other change.
      const text = `Nothing was saved: these settings changed (now revision ${outcome.current}). Reload to see the latest, then apply your edit again.`;
      return renderSettings(c, session, sent.resolved, {
        ...keep,
        rawText: keep.rawText ?? JSON.stringify(sent.draft, null, 2),
        status: 409,
        safety: {
          conflict: { current: outcome.current },
          revision: outcome.expected,
        },
        json: {
          error: text,
          code: 'conflict',
          currentRevision: outcome.current,
        },
      });
    }
    case 'precondition_required':
      return renderSettings(c, session, sent.resolved, {
        ...keep,
        errors: [
          'This form did not say which version it was based on. Reload the page and try again.',
        ],
        status: 428,
        json: {
          error:
            'This form did not say which version it was based on. Reload the page and try again.',
          code: 'precondition_required',
          currentRevision: outcome.current,
        },
      });
    case 'unsafe':
      return renderSettings(c, session, sent.resolved, {
        ...keep,
        status: 422,
        safety: { issues: outcome.issues, acknowledged: sent.acknowledged },
        json: {
          error: `${outcome.issues.map((issue) => issue.message).join(' ')} Nothing was saved: confirm you understand, then save again.`,
          code: 'unsafe_change',
          issues: outcome.issues,
        },
      });
  }
}

function save(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const resolved = resolveScope(c.req.param('scope') ?? '', data);
    if (resolved === null) return notFound(deps, c, actor);
    const stored = (data.documents.get(resolved.scope) ?? {}) as FleetConfig;
    const form = (await c.req.parseBody({ all: true })) as FormBody;
    const parsed = parseSubmission(form, stored);
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
    const fields = readSafetyFields(form);
    const request: ChangeRequest = {
      scope: resolved.scope,
      value: result.value,
      actor,
      expectedRevision: fields.expectedRevision,
      acknowledge: fields.acknowledge,
      dryRun: fields.preview,
      cause: 'put',
    };
    const sent: Sent = {
      resolved,
      actor,
      draft: parsed.draft,
      rawText: parsed.rawText,
      whenWritten: `${scopeLabel(resolved.scope)} settings saved.`,
      acknowledged: fields.acknowledge,
    };
    const outcome = await changeSettings(deps, request);
    return answer(deps, c, sent, outcome);
  });
}

function restore(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const resolved = resolveScope(c.req.param('scope') ?? '', data);
    if (resolved === null) return notFound(deps, c, actor);
    const form = (await c.req.parseBody({ all: true })) as FormBody;
    const raw = Array.isArray(form['historyId'])
      ? form['historyId'][0]
      : form['historyId'];
    const id = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
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
    const fields = readSafetyFields(form);
    const outcome = await changeSettings(deps, {
      scope: resolved.scope,
      value: result.value,
      actor,
      expectedRevision: fields.expectedRevision,
      acknowledge: fields.acknowledge,
      dryRun: false,
      cause: 'restore',
      restoredFrom: id,
    });
    return restored(c, here, outcome);
  });
}

/** The flash a rollback ends with; a refusal says why and changes nothing. */
function restored(c: Context, here: string, outcome: ChangeOutcome): Response {
  switch (outcome.kind) {
    case 'written':
      return back(c, here, {
        kind: 'success',
        text: `Rolled back to the earlier version. ${plural(outcome.impact.changes.length, 'node')} will converge on the next heartbeat.`,
      });
    case 'conflict':
      return back(c, here, {
        kind: 'error',
        text: `Nothing was restored: these settings changed (now revision ${outcome.current}). Review the latest history and try again.`,
      });
    case 'unsafe':
      return back(c, here, {
        kind: 'error',
        text: `Nothing was restored: ${outcome.issues.map((issue) => issue.message).join(' ')} Apply that version through the settings form, which asks you to confirm.`,
      });
    default:
      return back(c, here, {
        kind: 'error',
        text: 'Nothing was restored. Reload the page and try again.',
      });
  }
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
    attempt.status === undefined ||
    attempt.status === 200 ||
    !c.req.header('accept')?.includes('application/json')
  )
    return null;
  if (attempt.json !== undefined) return c.json(attempt.json, attempt.status);
  return c.json(
    {
      error: attempt.rawError ?? 'Nothing was saved.',
      errors: attempt.errors ?? [],
    },
    422
  );
}
