import type { Telemetry } from './telemetry';
export type { Telemetry } from './telemetry';
/**
 * The vocabulary shared by the API, the dashboard and (by PROTOCOL.md) the
 * node agent. Nothing here touches I/O.
 */

/**
 * Roles come from packages/fleet/roles.json; `fleet_roles.py sync` rewrites the
 * two lists below. ROLES is every role in the registry, so node rows and
 * settings of a retired role stay valid until a reviewed change deletes it.
 * ACTIVE_ROLES are the roles a new machine may enroll as.
 */
export const ROLES = ['ci', 'web', 'cache', 'netboot', 'devbox'] as const;
export type Role = (typeof ROLES)[number];
export const ACTIVE_ROLES = ['ci', 'devbox'] as const satisfies readonly Role[];
export type ActiveRole = (typeof ACTIVE_ROLES)[number];

/** What a person decided about a machine. */
export type Approval = 'pending' | 'approved' | 'rejected' | 'retired';

/** What the dashboard shows: approval combined with how recently it reported. */
export type NodeStatus =
  'online' | 'stale' | 'offline' | 'pending' | 'rejected' | 'retired';

export type Severity = 'info' | 'warn' | 'error';
export type EnrolledVia = 'role-token' | 'hello' | 'dashboard';

/** One thing a node says happened since its last report. */
export interface NodeEventInput {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  /**
   * Stable identity from the node's durable outbox (packages/fleet/scripts/recovery.py).
   * An event whose key this node already reported is not stored again, so a
   * retried heartbeat cannot record it twice.
   */
  readonly key?: string;
  /** When the node says it happened, by its own clock. Stored as data.occurredAt. */
  readonly at?: string;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

/** What a node remembers across power loss (recovery.py status). */
export interface RecoveryFacts {
  readonly boot: {
    /** Whether the boot before this one shut down cleanly; null when unknown. */
    readonly previousClean: boolean | null;
    readonly previousEndedAt: string | null;
    /** [unclean boots, boots] over the node's recent boot history. */
    readonly uncleanOfLast: readonly [number, number];
  };
  /** A kernel/initrd the node fell back from and will not reboot into again. */
  readonly quarantine: {
    readonly revision: string | null;
    readonly toplevel: string | null;
    readonly at: string | null;
    readonly reason: string | null;
  } | null;
  /** Runner admission, and every reason that holds it closed. */
  readonly gate: {
    readonly closed: boolean;
    readonly reasons: readonly string[];
  };
  /** Recovery events still waiting for Fleet to accept them. */
  readonly outbox: number;
}

/** POST /v1/heartbeat body. Every field a node cannot know is null. */
export interface HeartbeatBody {
  readonly v: 1;
  readonly nodeId: string;
  readonly role: Role;
  readonly hostname: string;
  readonly capabilities: readonly string[];
  readonly revision: string | null;
  readonly bootId: string | null;
  readonly uptimeSeconds: number | null;
  readonly kernel: string | null;
  readonly arch: string | null;
  readonly cpu: {
    readonly cores: number | null;
    readonly model: string | null;
  };
  readonly memory: {
    readonly totalMiB: number | null;
    readonly availableMiB: number | null;
  };
  readonly load1: number | null;
  readonly disk: {
    readonly nixUsedPercent: number | null;
    readonly bootUsedPercent: number | null;
  };
  readonly addresses: readonly string[];
  readonly sync: {
    readonly rolledBack: boolean;
    readonly healthFailure: string | null;
    readonly paused: boolean;
  };
  readonly failedUnits: readonly string[];
  readonly readiness?: { readonly issues: readonly string[] };
  readonly telemetry?: Telemetry;
  readonly runners: { readonly slots: number; readonly busy: number } | null;
  readonly agent: {
    readonly version: string;
    /** The revision of the configuration this node has applied, if any. */
    readonly configRevision: string | null;
  };
  readonly events: readonly NodeEventInput[];
  readonly recovery?: RecoveryFacts;
}

export interface NodeRow {
  readonly id: string;
  readonly role: Role;
  readonly hostname: string;
  readonly approval: Approval;
  readonly displayName: string | null;
  readonly note: string | null;
  readonly labels: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
  readonly revision: string | null;
  readonly agentVersion: string | null;
  readonly configRevision: string | null;
  readonly heartbeatIntervalSeconds: number;
  readonly remoteAddr: string | null;
  readonly enrolledVia: EnrolledVia;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date | null;
  readonly approvedAt: Date | null;
  readonly approvedBy: string | null;
  readonly retiredAt: Date | null;
  readonly offlineNotifiedAt: Date | null;
}

/** A row plus what the dashboard derives from it. */
export interface NodeView extends NodeRow {
  readonly status: NodeStatus;
  /** First 4 hex digits of the id: the number in the node's hostname. */
  readonly shortId: string;
  /** Display name when a person set one, else the hostname. */
  readonly label: string;
  readonly ageSeconds: number | null;
}

export interface HeartbeatPoint {
  readonly at: Date;
  readonly uptimeSeconds: number | null;
  readonly load1: number | null;
  readonly memUsedPercent: number | null;
  readonly diskPercent: number | null;
  readonly slots: number | null;
  readonly busySlots: number | null;
  /** Compact chart sample: diagnostics and detailed collections are not archived here. */
  readonly telemetry?: Telemetry | null;
}

export interface EventRow {
  readonly id: number;
  readonly at: Date;
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface EventInput {
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface SettingsRow {
  readonly scope: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

export interface SettingsHistoryRow {
  readonly id: number;
  readonly scope: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly changedAt: Date;
  readonly changedBy: string | null;
}

export interface FleetSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<NodeStatus, number>>;
  readonly byRole: Readonly<
    Record<Role, { readonly total: number; readonly online: number }>
  >;
  /** Revisions of the nodes that are not retired, most common first. */
  readonly revisions: readonly {
    readonly revision: string;
    readonly count: number;
  }[];
  readonly runnerSlots: { readonly total: number; readonly busy: number };
  readonly withFailedUnits: number;
  readonly rolledBack: number;
}

export function isRole(value: unknown): value is Role {
  return (
    typeof value === 'string' && (ROLES as readonly string[]).includes(value)
  );
}

export function isActiveRole(value: unknown): value is ActiveRole {
  return (
    typeof value === 'string' &&
    (ACTIVE_ROLES as readonly string[]).includes(value)
  );
}
