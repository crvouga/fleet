import type { Telemetry } from '../telemetry';
import { readNumber, type Problems } from './heartbeat-fields';
import {
  count,
  entries,
  label,
  measurement,
  TELEMETRY_LIMITS,
  unique,
} from './telemetry-fields';

function filesystems(p: Problems, raw: unknown): Telemetry['filesystems'] {
  return entries(
    p,
    'telemetry.filesystems',
    { value: raw, limit: TELEMETRY_LIMITS.filesystems },
    (item, path) => {
      const totalBytes = count(p, `${path}.totalBytes`, item['totalBytes']);
      const usedBytes = count(p, `${path}.usedBytes`, item['usedBytes']);
      const availableBytes = count(
        p,
        `${path}.availableBytes`,
        item['availableBytes']
      );
      if (
        usedBytes > totalBytes ||
        availableBytes > totalBytes ||
        usedBytes + availableBytes > totalBytes
      )
        p.list.push(`${path} usage must fit within totalBytes`);
      return {
        mount: label(p, `${path}.mount`, item['mount']),
        totalBytes,
        usedBytes,
        availableBytes,
      };
    }
  );
}

function temperatures(p: Problems, raw: unknown): Telemetry['temperatures'] {
  return entries(
    p,
    'telemetry.temperatures',
    { value: raw, limit: TELEMETRY_LIMITS.temperatures },
    (item, path) => {
      const celsius = readNumber(p, `${path}.celsius`, item['celsius'], {
        min: -100,
        max: 250,
      });
      if (item['celsius'] === null || item['celsius'] === undefined)
        p.list.push(`${path}.celsius is required`);
      return {
        name: label(p, `${path}.name`, item['name']),
        celsius: celsius ?? 0,
      };
    }
  );
}

function power(p: Problems, raw: unknown): Telemetry['power'] {
  return entries(
    p,
    'telemetry.power',
    { value: raw, limit: TELEMETRY_LIMITS.power },
    (item, path) => {
      const source = item['source'];
      if (source !== 'hwmon' && source !== 'powercap')
        p.list.push(`${path}.source must be hwmon or powercap`);
      const watts = measurement(p, `${path}.watts`, item['watts'], 1_000_000);
      if (
        watts === null &&
        (item['watts'] === null || item['watts'] === undefined)
      )
        p.list.push(`${path}.watts is required`);
      return {
        name: label(p, `${path}.name`, item['name']),
        watts: watts ?? 0,
        source:
          source === 'powercap' ? ('powercap' as const) : ('hwmon' as const),
      };
    }
  );
}

export function hardware(p: Problems, raw: Record<string, unknown>) {
  const samples = {
    filesystems: filesystems(p, raw['filesystems']),
    temperatures: temperatures(p, raw['temperatures']),
    power: power(p, raw['power']),
  };
  unique(
    p,
    'telemetry.filesystems',
    samples.filesystems.map((item) => item.mount)
  );
  unique(
    p,
    'telemetry.temperatures',
    samples.temperatures.map((item) => item.name)
  );
  unique(
    p,
    'telemetry.power',
    samples.power.map((item) => `${item.source}:${item.name}`)
  );
  return samples;
}

export function network(p: Problems, raw: unknown): Telemetry['network'] {
  const result = entries(
    p,
    'telemetry.network',
    { value: raw, limit: TELEMETRY_LIMITS.network },
    (item, path) => ({
      name: label(p, `${path}.name`, item['name']),
      receivedBytes: count(p, `${path}.receivedBytes`, item['receivedBytes']),
      transmittedBytes: count(
        p,
        `${path}.transmittedBytes`,
        item['transmittedBytes']
      ),
      receiveBytesPerSecond: measurement(
        p,
        `${path}.receiveBytesPerSecond`,
        item['receiveBytesPerSecond']
      ),
      transmitBytesPerSecond: measurement(
        p,
        `${path}.transmitBytesPerSecond`,
        item['transmitBytesPerSecond']
      ),
    })
  );
  unique(
    p,
    'telemetry.network',
    result.map((item) => item.name)
  );
  return result;
}
