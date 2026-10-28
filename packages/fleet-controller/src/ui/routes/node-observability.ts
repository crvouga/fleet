import type { AppDeps } from '../../deps';
import { deriveIncidents, INCIDENT_EVENT_KINDS } from '../../domain/incidents';
import {
  restartHistory,
  RESTART_EVENT_KINDS,
} from '../../domain/restart-history';
import { loadEvents } from '../../routes/admin-incidents';
import { readFacts } from '../lib/facts';
import type { NodeDetailProps } from '../pages/node-detail';

const INCIDENTS_SHOWN = 10;

/** A node's restart history and incidents, derived from its events for the node page. */
export async function nodeObservability(
  deps: AppDeps,
  id: string
): Promise<Pick<NodeDetailProps, 'restarts' | 'incidents'>> {
  const [node, restarts, incidents] = await Promise.all([
    deps.store.findNode(id),
    loadEvents(deps.store, { kinds: RESTART_EVENT_KINDS, nodeId: id }),
    loadEvents(deps.store, { kinds: INCIDENT_EVENT_KINDS, nodeId: id }),
  ]);
  const now = deps.now();
  const facts = node === null ? null : readFacts(node);
  return {
    restarts: restartHistory(
      restarts.events,
      {
        bootId: facts?.bootId ?? null,
        uptimeSeconds: facts?.uptimeSeconds ?? null,
      },
      now
    ),
    incidents: deriveIncidents(incidents.events, now).slice(0, INCIDENTS_SHOWN),
  };
}
