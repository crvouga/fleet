import type { Hono } from 'hono';

import type { AppDeps } from '../../deps';
import { deriveIncidents } from '../../domain/incidents';
import { RUNNER_HEALTH_EVENT_KINDS } from '../../domain/runner-health';
import { loadEvents } from '../../routes/admin-incidents';
import { jobRows, runnersView } from '../../github/views';
import { RunnersBody, UnavailableBody } from '../pages/runners';
import { Shell, PageHeader } from '../layout';
import { takeFlash } from '../lib/flash';
import { loadFleet } from '../lib/fleet-data';
import { page } from './guard';

const JOBS_SHOWN = 50;

/** Open incidents of the runner health rules. */
async function openRunnerIncidents(deps: AppDeps) {
  const { events } = await loadEvents(deps.store, {
    kinds: RUNNER_HEALTH_EVENT_KINDS,
  });
  return deriveIncidents(events, deps.now()).filter((i) => i.open);
}

/**
 * `/runners`: the GitHub integration, runners and jobs. This is the page the
 * console script replaces with its interactive version; without script it is
 * this read-only rendering. Real data only: with no key it says so.
 */
export function registerRunners(app: Hono, deps: AppDeps): void {
  app.get(
    '/runners',
    page(deps, async (c, actor) => {
      const data = await loadFleet(deps);
      const { github } = deps;
      const body =
        github === undefined ? (
          <UnavailableBody />
        ) : (
          <RunnersBody
            view={await runnersView(github, deps)}
            jobs={jobRows(
              await github.store.listJobs({ limit: JOBS_SHOWN }),
              await deps.store.listNodes(),
              deps.now()
            )}
            incidents={await openRunnerIncidents(deps)}
            now={data.now}
          />
        );
      return c.html(
        <Shell
          title="Runners"
          path="/runners"
          actor={actor}
          pendingCount={data.pendingCount}
          flash={takeFlash(c)}
        >
          <PageHeader
            title="Runners"
            subtitle="GitHub Actions runners, queued and finished jobs, and capacity."
          />
          {body}
        </Shell>
      );
    })
  );
}
