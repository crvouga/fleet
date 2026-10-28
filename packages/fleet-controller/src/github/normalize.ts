import type { CiJob, JobStatus, RunnerRecord } from './types';

type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function date(value: unknown): Date | null {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Links shown in the dashboard must be https: nothing else is ever rendered as a link. */
function httpsUrl(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.map((entry) =>
    typeof entry === 'string' ? entry : text(record(entry)['name'])
  );
  return names.filter((name): name is string => name !== null);
}

function statusOf(value: unknown): JobStatus {
  if (value === 'completed') return 'completed';
  return value === 'in_progress' ? 'in_progress' : 'queued';
}

/** A workflow job from the REST API or a `workflow_job` webhook; null when unusable. */
export function jobFromGithub(
  raw: unknown,
  repository: string,
  source: CiJob['source'],
  now: Date
): CiJob | null {
  const job = record(raw);
  const id = integer(job['id']);
  const runId = integer(job['run_id']);
  const created = date(job['created_at']);
  if (id === null || runId === null || created === null) return null;
  const runnerName = text(job['runner_name']);
  const status = statusOf(job['status']);
  return {
    id,
    repository,
    runId,
    name: (text(job['name']) ?? 'job').slice(0, 200),
    status,
    conclusion: text(job['conclusion']),
    labels: labelNames(job['labels']).slice(0, 20),
    runnerId: integer(job['runner_id']),
    runnerName,
    nodeId: null,
    htmlUrl: httpsUrl(job['html_url']),
    createdAt: created,
    // GitHub always sends started_at; for a job that has not started it is the creation time.
    startedAt: status === 'queued' ? null : date(job['started_at']),
    completedAt: date(job['completed_at']),
    updatedAt: now,
    source,
  };
}

/** A self-hosted runner as the REST API lists it; null when unusable. */
export function runnerFromGithub(
  raw: unknown,
  repository: string | null,
  seenAt: Date
): RunnerRecord | null {
  const runner = record(raw);
  const id = integer(runner['id']);
  const name = text(runner['name']);
  if (id === null || name === null) return null;
  return {
    id,
    name,
    repository,
    status: runner['status'] === 'online' ? 'online' : 'offline',
    busy: runner['busy'] === true,
    labels: labelNames(runner['labels']),
    nodeId: null,
    slot: null,
    seenAt,
    offlineSince: null,
    orphanSince: null,
  };
}

export function repositoryOf(raw: unknown): string | null {
  const name = text(record(raw)['full_name']);
  return name !== null && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)
    ? name
    : null;
}
