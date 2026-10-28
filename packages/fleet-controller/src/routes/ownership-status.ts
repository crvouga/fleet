import type { Hono } from 'hono';

import type { AppDeps } from '../deps';
import { readOwnershipView, type OwnershipStatus } from '../ownership/status';

import { adminRoute, requireAdmin } from './guards';
import { controllerError } from './http';

const ageSeconds = (now: number, at: number): number =>
  Math.max(0, Math.round((now - at) / 100) / 10);

/** The monitoring view of the supervisor's status, with ages measured at `now` (epoch ms). */
export function describeOwnership(status: OwnershipStatus, now: number) {
  return {
    supervised: true as const,
    state: status.state,
    /** True only while this instance may acknowledge writes; false while handing over or fenced. */
    held: status.state === 'held',
    generation: status.generation,
    holder: status.holder,
    replicaGeneration: status.replicaGeneration,
    renewalAgeSeconds: ageSeconds(now, status.renewedAtWall),
    /** Replication lag, not idle time: near zero while the replica holds every committed write. */
    replicaLastSyncAgeSeconds:
      status.lastSyncAtWall === null
        ? null
        : ageSeconds(now, status.lastSyncAtWall),
  };
}

/**
 * Prometheus series for ownership, only under the supervisor (an unsupervised
 * process has no ownership to report). An unreadable status reports not held.
 */
export function ownershipMetrics(
  now: number,
  env?: Readonly<Record<string, string | undefined>>
): string[] {
  const view = readOwnershipView(env);
  if (!view.supervised) return [];
  const held = [
    '# HELP fleet_ownership_held 1 while this instance holds writer ownership and accepts writes.',
    '# TYPE fleet_ownership_held gauge',
  ];
  if (view.status === null) return [...held, 'fleet_ownership_held 0'];
  const described = describeOwnership(view.status, now);
  const lines = [
    ...held,
    `fleet_ownership_held ${described.held ? 1 : 0}`,
    '# HELP fleet_ownership_generation The ownership generation this instance holds.',
    '# TYPE fleet_ownership_generation gauge',
    `fleet_ownership_generation ${described.generation}`,
    '# HELP fleet_ownership_renewal_age_seconds Seconds since ownership was last renewed in object storage.',
    '# TYPE fleet_ownership_renewal_age_seconds gauge',
    `fleet_ownership_renewal_age_seconds ${described.renewalAgeSeconds}`,
  ];
  if (described.replicaLastSyncAgeSeconds !== null)
    lines.push(
      '# HELP fleet_replica_last_sync_age_seconds Seconds since the replica last held everything the database committed (replication lag; stays near zero when idle).',
      '# TYPE fleet_replica_last_sync_age_seconds gauge',
      `fleet_replica_last_sync_age_seconds ${described.replicaLastSyncAgeSeconds}`
    );
  return lines;
}

/**
 * `GET /v1/ownership`: writer ownership as the supervisor last recorded it.
 * Administrators only. `{ supervised: false }` when the process runs without a
 * supervisor; 503 when the supervisor's status cannot be read.
 */
export function mountOwnershipStatus(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/ownership',
    adminRoute(deps, async (c, actor) => {
      const denied = await requireAdmin(deps, c, actor, 'ownership.read');
      if (denied !== null) return denied;
      const view = readOwnershipView();
      if (!view.supervised) return c.json({ supervised: false });
      if (view.status === null)
        return controllerError(
          c,
          503,
          'ownership_unavailable',
          'The supervisor has not published a readable ownership status.'
        );
      return c.json(describeOwnership(view.status, deps.now().getTime()));
    })
  );
}
