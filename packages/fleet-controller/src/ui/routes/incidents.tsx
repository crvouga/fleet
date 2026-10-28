import type { Hono } from 'hono';

import {
  parseIncidentQuery,
  incidentReply,
} from '../../routes/admin-incidents';
import type { AppDeps } from '../../deps';
import { IncidentsBody } from '../pages/incidents';
import { Shell, PageHeader } from '../layout';
import { takeFlash } from '../lib/flash';
import { loadFleet } from '../lib/fleet-data';
import { page } from './guard';

/** `/incidents`: open and resolved problems across the fleet, readable by viewers. */
export function registerIncidents(app: Hono, deps: AppDeps): void {
  app.get(
    '/incidents',
    page(deps, async (c, actor) => {
      const parsed = parseIncidentQuery(c);
      const filter = parsed.ok ? parsed.filter : { limit: 50 };
      const [data, reply] = await Promise.all([
        loadFleet(deps),
        incidentReply(deps, filter),
      ]);
      return c.html(
        <Shell
          title="Incidents"
          path="/incidents"
          actor={actor}
          pendingCount={data.pendingCount}
          flash={takeFlash(c)}
        >
          <PageHeader
            title="Incidents"
            subtitle="Problems from when a node reported them until it reported them resolved."
          />
          <IncidentsBody
            incidents={reply.incidents}
            openOnly={filter.open === true}
            openCount={reply.summary.open}
            nextBefore={reply.nextBefore}
            truncated={reply.truncated}
            now={data.now}
          />
        </Shell>
      );
    })
  );
}
