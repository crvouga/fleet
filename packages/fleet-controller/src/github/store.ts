import type {
  CiJob,
  Integration,
  IntegrationInput,
  IntegrationStatus,
  JobQuery,
  RunnerRecord,
} from './types';

/** Storage for the GitHub integration; a SQLite and an in-memory implementation. */
export interface GithubStore {
  /** The singleton row; an `unconfigured` default when nobody saved one. */
  getIntegration(): Promise<Integration>;
  putIntegration(
    input: IntegrationInput,
    actor: string,
    now: Date
  ): Promise<Integration>;
  /** `syncedAt` null leaves the last sync time alone. */
  setStatus(
    status: IntegrationStatus,
    error: string | null,
    syncedAt: Date | null
  ): Promise<void>;

  /**
   * Insert or update by job id. Idempotent, and an older state never replaces a
   * newer one (queued < in_progress < completed), so a late webhook or a retried
   * sync cannot move a job backwards.
   */
  upsertJobs(jobs: readonly CiJob[]): Promise<void>;
  listJobs(query: JobQuery): Promise<readonly CiJob[]>;
  getJob(id: number): Promise<CiJob | null>;
  jobCounts(): Promise<{ queued: number; inProgress: number }>;
  /** Deletes completed jobs that finished before `before`. */
  pruneJobs(before: Date, limit: number): Promise<number>;

  /** The runners GitHub listed in a complete pass: upsert them, drop the rest. */
  replaceRunners(runners: readonly RunnerRecord[]): Promise<void>;
  listRunners(): Promise<readonly RunnerRecord[]>;
  removeRunner(id: number): Promise<void>;
}
