import type { FleetConfig, Scope } from './config/schema';
import type {
  Approval,
  EnrolledVia,
  EventInput,
  EventRow,
  HeartbeatBody,
  HeartbeatPoint,
  NodeRow,
  Role,
  SettingsHistoryRow,
  SettingsRow,
} from './types';

export interface RegisterInput {
  readonly id: string;
  readonly role: Role;
  readonly hostname: string;
  /** sha256 of the node's own secret, hex. The secret is never stored. */
  readonly secretHash: string;
  /** approved when the node proved its role's shared key, else pending. */
  readonly approval: 'pending' | 'approved';
  readonly enrolledVia: EnrolledVia;
  readonly remoteAddr: string | null;
}

export interface NodePatch {
  readonly displayName?: string | null;
  readonly note?: string | null;
  readonly labels?: readonly string[];
}

export interface EventQuery {
  readonly nodeId?: string;
  readonly severity?: 'warn' | 'error';
  /** Only events with an id below this, for paging. */
  readonly beforeId?: number;
  readonly limit: number;
}

/**
 * Everything the API and dashboard need from the database. The Postgres
 * implementation (src/db) is the only one that runs SQL, and every statement
 * in it names the `fleet` schema. Nothing outside src/db imports a driver.
 */
export interface Store {
  /** Rejects when the database cannot be reached. */
  health(): Promise<void>;

  /** Insert or replace a node's secret; a returning node resets to the given approval. */
  registerNode(
    input: RegisterInput
  ): Promise<{ node: NodeRow; created: boolean }>;
  findNode(id: string): Promise<NodeRow | null>;
  /** The node when id and secret hash match and it is not rejected or retired. */
  authenticateNode(id: string, secretHash: string): Promise<NodeRow | null>;
  /**
   * The node when id and secret hash match, in any approval state. Lets the
   * API answer 403 (rejected, retired) only to a caller that holds the secret.
   * Optional so in-memory stores need not implement it; without it the API
   * answers 401 for every failed credential.
   */
  verifyNodeSecret?(id: string, secretHash: string): Promise<NodeRow | null>;
  listNodes(): Promise<readonly NodeRow[]>;
  /** Stores the report, a history point, and the events the node sent. */
  recordHeartbeat(
    id: string,
    body: HeartbeatBody,
    remoteAddr: string | null,
    now: Date
  ): Promise<NodeRow | null>;
  patchNode(
    id: string,
    patch: NodePatch,
    actor: string
  ): Promise<NodeRow | null>;
  setApproval(
    id: string,
    approval: Approval,
    actor: string
  ): Promise<NodeRow | null>;
  deleteNode(id: string, actor: string): Promise<boolean>;
  listHeartbeats(id: string, since: Date): Promise<readonly HeartbeatPoint[]>;

  addEvent(event: EventInput): Promise<void>;
  listEvents(query: EventQuery): Promise<readonly EventRow[]>;

  getSettings(scope: Scope): Promise<SettingsRow | null>;
  listSettings(): Promise<readonly SettingsRow[]>;
  /** Replaces the document, appends history, and records who did it. */
  putSettings(
    scope: Scope,
    value: FleetConfig,
    actor: string
  ): Promise<SettingsRow>;
  settingsHistory(
    scope: Scope,
    limit: number
  ): Promise<readonly SettingsHistoryRow[]>;

  /** Approved nodes silent for longer than the threshold that have not been announced. */
  nodesDueOfflineNotice(
    now: Date,
    offlineAfterSeconds: number
  ): Promise<readonly NodeRow[]>;
  setOfflineNotified(id: string, at: Date | null): Promise<void>;
  pruneHeartbeats(before: Date): Promise<number>;
}
