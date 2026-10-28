import { readFileSync } from 'node:fs';

export interface BuildInfo {
  readonly version: string;
  /** Git commit the controller was built from; "unknown" unless the platform or build sets one. */
  readonly commit: string;
}

/**
 * The environment variables a build or platform may set, in order. The image
 * build does not stamp a commit by itself; Railway sets RAILWAY_GIT_COMMIT_SHA
 * and any builder can set FLEET_CONTROLLER_COMMIT. See docs/issue-reporting.md.
 */
export const COMMIT_VARIABLES = [
  'FLEET_CONTROLLER_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'SOURCE_COMMIT',
  'GIT_COMMIT',
  'GITHUB_SHA',
] as const;

const COMMIT = /^[0-9a-f]{7,64}$/i;

function packageVersion(): string {
  try {
    const raw = readFileSync(
      new URL('../../package.json', import.meta.url),
      'utf8'
    );
    const parsed: unknown = JSON.parse(raw);
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['version']
        : undefined;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function readBuildInfo(
  source: Readonly<Record<string, string | undefined>> = process.env
): BuildInfo {
  const commit = COMMIT_VARIABLES.map((name) => source[name]?.trim()).find(
    (value): value is string => value !== undefined && COMMIT.test(value)
  );
  return { version: packageVersion(), commit: commit ?? 'unknown' };
}
