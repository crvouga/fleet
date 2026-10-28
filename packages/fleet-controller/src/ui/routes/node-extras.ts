import type { Context } from 'hono';

import { mayWrite } from '../../auth/roles';
import type { AppDeps } from '../../deps';
import { annotateHistory } from '../../domain/desired-history';
import { roleOf } from '../../routes/guards';
import type { NodeDetailProps } from '../pages/node-detail';
import { nodeObservability } from './node-observability';

const DESIRED_HISTORY_SIZE = 20;

/** What the node page shows beyond the node itself: desired-document history, the credential and whether the viewer may act. */
export async function nodePageExtras(
  deps: AppDeps,
  c: Context,
  id: string
): Promise<
  Pick<
    NodeDetailProps,
    'desiredHistory' | 'credential' | 'readOnly' | 'restarts' | 'incidents'
  >
> {
  const [history, credential, role, observed] = await Promise.all([
    deps.store.desiredHistory(id, DESIRED_HISTORY_SIZE),
    deps.store.credentialStatus(id),
    roleOf(deps, c),
    nodeObservability(deps, id),
  ]);
  return {
    desiredHistory: annotateHistory(history),
    credential,
    readOnly: !mayWrite(role),
    ...observed,
  };
}
