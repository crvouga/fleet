import type { AppDeps } from '../deps';
import type { CiJob, RunnerRecord } from '../github/types';
import { readFacts } from '../ui/lib/facts';
import type { NodeRow } from '../types';

import { clip } from './gather-node';
import type { LogLine, TimelineEntry } from './types';

const SAME_NODE_FAILURES = 10;

export function workloadIdentifiers(
  job: CiJob,
  runner: RunnerRecord | null
): Record<string, unknown> {
  return {
    jobId: job.id,
    runId: job.runId,
    repository: job.repository,
    jobName: job.name,
    status: job.status,
    conclusion: job.conclusion,
    labels: job.labels,
    runnerId: job.runnerId,
    runnerName: job.runnerName,
    slot: runner?.slot ?? null,
    htmlUrl: job.htmlUrl,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

/** Other recent failed jobs on the same node (or repository): one flaky job or a sick node? */
export async function failedJobs(
  deps: AppDeps,
  job: CiJob | null,
  node: NodeRow | null
): Promise<Record<string, unknown>[]> {
  const github = deps.github;
  if (github === undefined) return [];
  const nodeId = job?.nodeId ?? node?.id ?? null;
  const scope =
    nodeId !== null
      ? { nodeId }
      : job !== null
        ? { repository: job.repository }
        : null;
  if (scope === null) return [];
  const jobs = await github.store.listJobs({
    status: 'failed',
    limit: SAME_NODE_FAILURES,
    ...scope,
  });
  return jobs.map((entry) => ({
    jobId: entry.id,
    runId: entry.runId,
    repository: entry.repository,
    jobName: entry.name,
    conclusion: entry.conclusion,
    completedAt: entry.completedAt?.toISOString() ?? null,
    isTarget: entry.id === job?.id,
  }));
}

/** The slot the node reported for this job, when its telemetry has one. */
export function slotLogs(node: NodeRow | null, job: CiJob | null): LogLine[] {
  if (node === null || job === null) return [];
  const slots = readFacts(node).telemetry?.runnerSlots ?? [];
  return slots
    .filter(
      (slot) => slot.jobName === job.name || slot.runId === String(job.runId)
    )
    .map((slot) => ({
      at: slot.finishedAt ?? slot.startedAt,
      source: `runner-slot ${slot.slot}`,
      level:
        slot.result === null || slot.result === 'success' ? 'info' : 'error',
      message: clip(
        `state=${slot.state} result=${slot.result ?? 'none'} job=${slot.jobName ?? 'none'}`
      ),
    }));
}

export function jobTimeline(job: CiJob): TimelineEntry[] {
  const entry = (at: Date | null, kind: string): TimelineEntry[] =>
    at === null
      ? []
      : [
          {
            at: at.toISOString(),
            source: 'job',
            kind,
            message: `${job.name} ${kind}`,
          },
        ];
  return [
    ...entry(job.createdAt, 'queued'),
    ...entry(job.startedAt, 'started'),
    ...entry(job.completedAt, `completed (${job.conclusion ?? 'unknown'})`),
  ];
}
