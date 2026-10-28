import { logContext } from '@pkgs/logger';
import type { Context, Hono } from 'hono';

import { mayWrite } from '../../auth/roles';
import type { AppDeps } from '../../deps';
import { parseTarget } from '../../issues/target';
import {
  previewReport,
  submitReport,
  type Submission,
} from '../../issues/service';
import { viewOfDraft, viewOfReport, type ReportView } from '../../issues/views';
import { roleOf } from '../../routes/guards';
import { Shell, PageHeader } from '../layout';
import { takeFlash, type Flash } from '../lib/flash';
import { loadFleet } from '../lib/fleet-data';
import { ReportIssueBody } from '../pages/report-issue';
import { action, back, page } from './guard';

async function frame(
  c: Context,
  deps: AppDeps,
  actor: string,
  content: { readonly body: unknown; readonly status?: 200 | 400 | 404 }
) {
  const data = await loadFleet(deps);
  return c.html(
    <Shell
      title="Report an issue"
      path="/report-issue"
      actor={actor}
      pendingCount={data.pendingCount}
      flash={takeFlash(c)}
    >
      <PageHeader
        title="Report an issue"
        subtitle="Review what will be sent. Secrets are removed first."
        back={{ href: '/events', label: 'Events' }}
      />
      {content.body as never}
    </Shell>,
    content.status ?? 200
  );
}

function Problem(props: { message: string }) {
  return (
    <div class="card card-pad">
      <p class="text-bad" role="alert">
        {props.message}
      </p>
      <a class="btn mt-4" href="/events">
        Back to events
      </a>
    </div>
  );
}

/** The report for `?draft=<id>`, or a preview built from the target in the query. */
async function viewFor(
  deps: AppDeps,
  c: Context,
  actor: string
): Promise<{ view: ReportView } | { error: string; status: 400 | 404 }> {
  const draft = c.req.query('draft');
  if (draft !== undefined) {
    const report = await deps.issues?.store.get(draft);
    if (report === null || report === undefined)
      return { error: 'No such report.', status: 404 };
    return { view: viewOfReport(report, deps.issues) };
  }
  const parsed = parseTarget(c.req.query());
  if (!parsed.ok) return { error: parsed.errors.join('; '), status: 400 };
  const role = (await roleOf(deps, c)) === 'viewer' ? 'viewer' : 'admin';
  const result = await previewReport(deps, { actor, role }, parsed.target);
  if (!result.ok) return { error: result.error, status: 404 };
  return {
    view:
      result.report === null
        ? viewOfDraft(result.draft, deps.issues, result.duplicate)
        : viewOfReport(result.report, deps.issues, result.duplicate),
  };
}

function show(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const found = await viewFor(deps, c, actor);
    if ('error' in found)
      return frame(c, deps, actor, {
        body: <Problem message={found.error} />,
        status: found.status,
      });
    const readOnly = !mayWrite(await roleOf(deps, c));
    return frame(c, deps, actor, {
      body: <ReportIssueBody view={found.view} readOnly={readOnly} />,
    });
  });
}

function flashFor(result: Submission): Flash {
  switch (result.outcome) {
    case 'not_found':
      return {
        kind: 'error',
        text: 'That draft no longer exists. Preview the report again.',
      };
    case 'not_configured':
      return {
        kind: 'error',
        text: 'Filing from the controller is not configured; copy the report instead.',
      };
    case 'duplicate':
      return {
        kind: 'success',
        text: `Already reported${result.report.githubIssueNumber === null ? '' : ` as #${result.report.githubIssueNumber}`}; nothing new was created.`,
      };
    case 'existing':
      return {
        kind: 'success',
        text: 'This report was already filed or queued.',
      };
    default:
      return result.report.status === 'created'
        ? {
            kind: 'success',
            text: `Created GitHub issue #${result.report.githubIssueNumber ?? ''}.`,
          }
        : result.report.status === 'queued'
          ? {
              kind: 'success',
              text: 'GitHub could not be reached; the report is queued and will be retried.',
            }
          : {
              kind: 'error',
              text:
                result.report.lastError ?? 'GitHub did not accept the report.',
            };
  }
}

function create(deps: AppDeps) {
  return action(deps, async (c, actor) => {
    const form = await c.req.parseBody();
    const id = typeof form['draft'] === 'string' ? form['draft'] : '';
    const requestId = logContext()['requestId'];
    const result = await submitReport(
      deps,
      {
        actor,
        role: 'admin',
        requestId: typeof requestId === 'string' ? requestId : null,
      },
      id
    );
    const target =
      result.outcome === 'not_found'
        ? '/events'
        : `/report-issue?draft=${encodeURIComponent(id)}`;
    return back(c, target, flashFor(result));
  });
}

/** `/report-issue`: preview for everyone signed in, "Create GitHub issue" for administrators. */
export function registerReportIssue(app: Hono, deps: AppDeps): void {
  app.get('/report-issue', show(deps));
  app.post('/report-issue', create(deps));
}
