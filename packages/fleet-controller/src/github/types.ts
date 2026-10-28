export type GithubScope = 'repository' | 'organization';

/** What the controller last learned about its connection to GitHub. */
export type IntegrationStatus = 'unconfigured' | 'ok' | 'degraded' | 'error';

export interface GithubPolicy {
  /** Routing labels added to every runner of a CI node that no setting overrides. */
  readonly extraLabels: readonly string[];
  /** A repository is placed on at most this many nodes; 0 means every eligible node. */
  readonly maxNodesPerRepository: number;
  /** Capabilities or node labels a node needs to serve a repository (e.g. gpu). */
  readonly repositoryRequirements: Readonly<Record<string, readonly string[]>>;
  /** When false the controller only flags orphans; it never deletes them. */
  readonly orphanAutoRemoval: boolean;
  /** How long a runner must stay an orphan before it may be removed. */
  readonly orphanGraceSeconds: number;
  readonly syncIntervalSeconds: number;
  /** A queued fleet job waiting this long with no idle runner opens a `runner_queue` incident. */
  readonly queueStallMinutes: number;
  /** No online Fleet runner for this long while a CI node reports opens `runners_offline`. */
  readonly noRunnersMinutes: number;
  /** A node's runner registration issue persisting this long opens `runner_registration`. */
  readonly registrationFailingMinutes: number;
}

export interface IntegrationInput {
  readonly scope: GithubScope;
  readonly organization: string;
  readonly repositories: readonly string[];
  readonly runnerGroup: string | null;
  readonly appId: string;
  readonly installationId: string;
  readonly policy: GithubPolicy;
}

export interface Integration extends IntegrationInput {
  readonly status: IntegrationStatus;
  readonly lastSyncAt: Date | null;
  /** Public text with a code (FLEET_GITHUB_KEY...), never a response body. */
  readonly lastError: string | null;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

export type JobStatus = 'queued' | 'in_progress' | 'completed';

export interface CiJob {
  readonly id: number;
  readonly repository: string;
  readonly runId: number;
  readonly name: string;
  readonly status: JobStatus;
  readonly conclusion: string | null;
  readonly labels: readonly string[];
  readonly runnerId: number | null;
  readonly runnerName: string | null;
  readonly nodeId: string | null;
  readonly htmlUrl: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
  readonly source: 'poll' | 'webhook';
}

export interface RunnerRecord {
  readonly id: number;
  readonly name: string;
  readonly repository: string | null;
  readonly status: 'online' | 'offline';
  readonly busy: boolean;
  readonly labels: readonly string[];
  readonly nodeId: string | null;
  readonly slot: string | null;
  readonly seenAt: Date;
  readonly offlineSince: Date | null;
  readonly orphanSince: Date | null;
}

export interface JobQuery {
  /** `failed` is a completed job whose conclusion is not success, skipped or neutral. */
  readonly status?: JobStatus | 'failed' | 'active';
  readonly repository?: string;
  readonly nodeId?: string;
  /** Only jobs older than the job with this id, for paging. */
  readonly beforeId?: number;
  readonly limit: number;
}

export const FAILED_CONCLUSIONS = [
  'failure',
  'timed_out',
  'startup_failure',
  'cancelled',
  'action_required',
] as const;

/** Where a runner lives: one repository (owner/name) or a whole organization. */
export interface RunnerTarget {
  readonly scope: GithubScope;
  readonly name: string;
}

export function targetPath(target: RunnerTarget): string {
  const root = target.scope === 'organization' ? 'orgs' : 'repos';
  return `/${root}/${target.name}/actions/runners`;
}
