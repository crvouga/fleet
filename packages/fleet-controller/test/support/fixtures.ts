import { createHash } from 'node:crypto';

import type { RegisterInput } from '../../src/store';
import type { HeartbeatBody, Role } from '../../src/types';

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** A deterministic 64-hex node id for a small integer. */
export const nodeIdOf = (n: number): string => sha256(`node-${n}`);
export const secretOf = (n: number): string => sha256(`secret-${n}`);

export const T0 = new Date('2026-10-14T12:00:00.000Z');
export const at = (seconds: number, base: Date = T0): Date =>
  new Date(base.getTime() + seconds * 1000);

export function registerInput(
  n: number,
  overrides: Partial<RegisterInput> = {}
): RegisterInput {
  const id = nodeIdOf(n);
  return {
    id,
    role: 'ci',
    hostname: `ci-${id.slice(0, 4)}`,
    secretHash: sha256(secretOf(n)),
    approval: 'pending',
    enrolledVia: 'hello',
    remoteAddr: '203.0.113.7',
    ...overrides,
  };
}

type Nested = 'cpu' | 'memory' | 'disk' | 'sync' | 'agent';
export type HeartbeatOverrides = Partial<Omit<HeartbeatBody, Nested>> & {
  cpu?: Partial<HeartbeatBody['cpu']>;
  memory?: Partial<HeartbeatBody['memory']>;
  disk?: Partial<HeartbeatBody['disk']>;
  sync?: Partial<HeartbeatBody['sync']>;
  agent?: Partial<HeartbeatBody['agent']>;
};

export function heartbeatBody(
  n: number,
  overrides: HeartbeatOverrides = {}
): HeartbeatBody {
  const id = nodeIdOf(n);
  const base: HeartbeatBody = {
    v: 1,
    nodeId: id,
    role: 'ci' as Role,
    hostname: `ci-${id.slice(0, 4)}`,
    capabilities: ['gpu'],
    revision: '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283',
    bootId: 'boot-1',
    uptimeSeconds: 86_400,
    kernel: '6.12.30',
    arch: 'x86_64',
    cpu: { cores: 16, model: 'AMD Ryzen 9' },
    memory: { totalMiB: 64_000, availableMiB: 16_000 },
    load1: 0.42,
    disk: { nixUsedPercent: 37, bootUsedPercent: 12 },
    addresses: ['192.168.1.20'],
    sync: { rolledBack: false, healthFailure: null, paused: false },
    failedUnits: [],
    runners: { slots: 4, busy: 1 },
    agent: { version: '1', configRevision: null },
    events: [],
  };
  const { cpu, memory, disk, sync, agent, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    cpu: { ...base.cpu, ...cpu },
    memory: { ...base.memory, ...memory },
    disk: { ...base.disk, ...disk },
    sync: { ...base.sync, ...sync },
    agent: { ...base.agent, ...agent },
  };
}
