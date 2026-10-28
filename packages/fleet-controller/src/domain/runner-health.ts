import type { NodeStatus, Severity } from '../types';

/**
 * Is the CI fleet actually serving jobs? A pure derivation from what the GitHub
 * sync already mirrors (`ci_jobs`, `github_runners`) and from node reports. It
 * never calls GitHub and never stores anything: `stepRunnerHealth` turns the
 * observed conditions into open/close events exactly once per change, and the
 * set of conditions that are open is itself read back from the event stream, so
 * a controller restart repeats the same decisions and announces nothing new.
 *
 * Three conditions, each an incident rule (`domain/incidents.ts`):
 *
 * - `runner_queue`: a queued job that wants fleet labels has waited longer than
 *   `queueStallSeconds` while no online, idle runner could take it.
 * - `runners_offline`: GitHub lists no online Fleet runner for `noRunnersSeconds`
 *   although a CI node is reporting: registration is failing.
 * - `runner_registration`: a CI node reports a runner registration problem
 *   (`FLEET_GITHUB_*` readiness issues) for `registrationSeconds`.
 */

export type RunnerRuleId =
  'runner_queue' | 'runners_offline' | 'runner_registration';

/** The event kinds that open and close each rule, in the vocabulary of incidents. */
export const RUNNER_HEALTH_KINDS = {
  runner_queue: { open: 'runner_queue_stalled', close: 'runner_queue_ok' },
  runners_offline: { open: 'runners_offline', close: 'runners_ok' },
  runner_registration: {
    open: 'runner_registration_failing',
    close: 'runner_registration_ok',
  },
} as const satisfies Record<RunnerRuleId, { open: string; close: string }>;

export const RUNNER_HEALTH_EVENT_KINDS: readonly string[] = Object.values(
  RUNNER_HEALTH_KINDS
).flatMap((pair) => [pair.open, pair.close]);

const ERROR_AFTER_STALLS = 3;

export interface RunnerHealthThresholds {
  /** A queued fleet job waiting this long, with no idle runner, is a stall. */
  readonly queueStallSeconds: number;
  /** No online Fleet runner for this long while a CI node reports. */
  readonly noRunnersSeconds: number;
  /** A node's registration issue must persist this long. */
  readonly registrationSeconds: number;
  /** A condition must be absent this long before its incident closes (no flapping). */
  readonly clearSeconds: number;
}

export const DEFAULT_QUEUE_STALL_MINUTES = 10;
export const DEFAULT_NO_RUNNERS_MINUTES = 10;
export const DEFAULT_REGISTRATION_MINUTES = 5;
export const CLEAR_HOLD_SECONDS = 120;

export function thresholdsOf(policy: {
  readonly queueStallMinutes: number;
  readonly noRunnersMinutes: number;
  readonly registrationFailingMinutes: number;
}): RunnerHealthThresholds {
  return {
    queueStallSeconds: policy.queueStallMinutes * 60,
    noRunnersSeconds: policy.noRunnersMinutes * 60,
    registrationSeconds: policy.registrationFailingMinutes * 60,
    clearSeconds: CLEAR_HOLD_SECONDS,
  };
}

export interface HealthJob {
  readonly id: number;
  readonly repository: string;
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly labels: readonly string[];
  readonly createdAt: Date;
}

export interface HealthRunner {
  readonly id: number;
  /** Null for an organization runner. */
  readonly repository: string | null;
  readonly status: 'online' | 'offline';
  readonly busy: boolean;
  readonly labels: readonly string[];
  /** Set when the runner name follows the Fleet naming. */
  readonly slot: string | null;
  readonly offlineSince: Date | null;
}

export interface HealthNode {
  readonly id: string;
  readonly label: string;
  readonly role: string | null;
  readonly approved: boolean;
  readonly status: NodeStatus;
  readonly issues: readonly string[];
}

export interface RunnerHealthInput {
  readonly now: Date;
  /** The integration is configured with repositories or an organization and its mirror is current. */
  readonly active: boolean;
  readonly jobs: readonly HealthJob[];
  readonly runners: readonly HealthRunner[];
  readonly nodes: readonly HealthNode[];
}

/** One condition that holds right now. */
export interface RawCondition {
  /** `rule:` plus the node id for per-node rules. */
  readonly key: string;
  readonly rule: RunnerRuleId;
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly severity: Severity;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** It must hold this long before an incident opens (0: the condition already encodes the wait). */
  readonly holdSeconds: number;
  /**
   * Epoch ms before which the data proves it did not hold (a runner was still
   * online then); a later anchor restarts the hold. Null when the data says nothing.
   */
  readonly notBefore: number | null;
}

export function conditionKey(rule: RunnerRuleId, nodeId: string | null) {
  return `${rule}:${nodeId ?? ''}`;
}

const lower = (labels: readonly string[]) => labels.map((l) => l.toLowerCase());

/** A queued job that asks for fleet runners. */
export function isFleetJob(job: Pick<HealthJob, 'labels'>): boolean {
  const labels = lower(job.labels);
  return (
    labels.includes('self-hosted') &&
    (labels.includes('nixos') || labels.includes('ci'))
  );
}

function canTake(runner: HealthRunner, job: HealthJob): boolean {
  if (runner.status !== 'online' || runner.busy) return false;
  if (runner.repository !== null && runner.repository !== job.repository)
    return false;
  const offered = new Set(lower(runner.labels));
  return lower(job.labels).every(
    (label) => offered.has(label) || label === 'self-hosted'
  );
}

const waitedSeconds = (job: HealthJob, now: Date): number =>
  Math.max(0, Math.round((now.getTime() - job.createdAt.getTime()) / 1000));

export interface QueueFacts {
  readonly queued: number;
  readonly oldestQueuedSeconds: number;
  /** Jobs past the stall threshold with no idle runner able to take them. */
  readonly stalled: readonly HealthJob[];
}

export function queueFacts(
  input: RunnerHealthInput,
  thresholds: Pick<RunnerHealthThresholds, 'queueStallSeconds'>
): QueueFacts {
  const waiting = input.jobs.filter(
    (job) => job.status === 'queued' && isFleetJob(job)
  );
  const oldest = waiting.reduce(
    (max, job) => Math.max(max, waitedSeconds(job, input.now)),
    0
  );
  const stalled = waiting.filter(
    (job) =>
      waitedSeconds(job, input.now) >= thresholds.queueStallSeconds &&
      !input.runners.some((runner) => canTake(runner, job))
  );
  return { queued: waiting.length, oldestQueuedSeconds: oldest, stalled };
}

/** Fleet runners (named like a slot of a node) GitHub currently lists as online. */
export function onlineFleetRunners(input: RunnerHealthInput): number {
  return input.runners.filter((r) => r.slot !== null && r.status === 'online')
    .length;
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

function queueCondition(
  input: RunnerHealthInput,
  t: RunnerHealthThresholds
): RawCondition[] {
  const facts = queueFacts(input, t);
  const oldest = facts.stalled
    .map((job) => ({ job, wait: waitedSeconds(job, input.now) }))
    .sort((a, b) => b.wait - a.wait)[0];
  if (oldest === undefined) return [];
  const severe = oldest.wait >= t.queueStallSeconds * ERROR_AFTER_STALLS;
  return [
    {
      key: conditionKey('runner_queue', null),
      rule: 'runner_queue',
      nodeId: null,
      nodeLabel: null,
      severity: severe ? 'error' : 'warn',
      message: `${facts.stalled.length} queued job${facts.stalled.length === 1 ? '' : 's'} waited more than ${minutes(t.queueStallSeconds)} and no idle runner matches (oldest: ${oldest.job.repository}, job ${oldest.job.id})`,
      data: {
        stalledJobs: facts.stalled.length,
        queuedJobs: facts.queued,
        oldestJobId: oldest.job.id,
        repository: oldest.job.repository,
        thresholdSeconds: t.queueStallSeconds,
      },
      holdSeconds: 0,
      notBefore: null,
    },
  ];
}

function reportingCiNodes(input: RunnerHealthInput): HealthNode[] {
  return input.nodes.filter(
    (node) => node.role === 'ci' && node.approved && node.status === 'online'
  );
}

function offlineCondition(
  input: RunnerHealthInput,
  t: RunnerHealthThresholds
): RawCondition[] {
  const reporting = reportingCiNodes(input);
  if (reporting.length === 0 || onlineFleetRunners(input) > 0) return [];
  // When the last runner went offline, if GitHub still lists any.
  const lastOffline = input.runners
    .map((runner) => runner.offlineSince?.getTime() ?? null)
    .filter((at): at is number => at !== null)
    .reduce<number | null>(
      (max, at) => (max === null ? at : Math.max(max, at)),
      null
    );
  return [
    {
      key: conditionKey('runners_offline', null),
      rule: 'runners_offline',
      nodeId: null,
      nodeLabel: null,
      severity: 'error',
      message: `GitHub lists no online Fleet runner although ${reporting.length} CI node${reporting.length === 1 ? ' is' : 's are'} reporting: runner registration is failing`,
      data: {
        ciNodesOnline: reporting.length,
        thresholdSeconds: t.noRunnersSeconds,
      },
      holdSeconds: t.noRunnersSeconds,
      notBefore: lastOffline,
    },
  ];
}

const REGISTRATION_CODES = [
  'FLEET_GITHUB_SCOPE_INVALID',
  'FLEET_GITHUB_UNCONFIGURED',
  'FLEET_GITHUB_REGISTRATION',
  'FLEET_GITHUB_UNAVAILABLE',
  'FLEET_GITHUB_SCOPE',
  'FLEET_GITHUB_KEY',
  'FLEET_RUNNER_NOT_ALLOWED',
  'FLEET_RUNNER_RESTARTING',
] as const;
type RegistrationCode = (typeof REGISTRATION_CODES)[number];

/** Transient codes retry by themselves; the others need a person. */
const TRANSIENT: ReadonlySet<string> = new Set([
  'FLEET_GITHUB_UNAVAILABLE',
  'FLEET_RUNNER_RESTARTING',
]);

const CODE_PATTERN = new RegExp(`\\b(${REGISTRATION_CODES.join('|')})\\b`);

/** What an operator should do, by public code. Never quotes the node's own text. */
const CODE_HINT: Record<RegistrationCode, string> = {
  FLEET_GITHUB_KEY:
    'GitHub refused the App credential; check the App ID and private key on the controller',
  FLEET_GITHUB_SCOPE:
    'the App installation cannot reach the target or lacks the runner permission (Administration or Self-hosted runners)',
  FLEET_GITHUB_SCOPE_INVALID:
    'the runner registration targets are not configured correctly',
  FLEET_GITHUB_REGISTRATION: 'GitHub refused the runner registration',
  FLEET_GITHUB_UNCONFIGURED:
    'the GitHub integration is not configured on the controller',
  FLEET_GITHUB_UNAVAILABLE:
    'GitHub or the network is failing; the node keeps retrying',
  FLEET_RUNNER_NOT_ALLOWED:
    'the controller refused this node a registration token',
  FLEET_RUNNER_RESTARTING: 'a runner service keeps restarting',
};

/** The registration problem a node reports in its readiness issues, if any. */
export function registrationCode(
  issues: readonly string[]
): RegistrationCode | null {
  for (const issue of issues) {
    const found = CODE_PATTERN.exec(issue)?.[1];
    const code = REGISTRATION_CODES.find((candidate) => candidate === found);
    if (code !== undefined) return code;
  }
  return null;
}

function registrationConditions(
  input: RunnerHealthInput,
  t: RunnerHealthThresholds
): RawCondition[] {
  return reportingCiNodes(input).flatMap((node) => {
    const code = registrationCode(node.issues);
    if (code === null) return [];
    return [
      {
        key: conditionKey('runner_registration', node.id),
        rule: 'runner_registration' as const,
        nodeId: node.id,
        nodeLabel: node.label,
        severity: TRANSIENT.has(code) ? ('warn' as const) : ('error' as const),
        message: `${code}: ${CODE_HINT[code]}`,
        data: { code },
        holdSeconds: t.registrationSeconds,
        notBefore: null,
      },
    ];
  });
}

/** Every condition that holds in this snapshot. Empty when the integration is not active. */
export function observeRunnerHealth(
  input: RunnerHealthInput,
  thresholds: RunnerHealthThresholds
): RawCondition[] {
  if (!input.active) return [];
  return [
    ...queueCondition(input, thresholds),
    ...offlineCondition(input, thresholds),
    ...registrationConditions(input, thresholds),
  ];
}

/**
 * In-memory timers for conditions that need time to pass. Losing them (a
 * restart) only delays an announcement by the hold; it never invents one.
 */
export interface HealthMemory {
  /** Epoch ms since which a not-yet-open condition has held. */
  readonly pending: Readonly<Record<string, number>>;
  /** Epoch ms since which an open condition has been absent. */
  readonly clearing: Readonly<Record<string, number>>;
}

export const EMPTY_MEMORY: HealthMemory = { pending: {}, clearing: {} };

/** What an incident is open for: key to its current severity. */
export type OpenConditions = ReadonlyMap<string, Severity>;

export interface HealthEvent {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  /** Whether this opens (or worsens) or closes an incident. */
  readonly edge: 'open' | 'close';
}

const RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

function nodeOf(rule: RunnerRuleId, key: string): string | null {
  if (rule !== 'runner_registration') return null;
  return key.slice(key.indexOf(':') + 1) || null;
}

const RULES = Object.keys(RUNNER_HEALTH_KINDS) as RunnerRuleId[];

function ruleOfKey(key: string): RunnerRuleId | null {
  const rule = key.slice(0, key.indexOf(':'));
  return RULES.find((candidate) => candidate === rule) ?? null;
}

const CLOSE_MESSAGE: Record<RunnerRuleId, string> = {
  runner_queue: 'queued jobs are no longer stalled',
  runners_offline: 'GitHub lists online Fleet runners again',
  runner_registration: 'runner registration is no longer reported failing',
};

export interface Step {
  readonly events: readonly HealthEvent[];
  readonly memory: HealthMemory;
}

interface Pass {
  readonly open: OpenConditions;
  readonly memory: HealthMemory;
  readonly at: number;
  readonly clearMs: number;
  readonly events: HealthEvent[];
  readonly pending: Record<string, number>;
  readonly clearing: Record<string, number>;
}

function considerTrue(pass: Pass, condition: RawCondition): void {
  const known = pass.open.get(condition.key);
  if (known !== undefined) {
    // Open and still true: announce only when it got worse.
    if (RANK[condition.severity] > RANK[known])
      pass.events.push(opening(condition));
    return;
  }
  const began = Math.max(
    pass.memory.pending[condition.key] ?? pass.at,
    condition.notBefore ?? Number.NEGATIVE_INFINITY
  );
  if (pass.at - began >= condition.holdSeconds * 1000)
    pass.events.push(opening(condition));
  else pass.pending[condition.key] = began;
}

function considerAbsent(pass: Pass, key: string): void {
  const rule = ruleOfKey(key);
  if (rule === null) return;
  const since = pass.memory.clearing[key] ?? pass.at;
  if (pass.at - since >= pass.clearMs) pass.events.push(closing(rule, key));
  else pass.clearing[key] = since;
}

/**
 * One evaluation. Deterministic and idempotent for a given (observed, open,
 * memory, now): an incident opens when its condition has held for its hold, is
 * announced again only when it worsens, and closes only after the condition has
 * been absent for `clearSeconds`, so a value hovering at a threshold cannot
 * flap. Evaluating twice at the same instant, or once more after a restart with
 * the same data, emits nothing the first evaluation did not.
 */
export function stepRunnerHealth(
  observed: readonly RawCondition[],
  state: { readonly open: OpenConditions; readonly memory: HealthMemory },
  now: Date,
  clearSeconds: number
): Step {
  const { open, memory } = state;
  const pass: Pass = {
    open,
    memory,
    at: now.getTime(),
    clearMs: clearSeconds * 1000,
    events: [],
    pending: {},
    clearing: {},
  };
  for (const condition of observed) considerTrue(pass, condition);
  const holding = new Set(observed.map((condition) => condition.key));
  for (const key of open.keys())
    if (!holding.has(key)) considerAbsent(pass, key);
  return {
    events: pass.events,
    memory: { pending: pass.pending, clearing: pass.clearing },
  };
}

function opening(condition: RawCondition): HealthEvent {
  return {
    kind: RUNNER_HEALTH_KINDS[condition.rule].open,
    severity: condition.severity,
    message: condition.message,
    nodeId: condition.nodeId,
    nodeLabel: condition.nodeLabel,
    data: { ...condition.data, rule: condition.rule },
    edge: 'open',
  };
}

function closing(rule: RunnerRuleId, key: string): HealthEvent {
  return {
    kind: RUNNER_HEALTH_KINDS[rule].close,
    severity: 'info',
    message: CLOSE_MESSAGE[rule],
    nodeId: nodeOf(rule, key),
    nodeLabel: null,
    data: { rule },
    edge: 'close',
  };
}

interface StoredHealthEvent {
  readonly id: number;
  readonly at: Date;
  readonly nodeId: string | null;
  readonly kind: string;
  readonly severity: Severity;
}

/** The conditions the stored events leave open (restart-safe: nothing else is remembered). */
export function openConditions(
  events: readonly StoredHealthEvent[]
): OpenConditions {
  const byKind = new Map<
    string,
    { rule: RunnerRuleId; edge: 'open' | 'close' }
  >();
  for (const rule of RULES) {
    byKind.set(RUNNER_HEALTH_KINDS[rule].open, { rule, edge: 'open' });
    byKind.set(RUNNER_HEALTH_KINDS[rule].close, { rule, edge: 'close' });
  }
  const open = new Map<string, Severity>();
  const ordered = [...events].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id
  );
  for (const event of ordered) {
    const meaning = byKind.get(event.kind);
    if (meaning === undefined) continue;
    const key = conditionKey(meaning.rule, event.nodeId);
    if (meaning.edge === 'close') open.delete(key);
    else open.set(key, event.severity);
  }
  return open;
}
