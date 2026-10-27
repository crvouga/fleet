import type { FleetConfig, Scope } from '../config/schema';
import { storedEvent, unseen } from '../domain/event-keys';
import { boundedHistory, compactTelemetry } from '../domain/heartbeat-history';
import { diskPercent, readFacts } from '../ui/lib/facts';
import type { EventQuery, NodePatch, RegisterInput, Store } from '../store';
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

interface Stored {
  row: NodeRow;
  secretHash: string;
  points: HeartbeatPoint[];
}

/** A faithful, simple in-memory Store for tests and the design demo. */
export class MemoryStore implements Store {
  private readonly nodes = new Map<string, Stored>();
  private readonly events: EventRow[] = [];
  private readonly settings = new Map<string, SettingsRow>();
  private readonly history: SettingsHistoryRow[] = [];
  private nextEventId = 1;
  private nextHistoryId = 1;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async health(): Promise<void> {}

  async registerNode(
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
      return { node: row, created: true };
    }
    // A rejected node stays rejected; anything else takes the approval it earned.
    const approval: Approval =
      existing.row.approval === 'rejected' ? 'rejected' : input.approval;
    const approvedNow =
      approval === 'approved' && existing.row.approval !== 'approved';
    existing.secretHash = input.secretHash;
    existing.row = {
      ...existing.row,
      role: input.role,
      hostname: input.hostname,
      approval,
      enrolledVia: input.enrolledVia,
      remoteAddr: input.remoteAddr,
      approvedAt: approvedNow ? now : existing.row.approvedAt,
      retiredAt: null,
    };
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
    if (stored === undefined || stored.secretHash !== secretHash) return null;
    const { approval } = stored.row;
    return approval === 'rejected' || approval === 'retired'
      ? null
      : stored.row;
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
    stored.row = {
      ...stored.row,
      role: body.role,
      hostname: body.hostname,
      facts: body as unknown as Record<string, unknown>,
      revision: body.revision,
      agentVersion: body.agent.version,
      configRevision: body.agent.configRevision,
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
    actor: string
  ): Promise<SettingsRow> {
    const now = this.clock();
    const doc = { ...value } as Readonly<Record<string, unknown>>;
    const row: SettingsRow = {
      scope,
      value: doc,
      updatedAt: now,
      updatedBy: actor,
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

function blankRow(input: RegisterInput, now: Date): NodeRow {
  return {
    id: input.id,
    role: input.role,
    hostname: input.hostname,
    approval: input.approval,
    displayName: null,
    note: null,
    labels: [],
    facts: {},
    revision: null,
    agentVersion: null,
    configRevision: null,
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
