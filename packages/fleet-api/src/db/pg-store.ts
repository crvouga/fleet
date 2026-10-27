import type { FleetConfig, Scope } from '../config/schema';
import type { NodePatch, RegisterInput, Store, EventQuery } from '../store';
import type {
  Approval,
  EventInput,
  EventRow,
  HeartbeatBody,
  HeartbeatPoint,
  NodeRow,
  SettingsHistoryRow,
  SettingsRow,
} from '../types';

import type { Db } from './client';
import { insertEvent, selectEvents } from './event-queries';
import { deleteOlder, selectPoints, storeHeartbeat } from './heartbeat-queries';
import {
  deleteRow,
  selectDue,
  selectNode,
  selectNodes,
  selectNodeWithSecret,
  updateApproval,
  updateNotified,
  updatePatch,
} from './node-queries';
import { registerWithEvents } from './register-queries';
import { text, toNodeRow } from './rows';
import {
  deleteScope,
  selectAllSettings,
  selectHistory,
  selectSettings,
  upsertSettings,
} from './settings-queries';

const labelOf = (node: NodeRow): string => node.displayName ?? node.hostname;

/**
 * The only implementation of Store that runs SQL. Every statement names its
 * tables as `fleet.<table>`, nothing here creates or alters anything, and no
 * query depends on the connection's search_path.
 */
export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  async health(): Promise<void> {
    // Readiness includes the additive schema required by heartbeat ingestion.
    // An old schema must refuse traffic instead of passing select 1 then losing reports.
    await this.db`select telemetry from fleet.heartbeats limit 0`;
  }

  registerNode(
    input: RegisterInput
  ): Promise<{ node: NodeRow; created: boolean }> {
    return this.db.begin((tx) => registerWithEvents(tx, input));
  }

  async findNode(id: string): Promise<NodeRow | null> {
    const row = await selectNode(this.db, id, false);
    return row === null ? null : toNodeRow(row);
  }

  async authenticateNode(
    id: string,
    secretHash: string
  ): Promise<NodeRow | null> {
    const node = await this.verifyNodeSecret(id, secretHash);
    return node !== null &&
      (node.approval === 'approved' || node.approval === 'pending')
      ? node
      : null;
  }

  async verifyNodeSecret(
    id: string,
    secretHash: string
  ): Promise<NodeRow | null> {
    const row = await selectNodeWithSecret(this.db, id, secretHash);
    return row === null ? null : toNodeRow(row);
  }

  async listNodes(): Promise<readonly NodeRow[]> {
    return (await selectNodes(this.db)).map(toNodeRow);
  }

  async recordHeartbeat(
    id: string,
    body: HeartbeatBody,
    remoteAddr: string | null,
    now: Date
  ): Promise<NodeRow | null> {
    if (body.nodeId !== id) {
      throw new Error('heartbeat body does not match node id');
    }
    return this.db.begin((tx) => storeHeartbeat(tx, body, remoteAddr, now));
  }

  patchNode(
    id: string,
    patch: NodePatch,
    actor: string
  ): Promise<NodeRow | null> {
    return this.db.begin(async (tx) => {
      const row = await updatePatch(tx, id, patch);
      if (row === null) return null;
      const node = toNodeRow(row);
      const changed = Object.keys(patch).filter(
        (key) => patch[key as keyof NodePatch] !== undefined
      );
      await insertEvent(
        tx,
        {
          nodeId: id,
          nodeLabel: labelOf(node),
          kind: 'node_updated',
          severity: 'info',
          message: `${actor} changed ${changed.join(', ')}`,
        },
        null
      );
      return node;
    });
  }

  setApproval(
    id: string,
    approval: Approval,
    actor: string
  ): Promise<NodeRow | null> {
    return this.db.begin(async (tx) => {
      const before = await selectNode(tx, id, true);
      if (before === null) return null;
      if (text(before, 'approval') === approval) return toNodeRow(before);
      const row = await updateApproval(tx, id, approval, actor);
      if (row === null) return null;
      const node = toNodeRow(row);
      await insertEvent(
        tx,
        {
          nodeId: id,
          nodeLabel: labelOf(node),
          kind: approval,
          severity: approval === 'rejected' ? 'warn' : 'info',
          message: `${labelOf(node)} ${approval} by ${actor}`,
        },
        null
      );
      return node;
    });
  }

  deleteNode(id: string, actor: string): Promise<boolean> {
    return this.db.begin(async (tx) => {
      const row = await deleteRow(tx, id);
      if (row === null) return false;
      const node = toNodeRow(row);
      await deleteScope(tx, `node:${id}` as Scope);
      await insertEvent(
        tx,
        {
          nodeId: null,
          nodeLabel: labelOf(node),
          kind: 'node_deleted',
          severity: 'warn',
          message: `${labelOf(node)} deleted by ${actor}`,
          data: { id },
        },
        null
      );
      return true;
    });
  }

  listHeartbeats(id: string, since: Date): Promise<readonly HeartbeatPoint[]> {
    return selectPoints(this.db, id, since);
  }

  addEvent(event: EventInput): Promise<void> {
    return insertEvent(this.db, event, null);
  }

  listEvents(query: EventQuery): Promise<readonly EventRow[]> {
    return selectEvents(this.db, query);
  }

  getSettings(scope: Scope): Promise<SettingsRow | null> {
    return selectSettings(this.db, scope);
  }

  listSettings(): Promise<readonly SettingsRow[]> {
    return selectAllSettings(this.db);
  }

  putSettings(
    scope: Scope,
    value: FleetConfig,
    actor: string
  ): Promise<SettingsRow> {
    return this.db.begin((tx) => upsertSettings(tx, scope, value, actor));
  }

  settingsHistory(
    scope: Scope,
    limit: number
  ): Promise<readonly SettingsHistoryRow[]> {
    return selectHistory(this.db, scope, limit);
  }

  async nodesDueOfflineNotice(
    now: Date,
    offlineAfterSeconds: number
  ): Promise<readonly NodeRow[]> {
    return (await selectDue(this.db, now, offlineAfterSeconds)).map(toNodeRow);
  }

  setOfflineNotified(id: string, at: Date | null): Promise<void> {
    return updateNotified(this.db, id, at);
  }

  pruneHeartbeats(before: Date): Promise<number> {
    return deleteOlder(this.db, before);
  }
}
