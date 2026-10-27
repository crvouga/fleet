import {
  isRecord,
  readNumber,
  readString,
  requireString,
  type Problems,
} from './heartbeat-fields';

export const TELEMETRY_LIMITS = {
  filesystems: 16,
  temperatures: 64,
  power: 32,
  network: 32,
  runnerSlots: 64,
  logs: 40,
  issues: 16,
} as const;
const CLEAN = /^[^\u0000-\u001f\u007f]*$/;
export function label(p: Problems, path: string, value: unknown): string {
  return requireString(p, path, value, {
    max: 120,
    pattern: /^[^\u0000-\u001f\u007f]{1,120}$/,
  });
}
export function nullableLabel(
  p: Problems,
  path: string,
  value: unknown
): string | null {
  return readString(p, path, value, { max: 120, pattern: CLEAN });
}
export function timestamp(
  p: Problems,
  path: string,
  value: unknown,
  nullable = false
): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  ) {
    const time = new Date(value);
    if (
      Number.isFinite(time.getTime()) &&
      time.toISOString().slice(0, 19) === value.slice(0, 19)
    )
      return value;
  }
  p.list.push(`${path} must be an ISO UTC timestamp`);
  return null;
}
export function count(p: Problems, path: string, value: unknown): number {
  const result = readNumber(p, path, value, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
  if (result === null && (value === null || value === undefined))
    p.list.push(`${path} is required`);
  return result ?? 0;
}
export function measurement(
  p: Problems,
  path: string,
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): number | null {
  return readNumber(p, path, value, { min: 0, max });
}
export function entries<T>(
  p: Problems,
  path: string,
  options: { value: unknown; limit: number },
  parse: (item: Record<string, unknown>, path: string) => T
): T[] {
  const { value, limit } = options;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) {
    p.list.push(`${path} must be a list with at most ${limit} entries`);
    return [];
  }
  return value.flatMap((item, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(item)) {
      p.list.push(`${at} must be an object`);
      return [];
    }
    return [parse(item, at)];
  });
}
export function unique(
  p: Problems,
  path: string,
  values: readonly string[]
): void {
  if (new Set(values).size !== values.length)
    p.list.push(`${path} entries must have distinct names`);
}
