import { isConfigured } from './policy';
import type { GithubStore } from './store';
import {
  FAILED_CONCLUSIONS,
  type CiJob,
  type Integration,
  type IntegrationInput,
  type IntegrationStatus,
  type JobQuery,
  type RunnerRecord,
} from './types';
import { EMPTY_INTEGRATION } from './policy';

const RANK = { queued: 0, in_progress: 1, completed: 2 } as const;

function statusMatches(job: CiJob, status: JobQuery['status']): boolean {
  if (status === undefined) return true;
  if (status === 'active') return job.status !== 'completed';
  if (status === 'failed') {
    return (
      job.status === 'completed' &&
      FAILED_CONCLUSIONS.some((c) => c === job.conclusion)
    );
  }
  return job.status === status;
}

function matches(job: CiJob, query: JobQuery): boolean {
  if (!statusMatches(job, query.status)) return false;
  if (query.repository !== undefined && job.repository !== query.repository)
    return false;
  return query.nodeId === undefined || job.nodeId === query.nodeId;
}

/** The stored job after an update: later facts win, known facts are never erased. */
function merged(job: CiJob, old: CiJob | undefined): CiJob | null {
  if (old === undefined) return job;
  if (RANK[job.status] < RANK[old.status]) return null;
  return {
    ...job,
    runnerId: job.runnerId ?? old.runnerId,
    runnerName: job.runnerName ?? old.runnerName,
    nodeId: job.nodeId ?? old.nodeId,
    startedAt: job.startedAt ?? old.startedAt,
    completedAt: job.completedAt ?? old.completedAt,
  };
}

function newestFirst(a: CiJob, b: CiJob): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
}

/** An in-memory twin of the SQLite store, for tests and explicit fixtures. */
export class MemoryGithubStore implements GithubStore {
  private integration: Integration = {
    ...EMPTY_INTEGRATION,
    status: 'unconfigured',
    lastSyncAt: null,
    lastError: null,
    updatedAt: null,
    updatedBy: null,
  };
  private readonly jobs = new Map<number, CiJob>();
  private runners = new Map<number, RunnerRecord>();

  async getIntegration(): Promise<Integration> {
    return this.integration;
  }

  async putIntegration(
    input: IntegrationInput,
    actor: string,
    now: Date
  ): Promise<Integration> {
    this.integration = {
      ...input,
      status: isConfigured(input) ? 'ok' : 'unconfigured',
      lastSyncAt: this.integration.lastSyncAt,
      lastError: null,
      updatedAt: now,
      updatedBy: actor,
    };
    return this.integration;
  }

  async setStatus(
    status: IntegrationStatus,
    error: string | null,
    syncedAt: Date | null
  ): Promise<void> {
    this.integration = {
      ...this.integration,
      status,
      lastError: error,
      lastSyncAt: syncedAt ?? this.integration.lastSyncAt,
    };
  }

  async upsertJobs(jobs: readonly CiJob[]): Promise<void> {
    for (const job of jobs) {
      const next = merged(job, this.jobs.get(job.id));
      if (next !== null) this.jobs.set(job.id, next);
    }
  }

  async listJobs(query: JobQuery): Promise<readonly CiJob[]> {
    const sorted = [...this.jobs.values()].filter((j) => matches(j, query));
    sorted.sort(newestFirst);
    const before =
      query.beforeId === undefined ? undefined : this.jobs.get(query.beforeId);
    const start =
      query.beforeId === undefined
        ? 0
        : before === undefined
          ? sorted.length
          : sorted.findIndex((j) => j.id === before.id) + 1;
    return sorted.slice(start, start + query.limit);
  }

  async getJob(id: number): Promise<CiJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async jobCounts(): Promise<{ queued: number; inProgress: number }> {
    const all = [...this.jobs.values()];
    return {
      queued: all.filter((j) => j.status === 'queued').length,
      inProgress: all.filter((j) => j.status === 'in_progress').length,
    };
  }

  async pruneJobs(before: Date, limit: number): Promise<number> {
    let removed = 0;
    for (const job of [...this.jobs.values()]) {
      const finished = job.completedAt ?? job.createdAt;
      if (removed >= limit) break;
      if (job.status === 'completed' && finished < before) {
        this.jobs.delete(job.id);
        removed += 1;
      }
    }
    return removed;
  }

  async replaceRunners(runners: readonly RunnerRecord[]): Promise<void> {
    this.runners = new Map(runners.map((r) => [r.id, r]));
  }

  async listRunners(): Promise<readonly RunnerRecord[]> {
    return [...this.runners.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  async removeRunner(id: number): Promise<void> {
    this.runners.delete(id);
  }
}
