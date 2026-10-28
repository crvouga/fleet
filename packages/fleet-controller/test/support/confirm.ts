import type { Harness, Reply } from './controller';
import { nodeIdOf } from './fixtures';

/**
 * An admin call to a destructive route (reject, retire, delete, restart,
 * replace, decommission) that types the node's name, as the API now requires.
 */
export async function adminConfirmed(
  h: Harness,
  method: string,
  path: string,
  node: number | string
): Promise<Reply> {
  const id = typeof node === 'number' ? nodeIdOf(node) : node;
  const row = await h.deps.store.findNode(id);
  const confirm = row === null ? 'unknown' : (row.displayName ?? row.hostname);
  return h.admin(method, path, { confirm });
}
