import type {
  EnrolledVia,
  HeartbeatBody,
  HeartbeatPoint,
  NodeRow,
  Role,
} from '../types';

/** A 64 hex digit id whose first four digits are `short`. */
export function nodeId(short: string): string {
  return short.padEnd(64, '0').slice(0, 64);
}

export interface BodyOptions extends Partial<
  Omit<HeartbeatBody, 'cpu' | 'memory' | 'disk' | 'sync' | 'agent'>
> {
  readonly cpu?: Partial<HeartbeatBody['cpu']>;
  readonly memory?: Partial<HeartbeatBody['memory']>;
  readonly disk?: Partial<HeartbeatBody['disk']>;
  readonly sync?: Partial<HeartbeatBody['sync']>;
  readonly agent?: Partial<HeartbeatBody['agent']>;
}

/** A complete heartbeat body with sensible values, overridden field by field. */
export function heartbeatBody(
  id: string,
  role: Role,
  hostname: string,
  over: BodyOptions = {}
): HeartbeatBody {
  const { cpu, memory, disk, sync, agent, ...rest } = over;
  return {
    capabilities: [],
    revision: null,
    bootId: `boot-${id.slice(0, 8)}`,
    uptimeSeconds: 86400,
    kernel: '6.12.30',
    arch: 'x86_64',
    load1: 0.4,
    addresses: ['192.168.1.20'],
    failedUnits: [],
    runners: null,
    events: [],
    ...rest,
    v: 1,
    nodeId: id,
    role,
    hostname,
    cpu: { cores: 8, model: 'AMD Ryzen 7 7840U', ...cpu },
    memory: { totalMiB: 32000, availableMiB: 20000, ...memory },
    disk: { nixUsedPercent: 40, bootUsedPercent: 12, ...disk },
    sync: { rolledBack: false, healthFailure: null, paused: false, ...sync },
    agent: { version: '1', configRevision: null, ...agent },
  };
}

export interface NodeOptions {
  readonly short: string;
  readonly role?: Role;
  readonly hostname?: string;
  readonly approval?: NodeRow['approval'];
  readonly displayName?: string | null;
  readonly note?: string | null;
  readonly labels?: readonly string[];
  readonly lastSeenAt?: Date | null;
  readonly firstSeenAt?: Date;
  readonly enrolledVia?: EnrolledVia;
  readonly body?: BodyOptions;
  readonly intervalSeconds?: number;
}

/** A stored node row built from a heartbeat body, for tests and the demo. */
export function nodeRow(options: NodeOptions): NodeRow {
  const {
    short,
    role = 'ci',
    body: bodyOptions,
    intervalSeconds = 60,
    hostname: hostnameOption,
    approval = 'approved',
    ...direct
  } = options;
  const id = nodeId(short);
  const hostname = hostnameOption ?? `${role}-${short}`;
  const body = heartbeatBody(id, role, hostname, bodyOptions);
  return {
    displayName: null,
    note: null,
    labels: [],
    enrolledVia: 'role-token',
    firstSeenAt: new Date('2026-09-01T08:00:00.000Z'),
    lastSeenAt: null,
    heartbeatIntervalSeconds: intervalSeconds,
    ...direct,
    id,
    role,
    hostname,
    approval,
    facts: body as unknown as Record<string, unknown>,
    revision: body.revision,
    agentVersion: body.agent.version,
    configRevision: body.agent.configRevision,
    remoteAddr: '192.168.1.20',
    approvedAt:
      approval === 'approved' ? new Date('2026-09-01T08:05:00.000Z') : null,
    approvedBy: approval === 'approved' ? 'chris' : null,
    retiredAt:
      approval === 'retired' ? new Date('2026-10-01T08:05:00.000Z') : null,
    offlineNotifiedAt: null,
  };
}

/** A point per `stepSeconds` for `hours`, ending at `end`, shaped by `shape(0..1)`. */
export function historyPoints(
  end: Date,
  hours: number,
  stepSeconds: number,
  shape: (progress: number, index: number) => Partial<HeartbeatPoint>
): HeartbeatPoint[] {
  const count = Math.floor((hours * 3600) / stepSeconds);
  const points: HeartbeatPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const at = new Date(end.getTime() - (count - index) * stepSeconds * 1000);
    points.push({
      at,
      uptimeSeconds: null,
      load1: null,
      memUsedPercent: null,
      diskPercent: null,
      slots: null,
      busySlots: null,
      ...shape(index / count, index),
    });
  }
  return points;
}
