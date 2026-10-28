import type { GithubClient } from './client';
import { GithubError } from './errors';
import {
  jobFromGithub,
  record,
  repositoryOf,
  runnerFromGithub,
  integer,
} from './normalize';
import type { CiJob, Integration, RunnerRecord, RunnerTarget } from './types';

/** Bounds on one sync: it never loops over an unbounded amount of GitHub data. */
export const LIMITS = {
  repositories: 64,
  queuedRuns: 30,
  activeRuns: 30,
  completedRuns: 10,
  jobFetches: 60,
} as const;

export interface Refused {
  readonly target: string;
  readonly error: GithubError;
}

export interface Collected<T> {
  readonly items: readonly T[];
  /** Repositories (or the organization) that failed permanently and why. */
  readonly refused: readonly Refused[];
}

/** A temporary failure aborts the sync (the caller backs off); a permanent one is recorded. */
function settle(error: unknown, target: string, refused: Refused[]): void {
  if (error instanceof GithubError && !error.temporary) {
    refused.push({ target, error });
    return;
  }
  throw error;
}

export function runnerTargets(integration: Integration): RunnerTarget[] {
  if (integration.scope === 'organization') {
    return [{ scope: 'organization', name: integration.organization }];
  }
  return integration.repositories
    .slice(0, LIMITS.repositories)
    .map((name) => ({ scope: 'repository' as const, name }));
}

export async function collectRunners(
  client: GithubClient,
  integration: Integration,
  now: Date
): Promise<Collected<RunnerRecord>> {
  const byId = new Map<number, RunnerRecord>();
  const refused: Refused[] = [];
  for (const target of runnerTargets(integration)) {
    try {
      const repository = target.scope === 'repository' ? target.name : null;
      for (const raw of await client.listRunners(target)) {
        const runner = runnerFromGithub(raw, repository, now);
        if (runner !== null) byId.set(runner.id, runner);
      }
    } catch (error) {
      settle(error, target.name, refused);
    }
  }
  return { items: [...byId.values()], refused };
}

async function monitoredRepositories(
  client: GithubClient,
  integration: Integration
): Promise<string[]> {
  if (
    integration.repositories.length > 0 ||
    integration.scope === 'repository'
  ) {
    return integration.repositories.slice(0, LIMITS.repositories);
  }
  const prefix = `${integration.organization}/`;
  const reachable = await client.listInstallationRepositories();
  return reachable
    .filter((name) => name.startsWith(prefix))
    .slice(0, LIMITS.repositories);
}

export interface RunRef {
  readonly id: number;
  readonly repository: string;
}

async function collectRuns(
  client: GithubClient,
  repository: string,
  since: Date | null
): Promise<RunRef[]> {
  const out: RunRef[] = [];
  const plan = [
    ['queued', LIMITS.queuedRuns],
    ['in_progress', LIMITS.activeRuns],
    ['completed', LIMITS.completedRuns],
  ] as const;
  for (const [status, count] of plan) {
    for (const raw of await client.listRuns(repository, status, count)) {
      const run = record(raw);
      const id = integer(run['id']);
      const updated = Date.parse(String(run['updated_at'] ?? ''));
      const recent = since === null || updated >= since.getTime() - 120_000;
      const wanted = status !== 'completed' || recent;
      if (id !== null && wanted)
        out.push({
          id,
          repository: repositoryOf(run['repository']) ?? repository,
        });
    }
  }
  return out;
}

export interface JobPass {
  readonly since: Date | null;
  readonly now: Date;
  /** Runs of jobs still active in the database: always re-read, so they converge. */
  readonly tracked: readonly RunRef[];
}

async function jobsOfRuns(
  client: GithubClient,
  runs: readonly RunRef[],
  pass: JobPass,
  jobs: Map<number, CiJob>
): Promise<void> {
  for (const run of runs) {
    for (const raw of await client.listRunJobs(run.repository, run.id)) {
      const job = jobFromGithub(raw, run.repository, 'poll', pass.now);
      if (job !== null) jobs.set(job.id, job);
    }
  }
}

/** Queued, running and recently finished jobs of the monitored repositories. */
export async function collectJobs(
  client: GithubClient,
  integration: Integration,
  pass: JobPass
): Promise<Collected<CiJob>> {
  const jobs = new Map<number, CiJob>();
  const refused: Refused[] = [];
  const seen = new Set<string>();
  let budget: number = LIMITS.jobFetches;
  const take = (runs: readonly RunRef[]): RunRef[] => {
    const fresh = runs.filter((r) => !seen.has(`${r.repository}#${r.id}`));
    const chosen = fresh.slice(0, Math.max(0, budget));
    for (const r of chosen) seen.add(`${r.repository}#${r.id}`);
    budget -= chosen.length;
    return chosen;
  };
  for (const repository of await monitoredRepositories(client, integration)) {
    try {
      const runs = await collectRuns(client, repository, pass.since);
      await jobsOfRuns(client, take(runs), pass, jobs);
    } catch (error) {
      settle(error, repository, refused);
    }
  }
  try {
    await jobsOfRuns(client, take(pass.tracked), pass, jobs);
  } catch (error) {
    settle(error, 'tracked jobs', refused);
  }
  return { items: [...jobs.values()], refused };
}
