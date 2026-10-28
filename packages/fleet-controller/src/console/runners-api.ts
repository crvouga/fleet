/** What `/v1/runners` and `/v1/jobs` send, as the browser sees it (dates are strings). */
export interface IntegrationData {
  scope: 'repository' | 'organization';
  organization: string;
  repositories: string[];
  runnerGroup: string | null;
  appId: string;
  installationId: string;
  policy: {
    extraLabels: string[];
    maxNodesPerRepository: number;
    repositoryRequirements: Record<string, string[]>;
    orphanAutoRemoval: boolean;
    orphanGraceSeconds: number;
    syncIntervalSeconds: number;
    queueStallMinutes: number;
    noRunnersMinutes: number;
    registrationFailingMinutes: number;
  };
  status: 'unconfigured' | 'ok' | 'degraded' | 'error';
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface RunnerData {
  id: number;
  name: string;
  repository: string | null;
  status: 'online' | 'offline';
  busy: boolean;
  nodeId: string | null;
  nodeLabel: string | null;
  orphan: {
    reason: string;
    since: string | null;
    removalAt: string | null;
  } | null;
  unhealthy: boolean;
}

export interface JobData {
  id: number;
  repository: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  runnerName: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  htmlUrl: string | null;
  createdAt: string;
  queuedSeconds: number | null;
  runSeconds: number | null;
  failed: boolean;
  reportUrl: string | null;
}

export interface RunnersData {
  available: boolean;
  access: 'admin' | 'viewer';
  integration: IntegrationData;
  connection: {
    keyConfigured: boolean;
    webhookEnabled: boolean;
    configured: boolean;
    circuit: { state: string; openUntil: string | null } | null;
  };
  capacity: {
    nodes: number;
    slotsTotal: number;
    slotsBusy: number;
    slotsFree: number;
    queued: number;
    inProgress: number;
    waiting: number;
  };
  runners: RunnerData[];
  placements: {
    nodeId: string;
    label: string;
    eligible: boolean;
    repositories: string[];
  }[];
  unplaced: string[];
  health: {
    available: boolean;
    runnersOnline: number;
    queuedFleetJobs: number;
    oldestQueuedSeconds: number;
    queueStalled: boolean;
    conditions: {
      rule: string;
      nodeId: string | null;
      nodeLabel: string | null;
      severity: 'info' | 'warn' | 'error';
      message: string;
    }[];
  };
}

export interface Check {
  name: string;
  ok: boolean;
  code?: string;
  message: string;
}

export async function readJson<T>(
  path: string,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await problem(response));
  return (await response.json()) as T;
}

export async function sendJson<T>(
  method: 'PUT' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(await problem(response));
  return (await response.json()) as T;
}

async function problem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: string;
      errors?: string[];
    };
    return (
      body.errors?.join('; ') ??
      body.message ??
      `Request failed (${response.status})`
    );
  } catch {
    return `Request failed (${response.status})`;
  }
}

/** Lines like `owner/repo: gpu, high-mem` <-> the policy's repositoryRequirements. */
export function parseRequirements(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split('\n')) {
    const [repository, needs = ''] = line.split(':');
    const name = repository?.trim();
    if (!name) continue;
    out[name] = needs
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
  }
  return out;
}

export function formatRequirements(value: Record<string, string[]>): string {
  return Object.entries(value)
    .map(([repository, needs]) => `${repository}: ${needs.join(', ')}`)
    .join('\n');
}

export function lines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function duration(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}
