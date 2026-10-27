import {
  configRevision,
  nodePayload,
  type FleetConfig,
} from '../config/schema';
import { effectiveConfig, scopesFor } from '../domain/effective-config';
import { DEFAULT_HEARTBEAT_SECONDS } from '../domain/status';
import type { Store } from '../store';
import type { NodeRow, Role, SettingsRow } from '../types';

export interface ConfigEnvelope {
  readonly revision: string;
  readonly values: Omit<FleetConfig, 'alerts'>;
}

/** The fleet, role and node documents merged for one node. */
export async function loadConfig(
  store: Store,
  node: { id: string; role: Role }
): Promise<FleetConfig> {
  const found = await Promise.all(
    scopesFor(node).map((scope) => store.getSettings(scope))
  );
  const rows = found.filter((row): row is SettingsRow => row !== null);
  return effectiveConfig(rows, node);
}

export function intervalOf(config: FleetConfig): number {
  return config.heartbeat?.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
}

/**
 * What a node is told. A node still waiting for approval learns only how
 * often to report; nothing else about the fleet.
 */
export function envelopeFor(
  node: NodeRow,
  config: FleetConfig
): ConfigEnvelope {
  const values: Omit<FleetConfig, 'alerts'> =
    node.approval === 'approved'
      ? nodePayload(config)
      : { heartbeat: { intervalSeconds: intervalOf(config) } };
  return { revision: configRevision(values), values };
}
