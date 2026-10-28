import type {
  ConnectivityFamily,
  CpuFrequencyFamily,
  DiskHealthFamily,
  DiskHealthState,
  DiskIoFamily,
  FamilyBase,
  GpuSample,
  GpusFamily,
  HealthTelemetry,
  LifecycleSample,
  PressureFamily,
  PressureSample,
  Provenance,
  ThrottlingFamily,
} from '../telemetry';
import {
  isRecord,
  readNumber,
  readString,
  type Problems,
} from './heartbeat-fields';
import { count, entries, label, timestamp, unique } from './telemetry-fields';

/** Small, fixed caps on top of the 64 KiB request limit. */
export const HEALTH_LIMITS = {
  gpus: 8,
  diskIo: 16,
  diskHealth: 8,
} as const;

const CLEAN = /^[^\u0000-\u001f\u007f]*$/;
const NO_REASON = 'The node did not say why this is unsupported.';
type Item = Record<string, unknown>;

function isProvenance(value: unknown): value is Provenance {
  return (
    value === 'measured' || value === 'estimated' || value === 'unsupported'
  );
}

/** A number inside [min, max], or null when absent. Never a default zero. */
function num(
  p: Problems,
  path: string,
  value: unknown,
  range: readonly [number, number]
): number | null {
  return readNumber(p, path, value, { min: range[0], max: range[1] });
}

function whole(p: Problems, path: string, value: unknown): number | null {
  return readNumber(p, path, value, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
}

function family<T extends object>(
  p: Problems,
  path: string,
  options: { raw: unknown; read: (item: Item, at: string) => T }
): (FamilyBase & T) | undefined {
  const { raw, read } = options;
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    p.list.push(`${path} must be an object`);
    return undefined;
  }
  const status = raw['status'];
  if (!isProvenance(status))
    p.list.push(`${path}.status must be measured, estimated or unsupported`);
  const reason = readString(p, `${path}.reason`, raw['reason'], {
    max: 500,
    pattern: CLEAN,
  });
  const resolved = isProvenance(status) ? status : 'unsupported';
  return {
    status: resolved,
    reason: reason ?? (resolved === 'unsupported' ? NO_REASON : null),
    ...read(raw, path),
  };
}

function vendorOf(
  p: Problems,
  path: string,
  value: unknown
): GpuSample['vendor'] {
  if (value === 'nvidia' || value === 'amd' || value === 'intel') return value;
  p.list.push(`${path} must be nvidia, amd or intel`);
  return 'nvidia';
}

function gpus(p: Problems, raw: unknown): GpusFamily | undefined {
  return family(p, 'telemetry.gpus', {
    raw,
    read: (item, path) => {
      const devices = entries(
        p,
        `${path}.devices`,
        { value: item['devices'], limit: HEALTH_LIMITS.gpus },
        (device, at) => {
          const used = whole(
            p,
            `${at}.memoryUsedBytes`,
            device['memoryUsedBytes']
          );
          const total = whole(
            p,
            `${at}.memoryTotalBytes`,
            device['memoryTotalBytes']
          );
          if (used !== null && total !== null && used > total)
            p.list.push(`${at} memory use must fit within total`);
          return {
            name: label(p, `${at}.name`, device['name']),
            vendor: vendorOf(p, `${at}.vendor`, device['vendor']),
            utilizationPercent: num(
              p,
              `${at}.utilizationPercent`,
              device['utilizationPercent'],
              [0, 100]
            ),
            memoryUsedBytes: used,
            memoryTotalBytes: total,
            temperatureCelsius: num(
              p,
              `${at}.temperatureCelsius`,
              device['temperatureCelsius'],
              [-100, 250]
            ),
            powerWatts: num(
              p,
              `${at}.powerWatts`,
              device['powerWatts'],
              [0, 10_000]
            ),
          };
        }
      );
      unique(
        p,
        `${path}.devices`,
        devices.map((device) => device.name)
      );
      return { devices };
    },
  });
}

function diskIo(p: Problems, raw: unknown): DiskIoFamily | undefined {
  return family(p, 'telemetry.diskIo', {
    raw,
    read: (item, path) => {
      const devices = entries(
        p,
        `${path}.devices`,
        { value: item['devices'], limit: HEALTH_LIMITS.diskIo },
        (device, at) => ({
          name: label(p, `${at}.name`, device['name']),
          readBytesPerSecond: num(
            p,
            `${at}.readBytesPerSecond`,
            device['readBytesPerSecond'],
            [0, 1e15]
          ),
          writeBytesPerSecond: num(
            p,
            `${at}.writeBytesPerSecond`,
            device['writeBytesPerSecond'],
            [0, 1e15]
          ),
          iops: num(p, `${at}.iops`, device['iops'], [0, 1e12]),
          busyPercent: num(
            p,
            `${at}.busyPercent`,
            device['busyPercent'],
            [0, 100]
          ),
        })
      );
      unique(
        p,
        `${path}.devices`,
        devices.map((device) => device.name)
      );
      return { devices };
    },
  });
}

function healthState(
  p: Problems,
  path: string,
  value: unknown
): DiskHealthState {
  if (
    value === 'ok' ||
    value === 'warning' ||
    value === 'failing' ||
    value === 'unknown'
  )
    return value;
  p.list.push(`${path} must be ok, warning, failing or unknown`);
  return 'unknown';
}

function diskHealth(p: Problems, raw: unknown): DiskHealthFamily | undefined {
  return family(p, 'telemetry.diskHealth', {
    raw,
    read: (item, path) => {
      const devices = entries(
        p,
        `${path}.devices`,
        { value: item['devices'], limit: HEALTH_LIMITS.diskHealth },
        (device, at) => {
          if (device['source'] !== 'smartctl' && device['source'] !== 'sysfs')
            p.list.push(`${at}.source must be smartctl or sysfs`);
          return {
            name: label(p, `${at}.name`, device['name']),
            state: healthState(p, `${at}.state`, device['state']),
            source:
              device['source'] === 'sysfs'
                ? ('sysfs' as const)
                : ('smartctl' as const),
            temperatureCelsius: num(
              p,
              `${at}.temperatureCelsius`,
              device['temperatureCelsius'],
              [-100, 250]
            ),
            wearPercent: num(
              p,
              `${at}.wearPercent`,
              device['wearPercent'],
              [0, 255]
            ),
            powerOnHours: whole(
              p,
              `${at}.powerOnHours`,
              device['powerOnHours']
            ),
            detail: readString(p, `${at}.detail`, device['detail'], {
              max: 200,
              pattern: CLEAN,
            }),
          };
        }
      );
      unique(
        p,
        `${path}.devices`,
        devices.map((device) => device.name)
      );
      return { devices };
    },
  });
}

function cpuFrequency(
  p: Problems,
  raw: unknown
): CpuFrequencyFamily | undefined {
  return family(p, 'telemetry.cpuFrequency', {
    raw,
    read: (item, path) => ({
      currentMHz: num(p, `${path}.currentMHz`, item['currentMHz'], [0, 20_000]),
      minMHz: num(p, `${path}.minMHz`, item['minMHz'], [0, 20_000]),
      maxMHz: num(p, `${path}.maxMHz`, item['maxMHz'], [0, 20_000]),
    }),
  });
}

function nullableBoolean(
  p: Problems,
  path: string,
  value: unknown
): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value !== null && value !== undefined)
    p.list.push(`${path} must be a boolean or null`);
  return null;
}

function basisOf(
  p: Problems,
  path: string,
  value: unknown
): ThrottlingFamily['basis'] {
  if (value === 'thermal_throttle' || value === 'frequency') return value;
  if (value !== null && value !== undefined)
    p.list.push(`${path} must be thermal_throttle, frequency or null`);
  return null;
}

function throttling(p: Problems, raw: unknown): ThrottlingFamily | undefined {
  return family(p, 'telemetry.throttling', {
    raw,
    read: (item, path) => ({
      throttled: nullableBoolean(p, `${path}.throttled`, item['throttled']),
      events: whole(p, `${path}.events`, item['events']),
      basis: basisOf(p, `${path}.basis`, item['basis']),
    }),
  });
}

function pressureLine(
  p: Problems,
  path: string,
  raw: unknown
): PressureSample | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    p.list.push(`${path} must be an object or null`);
    return null;
  }
  const read = (key: string) => num(p, `${path}.${key}`, raw[key], [0, 100]);
  return {
    someAvg10: read('someAvg10'),
    someAvg60: read('someAvg60'),
    fullAvg10: read('fullAvg10'),
    fullAvg60: read('fullAvg60'),
  };
}

function pressure(p: Problems, raw: unknown): PressureFamily | undefined {
  return family(p, 'telemetry.pressure', {
    raw,
    read: (item, path) => ({
      cpu: pressureLine(p, `${path}.cpu`, item['cpu']),
      memory: pressureLine(p, `${path}.memory`, item['memory']),
      io: pressureLine(p, `${path}.io`, item['io']),
    }),
  });
}

function connectivity(
  p: Problems,
  raw: unknown
): ConnectivityFamily | undefined {
  return family(p, 'telemetry.connectivity', {
    raw,
    read: (item, path) => ({
      controllerLatencyMs: num(
        p,
        `${path}.controllerLatencyMs`,
        item['controllerLatencyMs'],
        [0, 3_600_000]
      ),
      consecutiveFailures: readNumber(
        p,
        `${path}.consecutiveFailures`,
        item['consecutiveFailures'],
        {
          min: 0,
          max: 1_000_000,
          integer: true,
        }
      ),
    }),
  });
}

function lifecycle(p: Problems, raw: unknown): LifecycleSample | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    p.list.push('telemetry.lifecycle must be an object');
    return undefined;
  }
  const uptime = raw['uptimeSeconds'];
  const restarts = raw['restartCount'];
  return {
    uptimeSeconds:
      uptime === null || uptime === undefined
        ? null
        : count(p, 'telemetry.lifecycle.uptimeSeconds', uptime),
    restartCount:
      restarts === null || restarts === undefined
        ? null
        : count(p, 'telemetry.lifecycle.restartCount', restarts),
    trackedSince: timestamp(
      p,
      'telemetry.lifecycle.trackedSince',
      raw['trackedSince'],
      true
    ),
  };
}

function hardwareFamilies(p: Problems, raw: Item): HealthTelemetry {
  const found = {
    gpus: gpus(p, raw['gpus']),
    diskIo: diskIo(p, raw['diskIo']),
    diskHealth: diskHealth(p, raw['diskHealth']),
    cpuFrequency: cpuFrequency(p, raw['cpuFrequency']),
  };
  return {
    ...(found.gpus ? { gpus: found.gpus } : {}),
    ...(found.diskIo ? { diskIo: found.diskIo } : {}),
    ...(found.diskHealth ? { diskHealth: found.diskHealth } : {}),
    ...(found.cpuFrequency ? { cpuFrequency: found.cpuFrequency } : {}),
  };
}

function systemFamilies(p: Problems, raw: Item): HealthTelemetry {
  const found = {
    throttling: throttling(p, raw['throttling']),
    pressure: pressure(p, raw['pressure']),
    connectivity: connectivity(p, raw['connectivity']),
    lifecycle: lifecycle(p, raw['lifecycle']),
  };
  return {
    ...(found.throttling ? { throttling: found.throttling } : {}),
    ...(found.pressure ? { pressure: found.pressure } : {}),
    ...(found.connectivity ? { connectivity: found.connectivity } : {}),
    ...(found.lifecycle ? { lifecycle: found.lifecycle } : {}),
  };
}

/** The optional health families. Unknown keys are discarded; absent stays absent. */
export function healthFamilies(p: Problems, raw: Item): HealthTelemetry {
  return { ...hardwareFamilies(p, raw), ...systemFamilies(p, raw) };
}
