import type { FleetConfig } from '../config/schema';
import { effectiveConfig, scopesFor } from '../domain/effective-config';
import type { Store } from '../store';
import type { NodeRow, SettingsRow } from '../types';

export {
  desiredFor,
  intervalOf,
  type DesiredState,
} from '../domain/desired-state';

/**
 * The fleet, role and node documents merged for one node. The role is the
 * ASSIGNED role; a node without one gets the fleet and node scopes only.
 */
export async function loadConfig(
  store: Store,
  node: Pick<NodeRow, 'id' | 'role'>
): Promise<FleetConfig> {
  const found = await Promise.all(
    scopesFor(node).map((scope) => store.getSettings(scope))
  );
  const rows = found.filter((row): row is SettingsRow => row !== null);
  return effectiveConfig(rows, node);
}
