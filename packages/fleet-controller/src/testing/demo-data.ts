import { desiredFor } from '../domain/desired-state';
import { effectiveConfig } from '../domain/effective-config';
import type { HeartbeatPoint, Role } from '../types';
import {
  heartbeatBody,
  historyPoints,
  nodeId,
  nodeRow,
  type BodyOptions,
  type NodeOptions,
} from './fixtures';
import type { MemoryStore } from './memory-store';

const LATEST = '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283';
const OLD = '7a1b3c4d5e6f708192a3b4c5d6e7f80910213243';
const OLDER = '3d4e5f60718293a4b5c6d7e8f9091a2b3c4d5e6f';

export const DEMO_LATEST = LATEST;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Spec {
  readonly short: string;
  /** The assigned role; null for a machine nobody assigned yet. */
  readonly role: Role | null;
  /** Minutes since the last report; null for never. */
  readonly seenMinutes: number | null;
  readonly options?: Partial<NodeOptions>;
  readonly body?: BodyOptions;
  /** Hours of history to generate, ending when the node last reported. */
  readonly history?: number;
  readonly wave?: { load: number; mem: number; disk: number };
}

const GIB = 1024;

function wave(
  seed: number,
  progress: number,
  base: number,
  amp: number
): number {
  const v =
    base +
    amp * Math.sin(progress * Math.PI * 6 + seed) +
    (amp / 3) * Math.sin(progress * 41 + seed * 2);
  return Math.max(0, v);
}

const SPECS: readonly Spec[] = [
  {
    short: 'a3f9',
    role: 'ci',
    seenMinutes: 0.2,
    options: { labels: ['high-mem', 'rack-2'], displayName: 'Build 1' },
    body: {
      revision: LATEST,
      reconcile: { phase: 'converged', issues: [] },
      ageRecipient: 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      capabilities: ['high-mem'],
      cpu: { cores: 32, model: 'AMD Ryzen 9 9955HX' },
      memory: { totalMiB: 128 * GIB, availableMiB: 62 * GIB },
      load1: 11.4,
      uptimeSeconds: 6 * 86400 + 4000,
      runners: { slots: 6, busy: 4 },
      disk: { nixUsedPercent: 61, bootUsedPercent: 14 },
    },
    history: 24,
    wave: { load: 10, mem: 48, disk: 60 },
  },
  {
    short: 'b21c',
    role: 'ci',
    seenMinutes: 0.5,
    options: { labels: ['gpu', 'rack-2'] },
    body: {
      revision: LATEST,
      closure: 'ci-gpu',
      hardware: { capabilities: ['gpu'] },
      reconcile: { phase: 'converged', issues: [] },
      ageRecipient: 'age1pppppppppppppppppppppppppppppppppppppppppppppppppppppppppp',
      capabilities: ['gpu'],
      cpu: { cores: 16, model: 'AMD Ryzen 7 7840U' },
      memory: { totalMiB: 64 * GIB, availableMiB: 21 * GIB },
      load1: 5.2,
      uptimeSeconds: 2 * 86400,
      runners: { slots: 4, busy: 2 },
      disk: { nixUsedPercent: 47, bootUsedPercent: 12 },
    },
    history: 24,
    wave: { load: 5, mem: 66, disk: 46 },
  },
  {
    short: 'c7d2',
    role: 'ci',
    seenMinutes: 4,
    body: {
      revision: OLD,
      reconcile: { phase: 'progressing', issues: [] },
      cpu: { cores: 12, model: 'Intel Core i7-12700' },
      memory: { totalMiB: 32 * GIB, availableMiB: 9 * GIB },
      load1: 7.9,
      uptimeSeconds: 13 * 3600,
      runners: { slots: 3, busy: 3 },
      disk: { nixUsedPercent: 72, bootUsedPercent: 20 },
    },
    history: 24,
    wave: { load: 7, mem: 70, disk: 71 },
  },
  {
    short: 'd018',
    role: 'ci',
    seenMinutes: 190,
    options: { note: 'Moved to the garage. Power strip may be tripping.' },
    body: {
      revision: OLD,
      cpu: { cores: 8, model: 'Intel Core i5-10400' },
      memory: { totalMiB: 16 * GIB, availableMiB: 8 * GIB },
      load1: 0.1,
      uptimeSeconds: 30 * 86400,
      runners: { slots: 2, busy: 0 },
      disk: { nixUsedPercent: 38, bootUsedPercent: 9 },
    },
    history: 24,
    wave: { load: 1, mem: 40, disk: 38 },
  },
  {
    short: 'e5a0',
    role: 'ci',
    seenMinutes: 1,
    options: { labels: ['canary'] },
    body: {
      revision: OLDER,
      cpu: { cores: 16, model: 'AMD Ryzen 7 7700' },
      memory: { totalMiB: 64 * GIB, availableMiB: 40 * GIB },
      load1: 2.1,
      uptimeSeconds: 5400,
      sync: {
        rolledBack: true,
        healthFailure:
          'github-runner@1.service did not become healthy within 120 s',
      },
      runners: { slots: 4, busy: 0 },
      disk: { nixUsedPercent: 52, bootUsedPercent: 12 },
    },
    history: 24,
    wave: { load: 2, mem: 38, disk: 52 },
  },
  {
    short: '1a2b',
    role: 'web',
    seenMinutes: 0.4,
    options: { labels: ['edge'] },
    body: {
      revision: LATEST,
      cpu: { cores: 4, model: 'Intel N100' },
      memory: { totalMiB: 16 * GIB, availableMiB: 12 * GIB },
      load1: 0.3,
      uptimeSeconds: 41 * 86400,
      disk: { nixUsedPercent: 33, bootUsedPercent: 8 },
      addresses: ['192.168.1.31', 'fd7a:115c::31'],
    },
    history: 24,
    wave: { load: 0.4, mem: 25, disk: 33 },
  },
  {
    short: '2c3d',
    role: 'web',
    seenMinutes: 0.7,
    body: {
      revision: LATEST,
      cpu: { cores: 4, model: 'Intel N100' },
      memory: { totalMiB: 16 * GIB, availableMiB: 5 * GIB },
      load1: 0.9,
      uptimeSeconds: 19 * 86400,
      disk: { nixUsedPercent: 93, bootUsedPercent: 31 },
    },
    history: 24,
    wave: { load: 0.8, mem: 68, disk: 92 },
  },
  {
    short: '3e4f',
    role: 'web',
    seenMinutes: 0.3,
    body: {
      revision: LATEST,
      cpu: { cores: 4, model: 'Intel N100' },
      memory: { totalMiB: 16 * GIB, availableMiB: 11 * GIB },
      load1: 0.5,
      uptimeSeconds: 3 * 86400,
      failedUnits: ['caddy.service', 'fleet-backup.service'],
      disk: { nixUsedPercent: 44, bootUsedPercent: 9 },
    },
    history: 24,
    wave: { load: 0.5, mem: 31, disk: 44 },
  },
  {
    short: '7f10',
    role: 'cache',
    seenMinutes: 0.6,
    options: { labels: ['attic'] },
    body: {
      revision: LATEST,
      cpu: { cores: 8, model: 'AMD Ryzen 5 5600' },
      memory: { totalMiB: 32 * GIB, availableMiB: 14 * GIB },
      load1: 1.4,
      uptimeSeconds: 88 * 86400,
      disk: { nixUsedPercent: 79, bootUsedPercent: 10 },
    },
    history: 24,
    wave: { load: 1.2, mem: 55, disk: 78 },
  },
  {
    short: '80aa',
    role: 'cache',
    seenMinutes: 0.9,
    body: {
      revision: OLD,
      cpu: { cores: 8, model: 'AMD Ryzen 5 5600' },
      memory: { totalMiB: 32 * GIB, availableMiB: 18 * GIB },
      load1: 0.6,
      uptimeSeconds: 9 * 86400,
      disk: { nixUsedPercent: 55, bootUsedPercent: 10 },
    },
    history: 24,
    wave: { load: 0.7, mem: 42, disk: 55 },
  },
  {
    short: '4d5e',
    role: 'netboot',
    seenMinutes: 0.5,
    body: {
      revision: LATEST,
      cpu: { cores: 2, model: 'Intel Celeron J4125' },
      memory: { totalMiB: 8 * GIB, availableMiB: 6 * GIB },
      load1: 0.05,
      uptimeSeconds: 120 * 86400,
      disk: { nixUsedPercent: 21, bootUsedPercent: 6 },
    },
    history: 24,
    wave: { load: 0.1, mem: 22, disk: 21 },
  },
  {
    short: '9b9b',
    role: 'devbox',
    seenMinutes: 2,
    options: {
      displayName: 'Developer desktop',
      labels: ['gpu', 'windows-dualboot'],
    },
    body: {
      revision: OLD,
      hardware: { capabilities: ['gpu'] },
      ageRecipient: 'age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      reconcile: {
        phase: 'blocked',
        issues: [
          'FLEET_SECRETS_RECIPIENT_MISSING: age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz is not a recipient of secrets/devbox.yaml at 7a1b3c4',
        ],
      },
      capabilities: ['gpu'],
      cpu: { cores: 24, model: 'AMD Ryzen 9 7950X' },
      memory: { totalMiB: 96 * GIB, availableMiB: 51 * GIB },
      load1: 3.3,
      uptimeSeconds: 7 * 3600,
      disk: { nixUsedPercent: 58, bootUsedPercent: 18 },
    },
    history: 24,
    wave: { load: 3, mem: 45, disk: 58 },
  },
  {
    short: '0b5e',
    role: null,
    seenMinutes: 1,
    options: { labels: ['spare'] },
    body: {
      revision: LATEST,
      hardware: { capabilities: [] },
      reconcile: { phase: 'converged', issues: [] },
      ageRecipient: 'age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      cpu: { cores: 8, model: 'Intel Core i5-1240P' },
      memory: { totalMiB: 32 * GIB, availableMiB: 29 * GIB },
      load1: 0.1,
      uptimeSeconds: 3 * 3600,
    },
    history: 6,
    wave: { load: 0.2, mem: 10, disk: 15 },
  },
  {
    short: 'f001',
    role: null,
    seenMinutes: 12,
    options: { approval: 'pending', enrolledVia: 'hello' },
    body: {
      revision: LATEST,
      hardware: { capabilities: ['gpu'] },
      cpu: { cores: 16, model: 'AMD Ryzen 7 7840U' },
      memory: { totalMiB: 64 * GIB, availableMiB: 60 * GIB },
      load1: 0.2,
      uptimeSeconds: 700,
      kernel: '6.12.30',
    },
  },
  {
    short: 'f002',
    role: null,
    seenMinutes: 55,
    options: { approval: 'pending', enrolledVia: 'hello' },
    body: {
      revision: LATEST,
      cpu: { cores: 4, model: 'Intel N100' },
      memory: { totalMiB: 16 * GIB, availableMiB: 14 * GIB },
      load1: 0.1,
      uptimeSeconds: 2000,
    },
  },
  {
    short: 'dead',
    role: 'devbox',
    seenMinutes: 6 * 24 * 60,
    options: { approval: 'retired', labels: ['old-laptop'] },
    body: {
      revision: OLDER,
      cpu: { cores: 4, model: 'Intel Core i5-8250U' },
      memory: { totalMiB: 16 * GIB, availableMiB: 9 * GIB },
    },
  },
];

function history(spec: Spec, seed: number, now: Date): HeartbeatPoint[] {
  if (spec.history === undefined || spec.seenMinutes === null) return [];
  const end = new Date(now.getTime() - spec.seenMinutes * MIN);
  const shape = spec.wave ?? { load: 1, mem: 40, disk: 40 };
  const runners = spec.body?.runners ?? null;
  const uptimeEnd = spec.body?.uptimeSeconds ?? 86400;
  const stepSeconds = 300;
  const hours = spec.history;
  const all = historyPoints(end, hours, stepSeconds, (progress) => ({
    uptimeSeconds: uptimeEnd - Math.round((1 - progress) * hours * 3600),
    load1:
      Math.round(wave(seed, progress, shape.load, shape.load * 0.5) * 100) /
      100,
    memUsedPercent: Math.min(
      98,
      Math.round(wave(seed + 1, progress, shape.mem, 6))
    ),
    diskPercent: Math.min(99, Math.round(shape.disk + progress * 2)),
    slots: runners?.slots ?? null,
    busySlots:
      runners === null
        ? null
        : Math.round(
            Math.min(
              runners.slots,
              wave(seed + 2, progress, runners.slots / 2, runners.slots / 2.2)
            )
          ),
  }));
  // A short outage on the busiest build box, to make the strip interesting.
  return all.filter(
    (point) =>
      !(
        spec.short === 'a3f9' &&
        point.at.getTime() > now.getTime() - 9 * HOUR &&
        point.at.getTime() < now.getTime() - 8 * HOUR
      )
  );
}

function seedNodes(store: MemoryStore, now: Date): void {
  SPECS.forEach((spec, index) => {
    const lastSeenAt =
      spec.seenMinutes === null
        ? null
        : new Date(now.getTime() - spec.seenMinutes * MIN);
    const row = nodeRow({
      short: spec.short,
      role: spec.role,
      lastSeenAt,
      firstSeenAt: new Date(now.getTime() - (10 + index * 3) * DAY),
      ...spec.options,
      ...(spec.body === undefined ? {} : { body: spec.body }),
    });
    store.seedNode(
      { ...row, agentVersion: '2', appliedRevision: 'a1b2c3d4e5f60718' },
      history(spec, index * 1.7, now)
    );
  });
}

type Severity = 'info' | 'warn' | 'error';
/** short id, label, kind, severity, message, minutes ago */
type EventSpec = readonly [string, string, string, Severity, string, number];

const EVENT_SPECS: readonly EventSpec[] = [
  [
    'd018',
    'ci-d018',
    'offline',
    'error',
    'ci-d018 has not reported for 5 minutes',
    185,
  ],
  [
    'e5a0',
    'ci-e5a0',
    'rollback',
    'error',
    'Update failed its health check; rolled back to the previous system',
    80,
  ],
  [
    '3e4f',
    'web-3e4f',
    'unit-failed',
    'error',
    'caddy.service entered a failed state',
    55,
  ],
  [
    '2c3d',
    'web-2c3d',
    'disk',
    'warn',
    'Nix store is 93% full (alert at 90%)',
    130,
  ],
  [
    'c7d2',
    'ci-c7d2',
    'recovered',
    'info',
    'ci-c7d2 is reporting again after 14 minutes',
    300,
  ],
  ['a3f9', 'Build 1', 'boot', 'info', 'node started', 6 * 1440],
  [
    'f001',
    'node-f001',
    'registered',
    'info',
    'node-f001 registered as pending',
    12,
  ],
  [
    'f002',
    'node-f002',
    'registered',
    'info',
    'node-f002 registered as pending',
    55,
  ],
  [
    'dead',
    'devbox-dead',
    'retired',
    'info',
    'operator marked devbox-dead retired',
    6 * 1440,
  ],
  ['7f10', 'cache-7f10', 'disk', 'warn', 'Nix store is 79% full', 1440],
  [
    'c7d2',
    'ci-c7d2',
    'offline',
    'error',
    'ci-c7d2 has not reported for 5 minutes',
    314,
  ],
  [
    '80aa',
    'cache-80aa',
    'revision',
    'warn',
    'Running an older revision than main for 2 days',
    2880,
  ],
  ...Array.from({ length: 30 }, (_, i): EventSpec => [
    '9b9b',
    'Developer desktop',
    'sync',
    'info',
    `Applied update ${i + 1}`,
    3000 + i * 240,
  ]),
];

function seedEvents(store: MemoryStore, now: Date): void {
  // Oldest first, so ids grow with time like a real log.
  const ordered = [...EVENT_SPECS].sort((a, b) => b[5] - a[5]);
  for (const [short, label, kind, severity, message, minutes] of ordered) {
    store.seedEvent(
      { nodeId: nodeId(short), nodeLabel: label, kind, severity, message },
      new Date(now.getTime() - minutes * MIN)
    );
  }
}

function seedSettings(
  store: MemoryStore,
  now: Date,
  setClock: (at: Date) => void
): void {
  const put = async (
    scope: Parameters<MemoryStore['putSettings']>[0],
    value: Parameters<MemoryStore['putSettings']>[1],
    actor: string,
    daysAgo: number
  ) => {
    setClock(new Date(now.getTime() - daysAgo * DAY));
    await store.putSettings(scope, value, actor);
  };
  void (async () => {
    await put('fleet', { heartbeat: { intervalSeconds: 60 } }, 'operator', 9);
    await put(
      'fleet',
      {
        heartbeat: { intervalSeconds: 60 },
        disk: { alertPercent: 90 },
        alerts: {
          offlineAfterSeconds: 300,
          webhookUrl:
            'https://hooks.slack.example.com/services/T000/B000/hunter2',
        },
      },
      'operator',
      4
    );
    await put(
      'role:ci',
      {
        capacity: { slotMax: 8 },
        runners: {
          enabled: true,
          repositories: ['example/fleet', 'example/application'],
          extraLabels: ['team-infra'],
        },
      },
      'operator',
      2
    );
    await put(
      'role:ci',
      {
        capacity: { slotMax: 8, perRunnerGiB: 8 },
        runners: {
          enabled: true,
          repositories: ['example/fleet', 'example/application'],
          extraLabels: ['team-infra'],
        },
      },
      'dana',
      1
    );
    await put(
      `node:${nodeId('a3f9')}`,
      { capacity: { slotMax: 6 }, reboot: { enabled: false } },
      'operator',
      0.5
    );
    setClock(now);
    await acknowledgeConverged(store);
  })();
}

/** Nodes that say they converged acknowledged the desired document they were sent. */
async function acknowledgeConverged(store: MemoryStore): Promise<void> {
  const settings = await store.listSettings();
  for (const row of await store.listNodes()) {
    if (row.reconcile?.phase !== 'converged') continue;
    const desired = desiredFor(row, effectiveConfig(settings, row));
    store.updateSeeded(row.id, { appliedRevision: desired.revision });
  }
}

/** About 14 nodes, 24 h of history, events and settings: enough to judge the design. */
export function seedDemo(
  store: MemoryStore,
  now: Date,
  setClock: (at: Date) => void
): void {
  seedNodes(store, now);
  seedEvents(store, now);
  seedSettings(store, now, setClock);
}

export { heartbeatBody };
