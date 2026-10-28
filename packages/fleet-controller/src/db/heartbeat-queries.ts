import { scopesFor, effectiveConfig } from '../domain/effective-config';
import {
  deriveReportEvents,
  DEFAULT_DISK_ALERT_PERCENT,
} from '../domain/heartbeat-events';
import { storedEvent } from '../domain/event-keys';
import { DEFAULT_HEARTBEAT_SECONDS } from '../domain/status';
import {
  compactTelemetry,
  MAX_HISTORY_POINTS,
} from '../domain/heartbeat-history';
import type { HeartbeatBody, HeartbeatPoint, NodeRow } from '../types';

import type { Db } from './client';
import { insertEvents } from './event-queries';
import { selectNode } from './node-queries';
import { toHeartbeatPoint, toNodeRow, type Row } from './rows';
import { selectScopes } from './settings-queries';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;

function memUsedPercent(body: HeartbeatBody): number | null {
  const { totalMiB, availableMiB } = body.memory;
  if (totalMiB === null || availableMiB === null || totalMiB <= 0) return null;
  return Math.min(100, Math.max(0, (1 - availableMiB / totalMiB) * 100));
}

function diskPercent(body: HeartbeatBody): number | null {
  const values = [body.disk.nixUsedPercent, body.disk.bootUsedPercent].filter(
    (v): v is number => v !== null
  );
  return values.length === 0 ? null : Math.max(...values);
}

function factsOf(body: HeartbeatBody): string {
  const { events: _events, ...facts } = body;
  return JSON.stringify(facts);
}

async function updateReport(
  db: Db,
  body: HeartbeatBody,
  remoteAddr: string | null,
  seen: { at: Date; interval: number }
): Promise<Row> {
  const rows = await db`
    update nodes set
      role = ${body.role},
      hostname = ${body.hostname},
      facts = ${factsOf(body)},
      revision = ${body.revision},
      agent_version = ${body.agent.version},
      config_revision = ${body.agent.configRevision},
      heartbeat_interval_seconds = ${seen.interval},
      remote_addr = coalesce(${remoteAddr}, remote_addr),
      last_seen_at = ${seen.at.toISOString()},
      offline_notified_at = null
    where id = ${body.nodeId}
    returning *`;
  const row = rows[0];
  if (row === undefined) throw new Error('heartbeat update returned no row');
  return row;
}

async function insertPoint(
  db: Db,
  body: HeartbeatBody,
  at: Date
): Promise<void> {
  await db`
    insert into heartbeats
      (node_id, at, uptime_seconds, load1, mem_used_percent, disk_percent, slots, busy_slots, revision, telemetry)
    values (
      ${body.nodeId}, ${at.toISOString()}, ${body.uptimeSeconds},
      ${body.load1}, ${memUsedPercent(body)}, ${diskPercent(body)},
      ${body.runners?.slots ?? null}, ${body.runners?.busy ?? null}, ${body.revision},
      ${body.telemetry ? JSON.stringify(compactTelemetry(body.telemetry)) : null}
    )
    on conflict (node_id, at) do nothing`;
}

/**
 * One transaction: lock the node, derive events from the change against its
 * last report, store the report, one history point and every event.
 * Rejected and retired nodes are returned untouched.
 */
export async function storeHeartbeat(
  db: Db,
  body: HeartbeatBody,
  remoteAddr: string | null,
  at: Date
): Promise<NodeRow | null> {
  const locked = await selectNode(db, body.nodeId, true);
  if (locked === null) return null;
  const prev = toNodeRow(locked);
  if (prev.approval === 'rejected' || prev.approval === 'retired') return prev;
  const documents = await selectScopes(
    db,
    scopesFor({ id: prev.id, role: body.role })
  );
  const config = effectiveConfig(documents, { id: prev.id, role: body.role });
  const interval = Math.min(
    MAX_INTERVAL,
    Math.max(
      MIN_INTERVAL,
      config.heartbeat?.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS
    )
  );
  const row = toNodeRow(
    await updateReport(db, body, remoteAddr, { at, interval })
  );
  await insertPoint(db, body, at);
  const derived =
    prev.approval === 'approved'
      ? deriveReportEvents(
          prev,
          body,
          config.disk?.alertPercent ?? DEFAULT_DISK_ALERT_PERCENT
        )
      : [];
  const label = row.displayName ?? row.hostname;
  await insertEvents(
    db,
    { id: row.id, label },
    [...derived, ...body.events].map(storedEvent),
    at
  );
  return row;
}

export async function selectPoints(
  db: Db,
  id: string,
  since: Date
): Promise<HeartbeatPoint[]> {
  const rows = await db`
    select * from (
      select *, row_number() over (
        partition by case when n <= ${MAX_HISTORY_POINTS} then round(unixepoch(at, 'subsec') * 1000)
          else floor((round(unixepoch(at, 'subsec') * 1000) - ${since.getTime()}) /
            max(1000.0, (round(unixepoch(latest, 'subsec') * 1000) - ${since.getTime()}) / ${MAX_HISTORY_POINTS - 1})) end
        order by at desc
      ) as rank
      from (
        select *, count(*) over () as n, max(at) over () as latest
        from heartbeats
        where node_id = ${id} and at >= ${since.toISOString()}
      ) raw
    ) sampled where rank = 1
    order by at`;
  return rows.map(toHeartbeatPoint);
}

export async function deleteOlder(db: Db, before: Date): Promise<number> {
  const result = await db`
    delete from heartbeats where at < ${before.toISOString()}`;
  return Number(result.count ?? 0);
}
