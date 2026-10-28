import { logContext } from '@pkgs/logger';
import type { Context, Hono } from 'hono';

import type { AppDeps } from '../deps';
import { mayWrite } from '../auth/roles';
import { linkOf } from '../issues/store';
import { parseTarget } from '../issues/target';
import {
  previewReport,
  submitReport,
  type Submission,
  type Who,
} from '../issues/service';
import type { IssueReport } from '../issues/types';
import { viewOfDraft, viewOfReport } from '../issues/views';

import { adminRoute, roleOf } from './guards';
import { controllerError, invalidBody, readJson } from './http';

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

async function whoIs(deps: AppDeps, c: Context, actor: string): Promise<Who> {
  const role = await roleOf(deps, c);
  const requestId = logContext()['requestId'];
  return {
    actor,
    role: mayWrite(role) ? 'admin' : 'viewer',
    requestId: typeof requestId === 'string' ? requestId : null,
  };
}

function unavailable(c: Context): Response {
  return controllerError(
    c,
    503,
    'issues_unavailable',
    'Issue reporting is not available in this mode.'
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** POST /v1/issues/preview: the redacted report for a target. Saved as a draft for an admin only. */
function preview(deps: AppDeps) {
  return adminRoute(
    deps,
    async (c, actor) => {
      const body = await readJson(c);
      if (!body.ok) return body.response;
      const parsed = parseTarget(asRecord(body.value));
      if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
      const who = await whoIs(deps, c, actor);
      const result = await previewReport(deps, who, parsed.target);
      if (!result.ok) return controllerError(c, 404, 'not_found', result.error);
      const view =
        result.report === null
          ? viewOfDraft(result.draft, deps.issues, result.duplicate)
          : viewOfReport(result.report, deps.issues, result.duplicate);
      return c.json({ ...view, persisted: result.report !== null });
    },
    { access: 'read' }
  );
}

function submitted(c: Context, deps: AppDeps, result: Submission): Response {
  switch (result.outcome) {
    case 'not_found':
      return controllerError(
        c,
        404,
        'not_found',
        'No such draft. Preview the report again.'
      );
    case 'not_configured':
      return c.json(
        {
          error: 'issues_not_configured',
          message: viewOfReport(result.report, deps.issues).submission.reason,
          report: viewOfReport(result.report, deps.issues),
        },
        409
      );
    case 'duplicate':
      return c.json({
        outcome: 'duplicate',
        report: viewOfReport(result.report, deps.issues),
        draft: viewOfReport(result.own, deps.issues, linkOf(result.report)),
      });
    case 'existing':
      return c.json({
        outcome: 'existing',
        report: viewOfReport(result.report, deps.issues),
      });
    default:
      return outcomeOf(c, deps, result.report);
  }
}

/** 201 created, 202 queued for retry, 502 failed (the preview stays usable). */
function outcomeOf(c: Context, deps: AppDeps, report: IssueReport): Response {
  const view = viewOfReport(report, deps.issues);
  if (report.status === 'created')
    return c.json({ outcome: 'created', report: view }, 201);
  if (report.status === 'queued')
    return c.json({ outcome: 'queued', report: view }, 202);
  return c.json(
    {
      error: 'issue_failed',
      message: report.lastError,
      outcome: 'failed',
      report: view,
    },
    502
  );
}

/** POST /v1/issues: `{draftId}` from a preview, or a target (previewed and filed in one go). */
function submit(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    if (deps.issues === undefined) return unavailable(c);
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const input = asRecord(body.value);
    const who = await whoIs(deps, c, actor);
    let id = typeof input['draftId'] === 'string' ? input['draftId'] : null;
    if (id === null) {
      const parsed = parseTarget(input);
      if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
      const made = await previewReport(deps, who, parsed.target);
      if (!made.ok) return controllerError(c, 404, 'not_found', made.error);
      id = made.report?.id ?? null;
    }
    if (id === null)
      return controllerError(c, 404, 'not_found', 'No draft to submit.');
    return submitted(c, deps, await submitReport(deps, who, id));
  });
}

function cursorOf(raw: string | undefined) {
  const match = /^(\d{1,15}):([A-Za-z0-9-]{1,64})$/.exec(raw ?? '');
  return match === null
    ? undefined
    : { createdAt: new Date(Number(match[1])), id: match[2]! };
}

function list(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const runtime = deps.issues;
    if (runtime === undefined) return unavailable(c);
    const limit = Math.min(
      MAX_PAGE,
      Math.max(1, Number(c.req.query('limit')) || DEFAULT_PAGE)
    );
    const node = c.req.query('node');
    const before = cursorOf(c.req.query('before'));
    const rows = await runtime.store.list({
      limit: limit + 1,
      ...(node === undefined || !/^[0-9a-f]{64}$/.test(node)
        ? {}
        : { nodeId: node }),
      ...(before === undefined ? {} : { before }),
    });
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return c.json({
      reports: shown.map((row) => ({
        ...viewOfReport(row, runtime),
        body: undefined,
      })),
      nextBefore:
        rows.length > limit && last !== undefined
          ? `${last.createdAt.getTime()}:${last.id}`
          : null,
    });
  });
}

function links(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const runtime = deps.issues;
    if (runtime === undefined) return c.json({ node: [], events: {} });
    const node = c.req.query('node');
    const events =
      c.req
        .queries('event')
        ?.map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0) ?? [];
    const [nodeLinks, eventLinks] = await Promise.all([
      node !== undefined && /^[0-9a-f]{64}$/.test(node)
        ? runtime.store.linksForNode(node)
        : [],
      runtime.store.linksForEvents(events.slice(0, 200)),
    ]);
    return c.json({ node: nodeLinks, events: Object.fromEntries(eventLinks) });
  });
}

function detail(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const runtime = deps.issues;
    if (runtime === undefined) return unavailable(c);
    const report = await runtime.store.get(c.req.param('id') ?? '');
    if (report === null)
      return controllerError(c, 404, 'not_found', 'No such report.');
    const open =
      report.status === 'duplicate'
        ? await runtime.store.findOpen(report.fingerprint)
        : null;
    return c.json(
      viewOfReport(report, runtime, open === null ? null : linkOf(open))
    );
  });
}

/** Issue reporting API: preview, file, list, links for badges, and one report. */
export function mountAdminIssues(app: Hono, deps: AppDeps): void {
  app.post('/v1/issues/preview', preview(deps));
  app.get('/v1/issues/links', links(deps));
  app.post('/v1/issues', submit(deps));
  app.get('/v1/issues', list(deps));
  app.get('/v1/issues/:id', detail(deps));
}
