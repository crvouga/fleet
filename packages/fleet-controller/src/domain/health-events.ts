import type { Telemetry } from '../telemetry';
import { telemetryOf } from './telemetry-validation';
import type { HeartbeatBody, NodeRow, Severity } from '../types';

import type { DerivedEvent } from './heartbeat-events';

/**
 * Fixed thresholds for the health signals the agent now reports. They are
 * constants, not settings: an operator who needs different limits can read the
 * raw values in the metrics. Each condition raises one event when it begins and
 * one when it ends, like the other derived events (an unchanged condition is
 * announced once, never per report).
 */
export const HEALTH_THRESHOLDS = {
  /** GPU die temperature, in degrees Celsius, at or above which gpu_hot is raised. */
  gpuHotCelsius: 85,
  /** Memory pressure: PSI "some" 60 s average (percent of time stalled). */
  memorySomeAvg60Percent: 40,
  /** Memory pressure: PSI "full" 60 s average. */
  memoryFullAvg60Percent: 10,
} as const;

export const HEALTH_EVENT_KINDS = [
  'disk_health_degraded',
  'disk_health_ok',
  'gpu_hot',
  'gpu_ok',
  'throttling',
  'throttling_ok',
  'memory_pressure_high',
  'memory_pressure_ok',
] as const;

/** One tri-state reading: bad, fine, or unknown (older agent, unsupported, no sample). */
interface Reading {
  readonly bad: boolean;
  /** 0 fine, 1 warning, 2 failing: lets a worsening condition raise its event again. */
  readonly level: number;
  readonly detail: string;
}
type Judge = (sample: Telemetry) => Reading | null;
const FINE: Reading = { bad: false, level: 0, detail: '' };

function diskHealth(sample: Telemetry): Reading | null {
  const family = sample.diskHealth;
  if (!family || family.status === 'unsupported') return null;
  const known = family.devices.filter((device) => device.state !== 'unknown');
  if (known.length === 0) return null;
  const worrying = known.filter((device) => device.state !== 'ok');
  if (worrying.length === 0) return FINE;
  const failing = worrying.some((device) => device.state === 'failing');
  return {
    bad: true,
    level: failing ? 2 : 1,
    detail: worrying
      .slice(0, 4)
      .map((device) => `${device.name} ${device.state}`)
      .join(', '),
  };
}

function gpuHot(sample: Telemetry): Reading | null {
  const family = sample.gpus;
  if (!family || family.status === 'unsupported') return null;
  const hottest = family.devices.flatMap((device) =>
    device.temperatureCelsius === null
      ? []
      : [{ name: device.name, celsius: device.temperatureCelsius }]
  );
  if (hottest.length === 0) return null;
  const top = hottest.reduce((a, b) => (b.celsius > a.celsius ? b : a));
  const bad = top.celsius >= HEALTH_THRESHOLDS.gpuHotCelsius;
  return {
    bad,
    level: bad ? 1 : 0,
    detail: `${top.name} at ${top.celsius} °C (alert at ${HEALTH_THRESHOLDS.gpuHotCelsius} °C)`,
  };
}

/** Only measured thermal-throttle counters raise this; frequency estimates never do. */
function throttling(sample: Telemetry): Reading | null {
  const family = sample.throttling;
  if (family?.status !== 'measured' || family.throttled === null) return null;
  return {
    bad: family.throttled,
    level: family.throttled ? 1 : 0,
    detail: 'the CPU is thermally throttled',
  };
}

function atLeast(value: number | null, limit: number): boolean {
  return value !== null && value >= limit;
}

function percent(value: number | null): string {
  return value === null ? '?' : String(value);
}

function memoryPressure(sample: Telemetry): Reading | null {
  const { pressure } = sample;
  if (!pressure || pressure.status === 'unsupported' || !pressure.memory)
    return null;
  const { someAvg60: some, fullAvg60: full } = pressure.memory;
  if (some === null && full === null) return null;
  const bad =
    atLeast(some, HEALTH_THRESHOLDS.memorySomeAvg60Percent) ||
    atLeast(full, HEALTH_THRESHOLDS.memoryFullAvg60Percent);
  return {
    bad,
    level: bad ? 1 : 0,
    detail: `tasks stalled on memory ${percent(some)}% (some) / ${percent(full)}% (full) over 60 s`,
  };
}

interface Signal {
  readonly judge: Judge;
  readonly open: { readonly kind: string; readonly severity: Severity };
  readonly close: string;
  readonly noun: string;
}

const SIGNALS: readonly Signal[] = [
  {
    judge: diskHealth,
    open: { kind: 'disk_health_degraded', severity: 'warn' },
    close: 'disk_health_ok',
    noun: 'disk health',
  },
  {
    judge: gpuHot,
    open: { kind: 'gpu_hot', severity: 'warn' },
    close: 'gpu_ok',
    noun: 'GPU temperature',
  },
  {
    judge: throttling,
    open: { kind: 'throttling', severity: 'warn' },
    close: 'throttling_ok',
    noun: 'CPU throttling',
  },
  {
    judge: memoryPressure,
    open: { kind: 'memory_pressure_high', severity: 'warn' },
    close: 'memory_pressure_ok',
    noun: 'memory pressure',
  },
];

function reportedKind(body: HeartbeatBody, kind: string): boolean {
  return body.events.some((event) => event.kind === kind);
}

function opened(signal: Signal, now: Reading): DerivedEvent {
  return {
    kind: signal.open.kind,
    // A failing disk is an error; everything else is a warning.
    severity: now.level >= 2 ? 'error' : signal.open.severity,
    message: `${signal.noun}: ${now.detail}`,
  };
}

function edge(
  signal: Signal,
  before: Reading | null,
  now: Reading | null
): DerivedEvent[] {
  if (now === null) return [];
  const wasLevel = before?.bad === true ? before.level : 0;
  if (now.bad && now.level > wasLevel) return [opened(signal, now)];
  if (!now.bad && wasLevel > 0)
    return [
      {
        kind: signal.close,
        severity: 'info',
        message: `${signal.noun} is back to normal`,
      },
    ];
  return [];
}

/**
 * Edges of the health signals between the stored report and this one. A signal
 * the agent does not report (older agent, unsupported hardware) never raises or
 * clears an event: unknown is not healthy and not unhealthy.
 */
export function healthEvents(
  prev: NodeRow,
  body: HeartbeatBody
): DerivedEvent[] {
  const sample = body.telemetry;
  if (!sample) return [];
  const before = telemetryOf(prev.facts['telemetry']);
  return SIGNALS.flatMap((signal) =>
    reportedKind(body, signal.open.kind) || reportedKind(body, signal.close)
      ? []
      : edge(
          signal,
          before === null ? null : signal.judge(before),
          signal.judge(sample)
        )
  );
}
