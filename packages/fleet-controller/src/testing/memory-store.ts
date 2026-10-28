import type { FleetConfig, Scope } from '../config/schema';
import {
  acceptNext,
  matchSecret,
  promote,
  registered,
  requestRotation,
  revoke,
  statusOf,
  type CredentialRecord,
  type CredentialResult,
  type CredentialStatus,
} from '../domain/credential-rotation';
import {
  DESIRED_HISTORY_KEEP,
  desiredChangeCause,
  type DesiredHistoryRow,
  type DesiredSnapshot,
} from '../domain/desired-history';
import { SettingsConflictError } from '../domain/settings-conflict';
import { storedEvent, unseen } from '../domain/event-keys';
import { MemoryOperations } from './memory-operations';
import { MemoryGrants } from '../enrollment/memory-grants';
import { boundedHistory, compactTelemetry } from '../domain/heartbeat-history';
import { diskPercent, readFacts } from '../ui/lib/facts';
import type {
  AuditQuery,
  EventQuery,
  NodePatch,
  RegisterInput,
  Store,
} from '../store';
import type {
  Approval,
  AuditInput,
  AuditRow,
  EventInput,
  EventRow,
  HeartbeatBody,
  HeartbeatPoint,
  NodeRow,
  Role,
  SettingsHistoryRow,
  SettingsRow,
} from '../types';

interface Stored {
  row: NodeRow;
  secretHash: string;
  points: HeartbeatPoint[];
  /** Credential lifecycle beyond the current hash (rotation, revocation). */
  nextHash?: string | null;
  rotateRequestedAt?: Date | null;
  rotatedAt?: Date | null;
  revokedAt?: Date | null;
}

function credentialOf(stored: Stored): CredentialRecord {
  return {
    currentHash: stored.secretHash,
    nextHash: stored.nextHash ?? null,
    rotateRequestedAt: stored.rotateRequestedAt ?? null,
    rotatedAt: stored.rotatedAt ?? null,
    revokedAt: stored.revokedAt ?? null,
  };
}

function applyCredential(stored: Stored, record: CredentialRecord): void {
  stored.secretHash = record.currentHash;
  stored.nextHash = record.nextHash;
  stored.rotateRequestedAt = record.rotateRequestedAt;
  stored.rotatedAt = record.rotatedAt;
  stored.revokedAt = record.revokedAt;
}

/** A faithful, simple in-memory Store for tests and the design demo. */
export class MemoryStore implements Store {
  readonly operations = new MemoryOperations();
  readonly grants = new MemoryGrants();
  private readonly nodes = new Map<string, Stored>();
  private readonly events: EventRow[] = [];
  private readonly settings = new Map<string, SettingsRow>();
  private readonly history: SettingsHistoryRow[] = [];
  private readonly auditRows: AuditRow[] = [];
  private readonly desired = new Map<string, DesiredHistoryRow[]>();
  private nextDesiredId = 1;
  private nextAuditId = 1;
  private nextEventId = 1;
  private nextHistoryId = 1;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async health(): Promise<void> {}

  async registerNode(
    input: RegisterInput
  ): Promise<{ node: NodeRow; created: boolean }> {
    const wasRevoked = this.nodes.get(input.id)?.revokedAt instanceof Date;
    // A revoked node never returns approved by itself; a person decides.
    const result = await this.register(wasRevoked ? demoted(input) : input);
    if (wasRevoked) await this.noteReregistered(result.node);
    return result;
  }

  private async noteReregistered(node: NodeRow): Promise<void> {
    this.record(
      node,
      'credential_reregistered',
      'info',
      'A node with a revoked credential registered again. It waits for a person to approve it.'
    );
    await this.audit({
      actor: `node:${node.id.slice(0, 4)}`,
      action: 'credential.reregistered',
      targetKind: 'node',
      targetId: node.id,
      detail: { forcedApproval: 'pending' },
    });
  }

  private async register(
    input: RegisterInput
  ): Promise<{ node: NodeRow; created: boolean }> {
    const existing = this.nodes.get(input.id);
    const now = this.clock();
    if (existing === undefined) {
      const row = blankRow(input, now);
      this.nodes.set(input.id, {
        row,
        secretHash: input.secretHash,
        points: [],
      });
      this.record(
        row,
        'registered',
        'info',
        `${row.hostname} registered as ${input.approval}`
      );
      if (row.role !== null) this.recordRole(row, null, 'enrollment-token');
      return { node: row, created: true };
    }
    // A rejected node stays rejected; anything else takes the approval it earned.
    const approval: Approval =
      existing.row.approval === 'rejected' ? 'rejected' : input.approval;
    const approvedNow =
      approval === 'approved' && existing.row.approval !== 'approved';
    applyCredential(
      existing,
      registered(credentialOf(existing), input.secretHash)
    );
    const previousRole = existing.row.role;
    existing.row = {
      ...existing.row,
      // Registration never clears an assigned role; a token only fills an empty one.
      role: previousRole ?? (approval === 'rejected' ? null : input.tokenRole),
      hostname: input.hostname,
      approval,
      enrolledVia: input.enrolledVia,
      remoteAddr: input.remoteAddr,
      approvedAt: approvedNow ? now : existing.row.approvedAt,
      retiredAt: null,
    };
    if (previousRole === null && existing.row.role !== null)
      this.recordRole(existing.row, null, 'enrollment-token');
    return { node: existing.row, created: false };
  }

  async findNode(id: string): Promise<NodeRow | null> {
    return this.nodes.get(id)?.row ?? null;
  }

  async authenticateNode(
    id: string,
    secretHash: string
  ): Promise<NodeRow | null> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return null;
    const match = matchSecret(credentialOf(stored), secretHash, this.clock());
    if (match === 'none') return null;
    if (match === 'next') this.promoteNext(stored);
    const { approval } = stored.row;
    return approval === 'rejected' || approval === 'retired'
      ? null
      : stored.row;
  }

  private promoteNext(stored: Stored): void {
    applyCredential(stored, promote(credentialOf(stored), this.clock()));
    this.record(
      stored.row,
      'credential_rotated',
      'info',
      'Node credential rotated: the node now uses its new secret.'
    );
  }

  async credentialStatus(id: string): Promise<CredentialStatus | null> {
    const stored = this.nodes.get(id);
    return stored === undefined
      ? null
      : statusOf(credentialOf(stored), this.clock());
  }

  async requestCredentialRotation(
    id: string
  ): Promise<CredentialResult<'revoked'>> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return { ok: false, reason: 'unknown_node' };
    const now = this.clock();
    const outcome = requestRotation(credentialOf(stored), now);
    if (!outcome.ok) return outcome;
    applyCredential(stored, outcome.record);
    return {
      ok: true,
      changed: outcome.changed,
      status: statusOf(outcome.record, now),
    };
  }

  async submitNextCredential(
    id: string,
    nextHash: string
  ): Promise<CredentialResult<'revoked' | 'not_requested' | 'same_secret'>> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return { ok: false, reason: 'unknown_node' };
    const now = this.clock();
    const outcome = acceptNext(credentialOf(stored), nextHash, now);
    if (!outcome.ok) return outcome;
    applyCredential(stored, outcome.record);
    return {
      ok: true,
      changed: outcome.changed,
      status: statusOf(outcome.record, now),
    };
  }

  async revokeCredential(id: string): Promise<CredentialResult> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return { ok: false, reason: 'unknown_node' };
    const now = this.clock();
    const record = credentialOf(stored);
    if (record.revokedAt !== null)
      return { ok: true, changed: false, status: statusOf(record, now) };
    const revoked = revoke(
      record,
      now,
      `memory-${this.nextAuditId}-${now.getTime()}`
    );
    applyCredential(stored, revoked);
    return { ok: true, changed: true, status: statusOf(revoked, now) };
  }

  async recordDesired(
    nodeId: string,
    desired: DesiredSnapshot,
    cause?: string
  ): Promise<boolean> {
    if (!this.nodes.has(nodeId)) return false;
    const rows = this.desired.get(nodeId) ?? [];
    const last = rows.at(-1);
    if (last?.revision === desired.revision) return false;
    rows.push({
      id: this.nextDesiredId++,
      nodeId,
      revision: desired.revision,
      desired,
      at: this.clock(),
      cause: cause ?? desiredChangeCause(last?.desired ?? null, desired),
    });
    this.desired.set(nodeId, rows.slice(-DESIRED_HISTORY_KEEP));
    return true;
  }

  async desiredHistory(
    nodeId: string,
    limit: number
  ): Promise<readonly DesiredHistoryRow[]> {
    return [...(this.desired.get(nodeId) ?? [])].reverse().slice(0, limit);
  }

  async listNodes(): Promise<readonly NodeRow[]> {
    return [...this.nodes.values()]
      .map((stored) => stored.row)
      .sort(
        (a, b) =>
          (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0)
      );
  }

  async recordHeartbeat(
    id: string,
    body: HeartbeatBody,
    remoteAddr: string | null,
    now: Date
  ): Promise<NodeRow | null> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return null;
    // Observed state only: a report never changes the assigned role.
    stored.row = {
      ...stored.row,
      observedRole: body.role,
      observedClosure: body.closure,
      ageRecipient: body.ageRecipient ?? null,
      hardware: body.hardware ?? null,
      reconcile: body.reconcile ?? null,
      hostname: body.hostname,
      facts: body as unknown as Record<string, unknown>,
      revision: body.revision,
      agentVersion: body.agent.version,
      appliedRevision: body.agent.desiredRevision,
      remoteAddr,
      lastSeenAt: now,
    };
    const facts = readFacts(stored.row);
    stored.points.push({
      at: now,
      uptimeSeconds: facts.uptimeSeconds,
      load1: facts.load1,
      memUsedPercent: facts.memUsedPercent,
      diskPercent: diskPercent(facts),
      slots: facts.slots,
      busySlots: facts.busySlots,
      ...(body.telemetry
        ? { telemetry: compactTelemetry(body.telemetry) }
        : {}),
    });
    const seen = new Set(
      this.events
        .filter((event) => event.nodeId === id)
        .map((event) => event.data['key'])
        .filter((key): key is string => typeof key === 'string')
    );
    for (const event of unseen(body.events.map(storedEvent), seen)) {
      this.pushEvent(
        {
          ...event,
          nodeId: id,
          nodeLabel: stored.row.displayName ?? body.hostname,
        },
        now
      );
    }
    return stored.row;
  }

  async patchNode(
    id: string,
    patch: NodePatch,
    actor: string
  ): Promise<NodeRow | null> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return null;
    stored.row = {
      ...stored.row,
      displayName:
        patch.displayName === undefined
          ? stored.row.displayName
          : patch.displayName,
      note: patch.note === undefined ? stored.row.note : patch.note,
      labels:
        patch.labels === undefined ? stored.row.labels : [...patch.labels],
    };
    this.record(
      stored.row,
      'edited',
      'info',
      `${actor} edited ${stored.row.hostname}`
    );
    return stored.row;
  }

  async setApproval(
    id: string,
    approval: Approval,
    actor: string
  ): Promise<NodeRow | null> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return null;
    const now = this.clock();
    stored.row = {
      ...stored.row,
      approval,
      approvedAt: approval === 'approved' ? now : stored.row.approvedAt,
      approvedBy: approval === 'approved' ? actor : stored.row.approvedBy,
      retiredAt: approval === 'retired' ? now : stored.row.retiredAt,
    };
    this.record(
      stored.row,
      approval,
      'info',
      `${actor} marked ${stored.row.hostname} ${approval}`
    );
    return stored.row;
  }

  async assignRole(
    id: string,
    role: Role | null,
    actor: string
  ): Promise<NodeRow | null> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return null;
    const previous = stored.row.role;
    if (previous === role) return stored.row;
    stored.row = { ...stored.row, role };
    this.recordRole(stored.row, previous, actor);
    return stored.row;
  }

  async deleteNode(id: string, actor: string): Promise<boolean> {
    const stored = this.nodes.get(id);
    if (stored === undefined) return false;
    this.record(
      stored.row,
      'deleted',
      'info',
      `${actor} deleted ${stored.row.hostname}`
    );
    this.nodes.delete(id);
    this.desired.delete(id);
    // Events keep the node's label but no longer point at a node.
    for (let index = 0; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (event !== undefined && event.nodeId === id)
        this.events[index] = { ...event, nodeId: null };
    }
    return true;
  }

  async listHeartbeats(
    id: string,
    since: Date
  ): Promise<readonly HeartbeatPoint[]> {
    const points = this.nodes.get(id)?.points ?? [];
    return boundedHistory(
      points.filter((point) => point.at >= since),
      since
    );
  }

  async audit(entry: AuditInput): Promise<void> {
    this.auditRows.push({
      id: this.nextAuditId++,
      at: this.clock(),
      actor: entry.actor,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      targetKind: entry.targetKind,
      targetId: entry.targetId ?? null,
      outcome: entry.outcome ?? 'success',
      requestId: entry.requestId ?? null,
      detail: entry.detail ?? {},
    });
  }

  async listAudit(query: AuditQuery): Promise<readonly AuditRow[]> {
    return this.auditRows
      .filter((row) => !query.targetKind || row.targetKind === query.targetKind)
      .filter((row) => !query.targetId || row.targetId === query.targetId)
      .filter((row) => !query.actor || row.actor === query.actor)
      .filter((row) => query.beforeId === undefined || row.id < query.beforeId)
      .sort((a, b) => b.id - a.id)
      .slice(0, query.limit);
  }

  async addEvent(event: EventInput): Promise<void> {
    this.pushEvent(event, this.clock());
  }

  async listEvents(query: EventQuery): Promise<readonly EventRow[]> {
    return this.events
      .filter(
        (event) => query.nodeId === undefined || event.nodeId === query.nodeId
      )
      .filter(
        (event) =>
          query.severity === undefined || event.severity === query.severity
      )
      .filter(
        (event) => query.beforeId === undefined || event.id < query.beforeId
      )
      .filter(
        (event) => query.kinds === undefined || query.kinds.includes(event.kind)
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, query.limit);
  }

  async getSettings(scope: Scope): Promise<SettingsRow | null> {
    return this.settings.get(scope) ?? null;
  }

  async listSettings(): Promise<readonly SettingsRow[]> {
    return [...this.settings.values()];
  }

  async putSettings(
    scope: Scope,
    value: FleetConfig,
    actor: string,
    expectedRevision?: number
  ): Promise<SettingsRow> {
    const now = this.clock();
    const previous = this.settings.get(scope)?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== previous)
      throw new SettingsConflictError(previous, expectedRevision);
    const doc = { ...value } as Readonly<Record<string, unknown>>;
    const row: SettingsRow = {
      scope,
      value: doc,
      updatedAt: now,
      updatedBy: actor,
      revision: previous + 1,
    };
    this.settings.set(scope, row);
    this.history.push({
      id: this.nextHistoryId,
      scope,
      value: doc,
      changedAt: now,
      changedBy: actor,
    });
    this.nextHistoryId += 1;
    return row;
  }

  async settingsHistory(
    scope: Scope,
    limit: number
  ): Promise<readonly SettingsHistoryRow[]> {
    return this.history
      .filter((entry) => entry.scope === scope)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  async nodesDueOfflineNotice(
    now: Date,
    offlineAfterSeconds: number
  ): Promise<readonly NodeRow[]> {
    return [...this.nodes.values()]
      .map((stored) => stored.row)
      .filter(
        (row) =>
          row.approval === 'approved' &&
          row.offlineNotifiedAt === null &&
          row.lastSeenAt !== null &&
          (now.getTime() - row.lastSeenAt.getTime()) / 1000 >
            offlineAfterSeconds
      );
  }

  async claimOfflineNotice(id: string, at: Date): Promise<boolean> {
    const stored = this.nodes.get(id);
    if (stored === undefined || stored.row.offlineNotifiedAt !== null)
      return false;
    stored.row = { ...stored.row, offlineNotifiedAt: at };
    return true;
  }

  async setOfflineNotified(id: string, at: Date | null): Promise<void> {
    const stored = this.nodes.get(id);
    if (stored !== undefined)
      stored.row = { ...stored.row, offlineNotifiedAt: at };
  }

  async pruneHeartbeats(before: Date): Promise<number> {
    let removed = 0;
    for (const stored of this.nodes.values()) {
      const kept = stored.points.filter((point) => point.at >= before);
      removed += stored.points.length - kept.length;
      stored.points = kept;
    }
    return removed;
  }

  /** Test and demo seeding: store a node row exactly as given. */
  seedNode(
    row: NodeRow,
    points: readonly HeartbeatPoint[] = [],
    secretHash = ''
  ): void {
    this.nodes.set(row.id, { row, secretHash, points: [...points] });
  }

  /** Test and demo seeding: change fields of a seeded row, keeping its history. */
  updateSeeded(id: string, change: Partial<NodeRow>): void {
    const stored = this.nodes.get(id);
    if (stored !== undefined) stored.row = { ...stored.row, ...change };
  }

  /** Test and demo seeding: store an event with an explicit time. */
  seedEvent(event: EventInput, at: Date): void {
    this.pushEvent(event, at);
  }

  private record(
    row: NodeRow,
    kind: string,
    severity: 'info',
    message: string
  ): void {
    this.pushEvent(
      {
        nodeId: row.id,
        nodeLabel: row.displayName ?? row.hostname,
        kind,
        severity,
        message,
      },
      this.clock()
    );
  }

  private recordRole(row: NodeRow, previous: Role | null, actor: string) {
    this.pushEvent(
      {
        nodeId: row.id,
        nodeLabel: row.displayName ?? row.hostname,
        kind: 'role_assigned',
        severity: 'info',
        message:
          row.role === null
            ? `${actor} unassigned the ${previous ?? 'previous'} role`
            : `${actor} assigned the ${row.role} role`,
        data: { role: row.role, previous, actor },
      },
      this.clock()
    );
  }

  private pushEvent(event: EventInput, at: Date): void {
    this.events.push({
      id: this.nextEventId,
      at,
      nodeId: event.nodeId,
      nodeLabel: event.nodeLabel,
      kind: event.kind,
      severity: event.severity,
      message: event.message,
      data: event.data ?? {},
    });
    this.nextEventId += 1;
  }
}

/** What a revoked node's registration is treated as: pending, no token role. */
function demoted(input: RegisterInput): RegisterInput {
  return {
    ...input,
    approval: 'pending',
    tokenRole: null,
    enrolledVia: 'hello',
  };
}

function blankRow(input: RegisterInput, now: Date): NodeRow {
  return {
    id: input.id,
    role: input.tokenRole,
    observedRole: null,
    observedClosure: null,
    ageRecipient: null,
    hardware: null,
    reconcile: null,
    hostname: input.hostname,
    approval: input.approval,
    displayName: null,
    note: null,
    labels: [],
    facts: {},
    revision: null,
    agentVersion: null,
    appliedRevision: null,
    heartbeatIntervalSeconds: 60,
    remoteAddr: input.remoteAddr,
    enrolledVia: input.enrolledVia,
    firstSeenAt: now,
    lastSeenAt: null,
    approvedAt: input.approval === 'approved' ? now : null,
    approvedBy: null,
    retiredAt: null,
    offlineNotifiedAt: null,
  };
}
