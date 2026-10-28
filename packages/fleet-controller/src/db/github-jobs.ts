import type { CiJob, JobQuery } from '../github/types';
import { FAILED_CONCLUSIONS } from '../github/types';

import type { Db, Rows } from './client';

const RANK = `case status when 'queued' then 0 when 'in_progress' then 1 else 2 end`;

/** Idempotent upsert that never moves a job to an earlier state. */
export async function insertJobs(
  db: Db,
  jobs: readonly CiJob[]
): Promise<void> {
  if (jobs.length === 0) return;
  await db.begin(async (tx) => {
    for (const job of jobs) {
      await tx.unsafe(
        `insert into ci_jobs
           (id, repository, run_id, name, status, conclusion, labels, runner_id, runner_name,
            node_id, html_url, created_at, started_at, completed_at, updated_at, source)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set
           status = excluded.status, conclusion = excluded.conclusion, labels = excluded.labels,
           runner_id = coalesce(excluded.runner_id, ci_jobs.runner_id),
           runner_name = coalesce(excluded.runner_name, ci_jobs.runner_name),
           node_id = coalesce(excluded.node_id, ci_jobs.node_id),
           html_url = coalesce(excluded.html_url, ci_jobs.html_url),
           started_at = coalesce(excluded.started_at, ci_jobs.started_at),
           completed_at = coalesce(excluded.completed_at, ci_jobs.completed_at),
           updated_at = excluded.updated_at, source = excluded.source
         where ${RANK.replace(/status/g, 'excluded.status')} >= ${RANK.replace(/status/g, 'ci_jobs.status')}`,
        [
          job.id,
          job.repository,
          job.runId,
          job.name,
          job.status,
          job.conclusion,
          JSON.stringify(job.labels),
          job.runnerId,
          job.runnerName,
          job.nodeId,
          job.htmlUrl,
          job.createdAt.toISOString(),
          job.startedAt?.toISOString() ?? null,
          job.completedAt?.toISOString() ?? null,
          job.updatedAt.toISOString(),
          job.source,
        ]
      );
    }
  });
}

function statusClause(status: JobQuery['status']): string {
  if (status === 'failed') {
    const list = FAILED_CONCLUSIONS.map((c) => `'${c}'`).join(',');
    return `status = 'completed' and conclusion in (${list})`;
  }
  if (status === 'active') return `status in ('queued', 'in_progress')`;
  return status === undefined ? '1 = 1' : `status = '${status}'`;
}

export function selectJobs(db: Db, query: JobQuery): Promise<Rows> {
  const text = `
    select * from ci_jobs
    where ${statusClause(query.status)}
      and (? is null or repository = ?)
      and (? is null or node_id = ?)
      and (? is null or (created_at, id) < (select created_at, id from ci_jobs where id = ?))
    order by created_at desc, id desc
    limit ?`;
  const repository = query.repository ?? null;
  const node = query.nodeId ?? null;
  const before = query.beforeId ?? null;
  return db.unsafe(text, [
    repository,
    repository,
    node,
    node,
    before,
    before,
    query.limit,
  ]);
}

export async function deleteJobsBefore(
  db: Db,
  before: Date,
  limit: number
): Promise<number> {
  const rows = await db`
    delete from ci_jobs where id in (
      select id from ci_jobs
      where status = 'completed' and coalesce(completed_at, created_at) < ${before}
      limit ${limit})`;
  return rows.count;
}
