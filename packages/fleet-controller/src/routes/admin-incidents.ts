import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import {
  deriveIncidents,
  filterIncidents,
  INCIDENT_EVENT_KINDS,
  summarizeIncidents,
  type Incident,
  type IncidentFilter,
} from '../domain/incidents';
import { restartHistory, RESTART_EVENT_KINDS } from '../domain/restart-history';
import { readFacts } from '../ui/lib/facts';
import type { Store } from '../store';
import type { EventRow } from '../types';

import { adminRoute } from './guards';
import { controllerError } from './http';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PAGE = 500;
const MAX_PAGES = 10;

/** The most recent matching events, bounded: incidents older than this window are not derived. */
export async function loadEvents(
  store: Store,
  query: { kinds: readonly string[]; nodeId?: string }
): Promise<{ events: EventRow[]; truncated: boolean }> {
  const events: EventRow[] = [];
  let beforeId: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await store.listEvents({
      kinds: query.kinds,
      limit: PAGE,
      ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId }),
      ...(beforeId === undefined ? {} : { beforeId }),
    });
    events.push(...rows);
    const last = rows.at(-1);
    if (rows.length < PAGE || last === undefined)
      return { events, truncated: false };
    beforeId = last.id;
  }
  return { events, truncated: true };
}

export interface IncidentReply {
  readonly incidents: Incident[];
  readonly nextBefore: number | null;
  readonly summary: ReturnType<typeof summarizeIncidents>;
  /** True when more events exist than the bounded window examined. */
  readonly truncated: boolean;
}

export async function incidentReply(
  deps: AppDeps,
  filter: IncidentFilter
): Promise<IncidentReply> {
  const { events, truncated } = await loadEvents(deps.store, {
    kinds: INCIDENT_EVENT_KINDS,
    ...(filter.nodeId === undefined ? {} : { nodeId: filter.nodeId }),
  });
  const all = deriveIncidents(events, deps.now());
  return {
    ...filterIncidents(all, filter),
    summary: summarizeIncidents(all),
    truncated,
  };
}

type Parsed =
  | { readonly ok: true; readonly filter: IncidentFilter }
  | { readonly ok: false; readonly message: string };

function wholeNumber(
  raw: string | undefined,
  max: number
): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  return value >= 1 && value <= max ? value : null;
}

interface RawQuery {
  readonly open: string | undefined;
  readonly node: string | undefined;
  readonly before: number | null | undefined;
  readonly limit: number | null | undefined;
}

function problemWith(raw: RawQuery): string | null {
  if (raw.open && raw.open !== 'true' && raw.open !== 'false')
    return 'open must be true or false';
  if (raw.node && !NODE_ID_PATTERN.test(raw.node))
    return 'node must be a 64 character node id';
  if (raw.before === null) return 'before must be a positive whole number';
  if (raw.limit === null) return `limit must be between 1 and ${MAX_LIMIT}`;
  return null;
}

/** `open` (true or false), `node`, `before` (an opening event id) and `limit`. */
export function parseIncidentQuery(c: Context): Parsed {
  const raw: RawQuery = {
    open: c.req.query('open'),
    node: c.req.query('node'),
    before: wholeNumber(c.req.query('before'), Number.MAX_SAFE_INTEGER),
    limit: wholeNumber(c.req.query('limit'), MAX_LIMIT),
  };
  const message = problemWith(raw);
  if (message !== null) return { ok: false, message };
  return {
    ok: true,
    filter: {
      limit: raw.limit ?? DEFAULT_LIMIT,
      ...(raw.open ? { open: raw.open === 'true' } : {}),
      ...(raw.node ? { nodeId: raw.node } : {}),
      ...(typeof raw.before === 'number' ? { before: raw.before } : {}),
    },
  };
}

const MAX_HISTORY_HOURS = 365 * 24;

/** `GET /v1/nodes/:id/history?hours=N`: the bounded (1,440 point) history for 1 hour to 365 days. */
function mountHistory(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/nodes/:id/history',
    adminRoute(deps, async (c) => {
      const id = c.req.param('id') ?? '';
      const asked = wholeNumber(c.req.query('hours'), MAX_HISTORY_HOURS);
      if (asked === null)
        return controllerError(
          c,
          400,
          'invalid_request',
          `hours must be between 1 and ${MAX_HISTORY_HOURS}`
        );
      const hours = asked ?? 24;
      const node = NODE_ID_PATTERN.test(id)
        ? await deps.store.findNode(id)
        : null;
      if (node === null)
        return controllerError(c, 404, 'not_found', 'No such node.');
      const since = new Date(deps.now().getTime() - hours * 3600_000);
      return c.json({
        windowHours: hours,
        heartbeats: await deps.store.listHeartbeats(id, since),
      });
    })
  );
}

export function mountAdminIncidents(app: Hono, deps: AppDeps): void {
  mountHistory(app, deps);
  app.get(
    '/v1/incidents',
    adminRoute(
      deps,
      async (c) => {
        const parsed = parseIncidentQuery(c);
        if (!parsed.ok)
          return controllerError(c, 400, 'invalid_request', parsed.message);
        return c.json(await incidentReply(deps, parsed.filter));
      },
      { access: 'read' }
    )
  );
  app.get(
    '/v1/nodes/:id/restarts',
    adminRoute(
      deps,
      async (c) => {
        const id = c.req.param('id') ?? '';
        const node = NODE_ID_PATTERN.test(id)
          ? await deps.store.findNode(id)
          : null;
        if (node === null)
          return controllerError(c, 404, 'not_found', 'No such node.');
        const { events } = await loadEvents(deps.store, {
          kinds: RESTART_EVENT_KINDS,
          nodeId: id,
        });
        const facts = readFacts(node);
        return c.json(
          restartHistory(
            events,
            { bootId: facts.bootId, uptimeSeconds: facts.uptimeSeconds },
            deps.now()
          )
        );
      },
      { access: 'read' }
    )
  );
}
