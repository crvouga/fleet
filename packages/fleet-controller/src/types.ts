import type { Telemetry } from './telemetry';
export type { Telemetry } from './telemetry';
/**
 * The vocabulary shared by the controller, the dashboard and (by PROTOCOL.md) the
 * node agent. Nothing here touches I/O.
 */

/**
 * Roles come from packages/fleet/roles.json; `fleet_roles.py sync` rewrites the
 * two lists below. ROLES is every role in the registry, so node rows and
 * settings of a retired role stay valid until a reviewed change deletes it.
 * ACTIVE_ROLES are the roles the controller may assign. CLOSURES are the
 * buildable closures of the active roles in registry order: a role's own
 * closure, or <role>-<capability> variants chosen by hardware.
 */
export const ROLES = ['ci', 'web', 'cache', 'netboot', 'devbox'] as const;
export type Role = (typeof ROLES)[number];
export const ACTIVE_ROLES = ['ci', 'devbox'] as const satisfies readonly Role[];
export type ActiveRole = (typeof ACTIVE_ROLES)[number];
export const CLOSURES = ['ci', 'ci-gpu', 'devbox'] as const;

/** What a person decided about a machine. */
export type Approval = 'pending' | 'approved' | 'rejected' | 'retired';

/** What the dashboard shows: approval combined with how recently it reported. */
export type NodeStatus =
  'online' | 'stale' | 'offline' | 'pending' | 'rejected' | 'retired';

export type Severity = 'info' | 'warn' | 'error';
export type EnrolledVia = 'enrollment-token' | 'hello' | 'dashboard';

/** What a node runs: a registry role, or the role-less base system. */
export type ObservedRole = Role | 'base';

/** Hardware facts a closure may require. Unknown reported values are dropped. */
export const CAPABILITIES = ['gpu'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The node's own view of its reconcile loop (fleet-sync). */
export type ReconcilePhase = 'converged' | 'progressing' | 'blocked';
export interface ReconcileReport {
  readonly phase: ReconcilePhase;
  /** Up to 8 public strings that tell a person what blocks convergence. */
  readonly issues: readonly string[];
}

/** Computed, never stored: observed against desired. */
export type Convergence = ReconcilePhase | 'unknown';

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

/** POST /v1/heartbeat body (protocol v2). Every field a node cannot know is null. */
export interface HeartbeatBody {
  readonly v: 2;
  readonly nodeId: string;
  /** Observed: the role of the running closure. Never changes the assignment. */
  readonly role: ObservedRole;
  /** Observed: the flake attribute of the running closure. */
  readonly closure: string;
  readonly hostname: string;
  readonly hardware?: { readonly capabilities: readonly Capability[] };
  /** The node's own age public key (`age1…`). Never a private key. */
  readonly ageRecipient?: string;
  /**
   * The next age public key while a rotation is pending: reported until the
   * node promotes it to `ageRecipient`. Kept in the stored facts only.
   */
  readonly ageRecipientNext?: string;
  readonly reconcile?: ReconcileReport;
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
    /** The desired document revision this node last accepted and applied. */
    readonly desiredRevision: string | null;
  };
  readonly events: readonly NodeEventInput[];
  readonly recovery?: RecoveryFacts;
}

export interface NodeRow {
  readonly id: string;
  /** Assigned by a person or an enrollment token; null when unassigned. Heartbeats never change it. */
  readonly role: Role | null;
  /** Reported by the node; null until it reported protocol v2. */
  readonly observedRole: ObservedRole | null;
  readonly observedClosure: string | null;
  readonly ageRecipient: string | null;
  readonly hardware: { readonly capabilities: readonly Capability[] } | null;
  readonly reconcile: ReconcileReport | null;
  readonly hostname: string;
  readonly approval: Approval;
  readonly displayName: string | null;
  readonly note: string | null;
  readonly labels: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
  readonly revision: string | null;
  readonly agentVersion: string | null;
  /** The desired revision the node reports it applied (`agent.desiredRevision`). */
  readonly appliedRevision: string | null;
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
  readonly hardwareCapabilities: readonly Capability[];
  /** What the controller currently wants this node to run; null keeps the running system. */
  readonly desiredClosure: string | null;
  readonly desiredRevision: string;
  readonly convergence: Convergence;
  readonly reconcileIssues: readonly string[];
  /** The next age recipient while a rotation is pending (from the stored facts). */
  readonly ageRecipientNext: string | null;
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
  /** Approved nodes without an assigned role. */
  readonly unassigned: { readonly total: number; readonly online: number };
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

export function isObservedRole(value: unknown): value is ObservedRole {
  return value === 'base' || isRole(value);
}

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === 'string' &&
    (CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isActiveRole(value: unknown): value is ActiveRole {
  return (
    typeof value === 'string' &&
    (ACTIVE_ROLES as readonly string[]).includes(value)
  );
}

export type AuditOutcome = 'success' | 'denied' | 'failed';

/** A security- or operations-relevant action. Never put credentials or tokens in `detail`. */
export interface AuditInput {
  readonly actor: string;
  readonly actorRole?: string | null;
  /** Dotted verb, e.g. `node.retire`, `settings.put`, `auth.denied`. */
  readonly action: string;
  readonly targetKind: string;
  readonly targetId?: string | null;
  readonly outcome?: AuditOutcome;
  readonly requestId?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditRow {
  readonly id: number;
  readonly at: Date;
  readonly actor: string;
  readonly actorRole: string | null;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly outcome: AuditOutcome;
  readonly requestId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}
