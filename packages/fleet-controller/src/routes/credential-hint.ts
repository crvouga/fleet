import type { AppDeps } from '../deps';
import type { DesiredSnapshot } from '../domain/desired-history';

/**
 * `{ credential: { rotate: true } }` while an admin asked this node to rotate
 * its secret, else nothing. Additive to the heartbeat answer and deliberately
 * not part of the desired document: it never changes the desired revision.
 */
export async function credentialHint(
  deps: AppDeps,
  nodeId: string
): Promise<{ credential?: { rotate: true } }> {
  try {
    const status = await deps.store.credentialStatus(nodeId);
    return status?.rotateRequestedAt && status.revokedAt === null
      ? { credential: { rotate: true } }
      : {};
  } catch {
    return {};
  }
}

/** Records the document the node is being told about, once per revision. */
export async function recordDesiredBestEffort(
  deps: AppDeps,
  nodeId: string,
  desired: DesiredSnapshot
): Promise<void> {
  try {
    await deps.store.recordDesired(nodeId, desired);
  } catch {
    // History is diagnostic; the heartbeat must still succeed.
  }
}
