import type { Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';

import type { AppDeps } from '../../deps';
import { requireAdminPage } from './operations-access';
import { Shell, PageHeader } from '../layout';
import { takeFlash } from '../lib/flash';
import { loadFleet } from '../lib/fleet-data';
import { AuditBody, OperationsBody } from '../pages/operations';
import { page } from './guard';

const PAGE_SIZE = 50;

function cursorOf(raw: string | undefined) {
  const match = /^(\d{1,15}):([A-Za-z0-9-]{1,64})$/.exec(raw ?? '');
  return match === null
    ? undefined
    : { requestedAt: new Date(Number(match[1])), id: match[2]! };
}

function operations(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const before = cursorOf(c.req.query('cursor'));
    const rows = await deps.store.operations.list({
      limit: PAGE_SIZE + 1,
      ...(before === undefined ? {} : { before }),
    });
    const shown = rows.slice(0, PAGE_SIZE);
    const last = shown.at(-1);
    return frame(c, {
      actor,
      data,
      title: 'Operations',
      path: '/operations',
      subtitle:
        'Drain, restart, replace and decommission, with their progress.',
      body: (
        <OperationsBody
          operations={shown}
          labels={new Map(data.entries.map((e) => [e.view.id, e.view.label]))}
          now={data.now}
          nextCursor={
            rows.length > PAGE_SIZE && last !== undefined
              ? `${last.requestedAt.getTime()}:${last.id}`
              : null
          }
        />
      ),
    });
  });
}

function audit(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const denied = await requireAdminPage(deps, c, actor);
    if (denied !== null) return denied;
    const data = await loadFleet(deps);
    const before = Number(c.req.query('before'));
    const rows = await deps.store.listAudit({
      limit: PAGE_SIZE + 1,
      ...(Number.isSafeInteger(before) && before > 0
        ? { beforeId: before }
        : {}),
    });
    const shown = rows.slice(0, PAGE_SIZE);
    return frame(c, {
      actor,
      data,
      title: 'Audit log',
      path: '/audit',
      subtitle: 'Who did what, newest first. Visible to administrators only.',
      body: (
        <AuditBody
          entries={shown}
          nextBefore={
            rows.length > PAGE_SIZE ? (shown.at(-1)?.id ?? null) : null
          }
        />
      ),
    });
  });
}

function frame(
  c: Context,
  f: {
    readonly actor: string;
    readonly data: Awaited<ReturnType<typeof loadFleet>>;
    readonly title: string;
    readonly path: string;
    readonly subtitle: string;
    readonly body: Child;
  }
) {
  return c.html(
    <Shell
      title={f.title}
      path={f.path}
      actor={f.actor}
      pendingCount={f.data.pendingCount}
      flash={takeFlash(c)}
    >
      <PageHeader title={f.title} subtitle={f.subtitle} />
      {f.body}
    </Shell>
  );
}

export function registerOperationsPages(app: Hono, deps: AppDeps): void {
  app.get('/operations', operations(deps));
  app.get('/audit', audit(deps));
}
