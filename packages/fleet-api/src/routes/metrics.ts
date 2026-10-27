import type { Hono } from 'hono';

import type { AppDeps } from '../deps';
import { summarize } from '../domain/summary';
import { ROLES, type NodeStatus, type NodeView } from '../types';

import { adminRoute } from './guards';
import { loadViews } from './node-views';
import { resourceMetrics } from './resource-metrics';

const STATUSES: readonly NodeStatus[] = [
  'online',
  'stale',
  'offline',
  'pending',
  'rejected',
  'retired',
];

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function labels(pairs: Readonly<Record<string, string>>): string {
  const body = Object.entries(pairs).map(
    ([k, v]) => `${k}="${escapeLabel(v)}"`
  );
  return `{${body.join(',')}}`;
}

function countsByStatusAndRole(views: readonly NodeView[]): string[] {
  const lines = [
    '# HELP fleet_nodes Nodes by status and role.',
    '# TYPE fleet_nodes gauge',
  ];
  for (const status of STATUSES) {
    for (const role of ROLES) {
      const count = views.filter(
        (v) => v.status === status && v.role === role
      ).length;
      lines.push(`fleet_nodes${labels({ status, role })} ${count}`);
    }
  }
  return lines;
}

function perNode(views: readonly NodeView[]): string[] {
  const reporting = views.filter((v) => v.approval === 'approved');
  const lines = [
    '# HELP fleet_node_up 1 when an approved node is reporting on time.',
    '# TYPE fleet_node_up gauge',
  ];
  for (const v of reporting) {
    lines.push(
      `fleet_node_up${labels({ node: v.hostname, role: v.role })} ${v.status === 'online' ? 1 : 0}`
    );
  }
  lines.push(
    '# HELP fleet_node_last_seen_seconds Seconds since an approved node last reported.',
    '# TYPE fleet_node_last_seen_seconds gauge'
  );
  for (const v of reporting) {
    if (v.ageSeconds !== null) {
      lines.push(
        `fleet_node_last_seen_seconds${labels({ node: v.hostname })} ${v.ageSeconds}`
      );
    }
  }
  return lines;
}

function runnerSlots(views: readonly NodeView[]): string[] {
  const { total, busy } = summarize(views).runnerSlots;
  return [
    '# HELP fleet_runner_slots CI runner slots on reporting nodes.',
    '# TYPE fleet_runner_slots gauge',
    `fleet_runner_slots${labels({ state: 'total' })} ${total}`,
    `fleet_runner_slots${labels({ state: 'busy' })} ${busy}`,
  ];
}

/** Prometheus text exposition. Admin only: hostnames are not public. */
export function renderMetrics(
  views: readonly NodeView[],
  now: Date = new Date()
): string {
  return (
    [
      ...countsByStatusAndRole(views),
      ...perNode(views),
      ...runnerSlots(views),
      ...resourceMetrics(views, now),
    ].join('\n') + '\n'
  );
}

export function mountMetrics(app: Hono, deps: AppDeps): void {
  app.get(
    '/metrics',
    adminRoute(deps, async (c) => {
      const text = renderMetrics(await loadViews(deps), deps.now());
      return c.body(text, 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    })
  );
}
