/** Field readers for request bodies. Each records a problem and returns a safe fallback. */
export interface Problems {
  readonly list: string[];
}

export interface StringRule {
  readonly max: number;
  readonly pattern?: RegExp;
}

export interface NumberRule {
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

function stringProblem(value: unknown, rule: StringRule): string | null {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > rule.max) return `must be at most ${rule.max} characters`;
  if (rule.pattern !== undefined && !rule.pattern.test(value))
    return 'has an invalid format';
  return null;
}

/** A string, or null when absent. */
export function readString(
  problems: Problems,
  path: string,
  value: unknown,
  rule: StringRule
): string | null {
  if (isMissing(value)) return null;
  const problem = stringProblem(value, rule);
  if (problem !== null) problems.list.push(`${path} ${problem}`);
  return problem === null ? (value as string) : null;
}

export function requireString(
  problems: Problems,
  path: string,
  value: unknown,
  rule: StringRule
): string {
  if (isMissing(value)) {
    problems.list.push(`${path} is required`);
    return '';
  }
  return readString(problems, path, value, rule) ?? '';
}

function numberProblem(value: unknown, rule: NumberRule): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 'must be a number';
  if (rule.integer === true && !Number.isInteger(value))
    return 'must be a whole number';
  if (value < rule.min || value > rule.max) {
    return `must be between ${rule.min} and ${rule.max}`;
  }
  return null;
}

/** A number, or null when absent. */
export function readNumber(
  problems: Problems,
  path: string,
  value: unknown,
  rule: NumberRule
): number | null {
  if (isMissing(value)) return null;
  const problem = numberProblem(value, rule);
  if (problem !== null) problems.list.push(`${path} ${problem}`);
  return problem === null ? (value as number) : null;
}

export function readBoolean(
  problems: Problems,
  path: string,
  value: unknown
): boolean {
  if (isMissing(value)) return false;
  if (typeof value === 'boolean') return value;
  problems.list.push(`${path} must be true or false`);
  return false;
}

/** A list of strings, empty when absent. */
export function readStringList(
  problems: Problems,
  path: string,
  value: unknown,
  rule: StringRule & { readonly maxItems: number }
): string[] {
  if (isMissing(value)) return [];
  if (!Array.isArray(value)) {
    problems.list.push(`${path} must be a list`);
    return [];
  }
  if (value.length > rule.maxItems) {
    problems.list.push(`${path} may have at most ${rule.maxItems} entries`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    const entry = readString(problems, `${path}[${index}]`, item, rule);
    if (entry !== null) out.push(entry);
  });
  return out;
}

/** An object, empty when absent. */
export function readObject(
  problems: Problems,
  path: string,
  value: unknown
): Record<string, unknown> {
  if (isMissing(value)) return {};
  if (isRecord(value)) return value;
  problems.list.push(`${path} must be an object`);
  return {};
}
