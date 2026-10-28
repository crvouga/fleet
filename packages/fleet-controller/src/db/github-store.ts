import type { GithubStore } from '../github/store';
import type {
  CiJob,
  Integration,
  IntegrationInput,
  IntegrationStatus,
  JobQuery,
  RunnerRecord,
} from '../github/types';
import { isConfigured } from '../github/policy';

import type { Db } from './client';
import {
  toIntegration,
  toJob,
  toRunner,
  UNSET_INTEGRATION,
} from './github-rows';
import { deleteJobsBefore, insertJobs, selectJobs } from './github-jobs';

async function replace(
  db: Db,
  runners: readonly RunnerRecord[]
): Promise<void> {
  await db.begin(async (tx) => {
    for (const r of runners) {
      await tx`
        insert into github_runners
          (id, name, repository, status, busy, labels, node_id, slot, seen_at, offline_since, orphan_since)
        values (${r.id}, ${r.name}, ${r.repository}, ${r.status}, ${r.busy ? 1 : 0},
          ${JSON.stringify(r.labels)}, ${r.nodeId}, ${r.slot}, ${r.seenAt},
          ${r.offlineSince}, ${r.orphanSince})
        on conflict (id) do update set
          name = excluded.name, repository = excluded.repository, status = excluded.status,
          busy = excluded.busy, labels = excluded.labels, node_id = excluded.node_id,
          slot = excluded.slot, seen_at = excluded.seen_at,
          offline_since = excluded.offline_since, orphan_since = excluded.orphan_since`;
    }
    const keep = JSON.stringify(runners.map((r) => r.id));
    await tx`delete from github_runners where id not in (select value from json_each(${keep}))`;
  });
}

export class SqliteGithubStore implements GithubStore {
  constructor(private readonly db: Db) {}

  async getIntegration(): Promise<Integration> {
    const rows = await this.db`select * from github_integration where id = 1`;
    const row = rows[0];
    return row === undefined ? UNSET_INTEGRATION : toIntegration(row);
  }

  async putIntegration(
    input: IntegrationInput,
    actor: string,
    now: Date
  ): Promise<Integration> {
    const status = isConfigured(input) ? 'ok' : 'unconfigured';
    await this.db`
      insert into github_integration
        (id, scope, organization, repositories, runner_group, app_id, installation_id, policy, status, last_error, updated_at, updated_by)
      values (1, ${input.scope}, ${input.organization}, ${JSON.stringify(input.repositories)},
        ${input.runnerGroup}, ${input.appId}, ${input.installationId}, ${JSON.stringify(input.policy)},
        ${status}, null, ${now}, ${actor})
      on conflict (id) do update set
        scope = excluded.scope, organization = excluded.organization,
        repositories = excluded.repositories, runner_group = excluded.runner_group,
        app_id = excluded.app_id, installation_id = excluded.installation_id,
        policy = excluded.policy, status = excluded.status, last_error = null,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
    return this.getIntegration();
  }

  async setStatus(
    status: IntegrationStatus,
    error: string | null,
    syncedAt: Date | null
  ): Promise<void> {
    await this.db`
      insert into github_integration (id, status, last_error, last_sync_at)
      values (1, ${status}, ${error}, ${syncedAt})
      on conflict (id) do update set
        status = excluded.status, last_error = excluded.last_error,
        last_sync_at = coalesce(excluded.last_sync_at, github_integration.last_sync_at)`;
  }

  async upsertJobs(jobs: readonly CiJob[]): Promise<void> {
    await insertJobs(this.db, jobs);
  }

  async listJobs(query: JobQuery): Promise<readonly CiJob[]> {
    return (await selectJobs(this.db, query)).map(toJob);
  }

  async getJob(id: number): Promise<CiJob | null> {
    const rows = await this.db`select * from ci_jobs where id = ${id}`;
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async jobCounts(): Promise<{ queued: number; inProgress: number }> {
    const rows = await this.db`
      select
        coalesce(sum(status = 'queued'), 0) as queued,
        coalesce(sum(status = 'in_progress'), 0) as in_progress
      from ci_jobs where status != 'completed'`;
    return {
      queued: Number(rows[0]?.['queued'] ?? 0),
      inProgress: Number(rows[0]?.['in_progress'] ?? 0),
    };
  }

  pruneJobs(before: Date, limit: number): Promise<number> {
    return deleteJobsBefore(this.db, before, limit);
  }

  replaceRunners(runners: readonly RunnerRecord[]): Promise<void> {
    return replace(this.db, runners);
  }

  async listRunners(): Promise<readonly RunnerRecord[]> {
    const rows = await this.db`select * from github_runners order by name`;
    return rows.map(toRunner);
  }

  async removeRunner(id: number): Promise<void> {
    await this.db`delete from github_runners where id = ${id}`;
  }
}
