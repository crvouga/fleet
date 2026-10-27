import type { Context, Hono } from 'hono';
import type { Child } from 'hono/jsx';

import type { AppDeps } from '../../deps';
import type { EventRow } from '../../types';
import { AddNodeSteps } from '../components/add-node';
import { ActionForm } from '../components/forms';
import { LiveRegion, LiveStatus } from '../components/live';
import { Shell, PageHeader } from '../layout';
import { takeFlash } from '../lib/flash';
import { loadFleet, type FleetData } from '../lib/fleet-data';
import { pluralize } from '../lib/format';
import {
  nodesHref,
  parseNodesQuery,
  type NodesQuery,
} from '../lib/nodes-query';
import {
  EVENTS_PAGE_SIZE,
  EventsBody,
  parseEventsQuery,
} from '../pages/events';
import { NodeDetailBody, NodeHeaderMeta } from '../pages/node-detail';
import { NodesBody, NodesToolbar } from '../pages/nodes';
import { NotFoundBody } from '../pages/not-found';
import { LIVE_OVERVIEW, OverviewBody } from '../pages/overview';
import { PendingBody } from '../pages/pending';
import { page } from './guard';

const NODE_ID = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 3600 * 1000;
const FEED_SIZE = 6;
const FEED_SCAN = 80;
const TIMELINE_SIZE = 15;

interface Frame {
  readonly actor: string;
  readonly data: FleetData;
  readonly title: string;
  readonly path: string;
  readonly children: Child;
  readonly status?: 200 | 404;
}

function frame(c: Context, f: Frame) {
  return c.html(
    <Shell
      title={f.title}
      path={f.path}
      actor={f.actor}
      pendingCount={f.data.pendingCount}
      flash={takeFlash(c)}
    >
      {f.children}
    </Shell>,
    f.status ?? 200
  );
}

async function recentProblems(deps: AppDeps): Promise<readonly EventRow[]> {
  const events = await deps.store.listEvents({ limit: FEED_SCAN });
  return events
    .filter((event) => event.severity !== 'info')
    .slice(0, FEED_SIZE);
}

function queryOf(c: Context): Record<string, string | undefined> {
  return c.req.query();
}

function liveNodesSrc(query: NodesQuery): string {
  const href = nodesHref(query);
  const params = href.includes('?') ? `&${href.split('?')[1] ?? ''}` : '';
  return `/ui/fleet?view=nodes${params}`;
}

function overview(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const events = await recentProblems(deps);
    const body = (
      <>
        <PageHeader
          title="Overview"
          subtitle={`${pluralize(data.summary.total, 'machine')} in the fleet`}
          actions={<LiveStatus now={data.now} />}
        />
        <LiveRegion src={LIVE_OVERVIEW}>
          <OverviewBody data={data} events={events} />
        </LiveRegion>
      </>
    );
    return frame(c, {
      actor,
      data,
      title: 'Overview',
      path: '/',
      children: body,
    });
  });
}

function nodes(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const query = parseNodesQuery(queryOf(c));
    const body = (
      <>
        <PageHeader
          title="Nodes"
          subtitle="Every machine and how it is doing."
          actions={<LiveStatus now={data.now} />}
        />
        {data.entries.length === 0 ? null : <NodesToolbar query={query} />}
        <LiveRegion src={liveNodesSrc(query)}>
          <NodesBody data={data} query={query} />
        </LiveRegion>
      </>
    );
    return frame(c, {
      actor,
      data,
      title: 'Nodes',
      path: '/nodes',
      children: body,
    });
  });
}

function nodeDetail(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const id = c.req.param('id') ?? '';
    const data = await loadFleet(deps);
    const entry = NODE_ID.test(id)
      ? data.entries.find((e) => e.view.id === id)
      : undefined;
    if (entry === undefined) {
      const missing = (
        <NotFoundBody what="Node" href="/nodes" link="Back to nodes" />
      );
      return frame(c, {
        actor,
        data,
        title: 'Node not found',
        path: '/nodes',
        children: missing,
        status: 404,
      });
    }
    const [points, events] = await Promise.all([
      deps.store.listHeartbeats(id, new Date(data.now.getTime() - DAY_MS)),
      deps.store.listEvents({ nodeId: id, limit: TIMELINE_SIZE }),
    ]);
    const pending = entry.view.status === 'pending';
    const actions = pending ? (
      <>
        <ActionForm
          action={`/nodes/${id}/approve`}
          label="Approve"
          tone="primary"
        />
        <ActionForm action={`/nodes/${id}/reject`} label="Reject" />
      </>
    ) : (
      <a class="btn" href={`/settings/node:${id}`}>
        Node settings
      </a>
    );
    const body = (
      <>
        <PageHeader
          title={entry.view.label}
          subtitle={<NodeHeaderMeta entry={entry} />}
          actions={actions}
          back={{ href: '/nodes', label: 'All nodes' }}
        />
        <NodeDetailBody
          entry={entry}
          data={data}
          points={points}
          events={events}
        />
      </>
    );
    return frame(c, {
      actor,
      data,
      title: entry.view.label,
      path: `/nodes/${id}`,
      children: body,
    });
  });
}

function pending(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const body = (
      <>
        <PageHeader
          title="Pending approvals"
          subtitle="Machines that asked to join. Check what they are, then decide."
        />
        <PendingBody data={data} />
      </>
    );
    return frame(c, {
      actor,
      data,
      title: 'Pending approvals',
      path: '/pending',
      children: body,
    });
  });
}

function events(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const query = parseEventsQuery(queryOf(c));
    const fetched = await deps.store.listEvents({
      limit: EVENTS_PAGE_SIZE + 1,
      ...(query.nodeId === null ? {} : { nodeId: query.nodeId }),
      ...(query.severity === null ? {} : { severity: query.severity }),
      ...(query.before === null ? {} : { beforeId: query.before }),
    });
    const matching = fetched.filter(
      (e) => query.severity === null || e.severity === query.severity
    );
    const shown = matching.slice(0, EVENTS_PAGE_SIZE);
    const body = (
      <>
        <PageHeader
          title="Events"
          subtitle="Everything nodes and people did, newest first."
        />
        <EventsBody
          query={query}
          entries={data.entries}
          events={shown}
          hasMore={matching.length > EVENTS_PAGE_SIZE}
          now={data.now}
        />
      </>
    );
    return frame(c, {
      actor,
      data,
      title: 'Events',
      path: '/events',
      children: body,
    });
  });
}

function addNode(deps: AppDeps) {
  return page(deps, async (c, actor) => {
    const data = await loadFleet(deps);
    const body = <AddNodeSteps heading="h1" title="Add a node" />;
    return frame(c, {
      actor,
      data,
      title: 'Add a node',
      path: '/add',
      children: body,
    });
  });
}

/** The auto-refresh fragment: overview by default, `view=nodes` for the nodes table. */
function fragment(deps: AppDeps) {
  return page(deps, async (c) => {
    const data = await loadFleet(deps);
    if (c.req.query('view') === 'nodes') {
      return c.html(
        <NodesBody data={data} query={parseNodesQuery(queryOf(c))} />
      );
    }
    return c.html(
      <OverviewBody data={data} events={await recentProblems(deps)} />
    );
  });
}

export function registerPages(app: Hono, deps: AppDeps): void {
  app.get('/', overview(deps));
  app.get('/nodes', nodes(deps));
  app.get('/nodes/:id', nodeDetail(deps));
  app.get('/pending', pending(deps));
  app.get('/events', events(deps));
  app.get('/add', addNode(deps));
  app.get('/ui/fleet', fragment(deps));
}
