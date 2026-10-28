import { readPolicy, EMPTY_INTEGRATION } from '../github/policy';
import type {
  CiJob,
  Integration,
  IntegrationStatus,
  JobStatus,
  RunnerRecord,
} from '../github/types';

import type { Row } from './rows';

function date(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

function required(value: unknown): Date {
  return date(value) ?? new Date(0);
}

function strings(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const STATUSES: readonly IntegrationStatus[] = [
  'unconfigured',
  'ok',
  'degraded',
  'error',
];

export function toIntegration(row: Row): Integration {
  const status = STATUSES.find((s) => s === row['status']);
  let policy: unknown = {};
  try {
    policy = JSON.parse(String(row['policy']));
  } catch {
    policy = {};
  }
  return {
    scope: row['scope'] === 'organization' ? 'organization' : 'repository',
    organization: String(row['organization'] ?? ''),
    repositories: strings(row['repositories']),
    runnerGroup: stringOrNull(row['runner_group']),
    appId: String(row['app_id'] ?? ''),
    installationId: String(row['installation_id'] ?? ''),
    policy: readPolicy(policy),
    status: status ?? 'unconfigured',
    lastSyncAt: date(row['last_sync_at']),
    lastError: stringOrNull(row['last_error']),
    updatedAt: date(row['updated_at']),
    updatedBy: stringOrNull(row['updated_by']),
  };
}

export const UNSET_INTEGRATION: Integration = {
  ...EMPTY_INTEGRATION,
  status: 'unconfigured',
  lastSyncAt: null,
  lastError: null,
  updatedAt: null,
  updatedBy: null,
};

export function toJob(row: Row): CiJob {
  return {
    id: Number(row['id']),
    repository: String(row['repository']),
    runId: Number(row['run_id']),
    name: String(row['name']),
    status: String(row['status']) as JobStatus,
    conclusion: stringOrNull(row['conclusion']),
    labels: strings(row['labels']),
    runnerId: numberOrNull(row['runner_id']),
    runnerName: stringOrNull(row['runner_name']),
    nodeId: stringOrNull(row['node_id']),
    htmlUrl: stringOrNull(row['html_url']),
    createdAt: required(row['created_at']),
    startedAt: date(row['started_at']),
    completedAt: date(row['completed_at']),
    updatedAt: required(row['updated_at']),
    source: row['source'] === 'webhook' ? 'webhook' : 'poll',
  };
}

export function toRunner(row: Row): RunnerRecord {
  return {
    id: Number(row['id']),
    name: String(row['name']),
    repository: stringOrNull(row['repository']),
    status: row['status'] === 'online' ? 'online' : 'offline',
    busy: row['busy'] === 1,
    labels: strings(row['labels']),
    nodeId: stringOrNull(row['node_id']),
    slot: stringOrNull(row['slot']),
    seenAt: required(row['seen_at']),
    offlineSince: date(row['offline_since']),
    orphanSince: date(row['orphan_since']),
  };
}
