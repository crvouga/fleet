import type { NodeRow } from '../../types';
import type { Telemetry } from '../../telemetry';
import { telemetryOf } from '../../domain/telemetry-validation';

/** What a node last reported, read defensively from the stored JSON. */
export interface NodeFacts {
  readonly telemetry: Telemetry | null;
  readonly readinessIssues?: readonly string[] | null;
  readonly capabilities: readonly string[];
  readonly bootId: string | null;
  readonly uptimeSeconds: number | null;
  readonly kernel: string | null;
  readonly arch: string | null;
  readonly cpuCores: number | null;
  readonly cpuModel: string | null;
  readonly memTotalMiB: number | null;
  readonly memAvailableMiB: number | null;
  readonly memUsedPercent: number | null;
  readonly load1: number | null;
  readonly nixUsedPercent: number | null;
  readonly bootUsedPercent: number | null;
  readonly addresses: readonly string[];
  readonly rolledBack: boolean;
  readonly healthFailure: string | null;
  readonly paused: boolean;
  readonly failedUnits: readonly string[];
  readonly slots: number | null;
  readonly busySlots: number | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function memoryUsedPercent(
  total: number | null,
  available: number | null
): number | null {
  if (total === null || available === null || total <= 0) return null;
  return Math.min(
    100,
    Math.max(0, Math.round(((total - available) / total) * 100))
  );
}

export function readFacts(row: Pick<NodeRow, 'facts'>): NodeFacts {
  const facts = record(row.facts);
  const cpu = record(facts['cpu']);
  const memory = record(facts['memory']);
  const disk = record(facts['disk']);
  const sync = record(facts['sync']);
  const runners = record(facts['runners']);
  const total = num(memory['totalMiB']);
  const available = num(memory['availableMiB']);
  return {
    telemetry: telemetryOf(facts['telemetry']),
    readinessIssues: Array.isArray(record(facts['readiness'])['issues'])
      ? strings(record(facts['readiness'])['issues'])
      : null,
    capabilities: strings(facts['capabilities']),
    bootId: str(facts['bootId']),
    uptimeSeconds: num(facts['uptimeSeconds']),
    kernel: str(facts['kernel']),
    arch: str(facts['arch']),
    cpuCores: num(cpu['cores']),
    cpuModel: str(cpu['model']),
    memTotalMiB: total,
    memAvailableMiB: available,
    memUsedPercent: memoryUsedPercent(total, available),
    load1: num(facts['load1']),
    nixUsedPercent: num(disk['nixUsedPercent']),
    bootUsedPercent: num(disk['bootUsedPercent']),
    addresses: strings(facts['addresses']),
    rolledBack: sync['rolledBack'] === true,
    healthFailure: str(sync['healthFailure']),
    paused: sync['paused'] === true,
    failedUnits: strings(facts['failedUnits']),
    slots: num(runners['slots']),
    busySlots: num(runners['busy']),
  };
}

/** The larger of the two disk figures: the one to alert on. */
export function diskPercent(facts: NodeFacts): number | null {
  const values = [facts.nixUsedPercent, facts.bootUsedPercent].filter(
    (value): value is number => value !== null
  );
  return values.length === 0 ? null : Math.max(...values);
}
