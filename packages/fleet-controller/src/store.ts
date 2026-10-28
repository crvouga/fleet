import type { FleetConfig, Scope } from './config/schema';
import type { OperationsStore } from './domain/operations-store';
import type { GrantStore } from './enrollment/store';
import type {
  CredentialResult,
  CredentialStatus,
} from './domain/credential-rotation';
import type {
  DesiredHistoryRow,
  DesiredSnapshot,
} from './domain/desired-history';
import type {
  Approval,
  AuditInput,
  AuditRow,
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
  readonly hostname: string;
  /** sha256 of the node's own secret, hex. The secret is never stored. */
  readonly secretHash: string;
  /** approved when the node presented a valid enrollment token, else pending. */
  readonly approval: 'pending' | 'approved';
  /**
   * The role named by the enrollment token. Assigned only when the node has
   * no assigned role; registration never clears or replaces one.
   */
  readonly tokenRole: Role | null;
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
  /** Only events of these kinds (at most 64), e.g. for incident and restart history. */
  readonly kinds?: readonly string[];
  readonly limit: number;
}

export interface AuditQuery {
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly actor?: string;
  /** Only entries with an id below this, for paging. */
  readonly beforeId?: number;
  readonly limit: number;
}

/** Storage contract shared by the SQLite controller and explicit in-memory fixtures. */
export interface Store {
  /** Operations (drain, restart, replace, decommission) and per-node lifecycle intent. */
  readonly operations: OperationsStore;
  /** Single-use enrollment grants and the installer-binding secret (src/enrollment). */
  readonly grants: GrantStore;

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
   * controller answer 403 (rejected, retired) only to a caller that holds the secret.
   * Optional so in-memory stores need not implement it; without it the controller
   * answers 401 for every failed credential.
   */
  verifyNodeSecret?(id: string, secretHash: string): Promise<NodeRow | null>;
  listNodes(): Promise<readonly NodeRow[]>;

  /** Credential lifecycle. Never exposes a hash. See docs/access-and-config-safety.md. */
  credentialStatus(id: string): Promise<CredentialStatus | null>;
  /** Idempotent: an admin asks the node to rotate its secret on its next heartbeat. */
  requestCredentialRotation(id: string): Promise<CredentialResult<'revoked'>>;
  /** The node, authenticated, offers the sha256 of its next secret. */
  submitNextCredential(
    id: string,
    nextHash: string
  ): Promise<CredentialResult<'revoked' | 'not_requested' | 'same_secret'>>;
  /** Replaces the secret hash with an unusable value; the node gets 401 at once. */
  revokeCredential(id: string): Promise<CredentialResult>;

  /**
   * Appends the desired document to the node's history unless its revision is
   * already the latest one. True when a row was written. Bounded per node.
   */
  recordDesired(
    nodeId: string,
    desired: DesiredSnapshot,
    cause?: string
  ): Promise<boolean>;
  desiredHistory(
    nodeId: string,
    limit: number
  ): Promise<readonly DesiredHistoryRow[]>;
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
  /** Assign (or with null, unassign) the role; records `role_assigned` when it changes. */
  assignRole(
    id: string,
    role: Role | null,
    actor: string
  ): Promise<NodeRow | null>;
  deleteNode(id: string, actor: string): Promise<boolean>;
  listHeartbeats(id: string, since: Date): Promise<readonly HeartbeatPoint[]>;

  addEvent(event: EventInput): Promise<void>;
  listEvents(query: EventQuery): Promise<readonly EventRow[]>;

  /** Append-only audit trail of security- and operations-relevant actions. */
  audit(entry: AuditInput): Promise<void>;
  listAudit(query: AuditQuery): Promise<readonly AuditRow[]>;

  getSettings(scope: Scope): Promise<SettingsRow | null>;
  listSettings(): Promise<readonly SettingsRow[]>;
  /**
   * Replaces the document, appends history, and records who did it. With
   * `expectedRevision` the write happens only if the stored revision still
   * equals it (0 for a scope never written); otherwise it throws
   * SettingsConflictError carrying the current revision.
   */
  putSettings(
    scope: Scope,
    value: FleetConfig,
    actor: string,
    expectedRevision?: number
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
  /**
   * Atomically marks the outage as announced. True only for the caller that
   * changed the mark from unset, so overlapping sweeps announce an outage once.
   */
  claimOfflineNotice(id: string, at: Date): Promise<boolean>;
  pruneHeartbeats(before: Date): Promise<number>;
}
