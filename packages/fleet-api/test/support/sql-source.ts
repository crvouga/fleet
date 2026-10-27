import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const PACKAGE_ROOT = resolve(import.meta.dir, '../..');

/** Every .ts and .tsx file under a directory, as package-relative paths. */
export function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(relative(PACKAGE_ROOT, full));
  }
  return out.sort();
}

export function read(path: string): string {
  return readFileSync(resolve(PACKAGE_ROOT, path), 'utf8');
}

export interface SqlText {
  readonly file: string;
  /** The statement with every ${...} replaced by a `?`. */
  readonly sql: string;
}

const STATEMENT = /\b(select|insert|update|delete)\b/i;

/** Tagged template literals in a file that read like SQL. */
export function sqlStatements(file: string, source: string): SqlText[] {
  const found: SqlText[] = [];
  for (const match of source.matchAll(/`([^`]*)`/g)) {
    const sql = (match[1] ?? '').replace(/\$\{[^}]*\}/g, '?');
    if (STATEMENT.test(sql) && /\bfleet\.|\bfrom\b|\binto\b/i.test(sql))
      found.push({ file, sql });
  }
  return found;
}

const TABLE_KEYWORDS =
  /\b(from|join|into|update|truncate)\s+([A-Za-z_(][\w.]*\(?)/gi;

/**
 * Table references that do not start with `fleet.`. Function calls
 * (`jsonb_array_elements(...)`, `now()`), subqueries and the `for update` /
 * `do update` clauses are not table references.
 */
export function unqualifiedTables(sql: string): string[] {
  const bad: string[] = [];
  for (const match of sql.matchAll(TABLE_KEYWORDS)) {
    const keyword = (match[1] ?? '').toLowerCase();
    const target = match[2] ?? '';
    if (!isTableReference(keyword, target, sql.slice(0, match.index))) continue;
    if (!/^fleet\.[a-z_]+$/.test(target)) bad.push(`${keyword} ${target}`);
  }
  return bad;
}

function isTableReference(
  keyword: string,
  target: string,
  preceding: string
): boolean {
  const before = preceding.trimEnd().split(/\s+/).pop()?.toLowerCase();
  const clause = keyword === 'update' && (before === 'for' || before === 'do');
  const callOrSubquery = target.startsWith('(') || target.endsWith('(');
  return !clause && !callOrSubquery;
}

const DDL =
  /\b(create|alter|drop|truncate)\s+(or\s+replace\s+)?(table|schema|index|sequence|database|role|user|extension|function|view|trigger|type|policy|materialized|temporary|temp|unlogged|domain)\b/i;

/** DDL anywhere in a source file, including comments and strings. */
export function ddlIn(source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => DDL.test(line))
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}
