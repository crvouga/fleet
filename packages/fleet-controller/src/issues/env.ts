/**
 * Operator-supplied settings for filing GitHub issues. Optional: without a
 * token the controller still builds, previews and stores reports, and offers a
 * prefilled "new issue" link (when the repository is known) instead. The token
 * exists only here, parsed once at boot: never stored, rendered or logged.
 */
export interface IssuesEnv {
  /** Fine-grained token with `issues: write` on `repository`. Absent: filing is off. */
  readonly token?: string;
  /** `owner/name`. */
  readonly repository: string;
  readonly labels: readonly string[];
  /** https://api.github.com unless GitHub Enterprise Server (or a loopback test) says otherwise. */
  readonly apiUrl: string;
}

export const DEFAULT_ISSUES_API_URL = 'https://api.github.com';
export const DEFAULT_ISSUE_LABELS: readonly string[] = ['fleet-report'];
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LABEL = /^[^\s,][^,\r\n]{0,49}$/;
const MAX_LABELS = 10;
const MIN_TOKEN = 20;
type Source = Readonly<Record<string, string | undefined>>;

function value(source: Source, key: string): string | null {
  const raw = source[key]?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

function apiUrl(source: Source, problems: string[]): string {
  const raw = value(source, 'FLEET_ISSUES_GITHUB_API_URL');
  if (raw === null) return DEFAULT_ISSUES_API_URL;
  try {
    const url = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const allowed =
      url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    if (allowed && url.username === '' && url.password === '')
      return raw.replace(/\/+$/, '');
  } catch {
    // Reported below without echoing the value.
  }
  problems.push(
    'FLEET_ISSUES_GITHUB_API_URL must be an https URL without credentials (http only for loopback)'
  );
  return DEFAULT_ISSUES_API_URL;
}

function labels(source: Source, problems: string[]): readonly string[] {
  const raw = value(source, 'FLEET_ISSUES_LABELS');
  if (raw === null) return DEFAULT_ISSUE_LABELS;
  const list = raw
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (list.length > MAX_LABELS || !list.every((label) => LABEL.test(label))) {
    problems.push(
      `FLEET_ISSUES_LABELS must be at most ${MAX_LABELS} comma-separated labels of up to 50 characters`
    );
    return DEFAULT_ISSUE_LABELS;
  }
  return list;
}

/**
 * Undefined when neither FLEET_ISSUES_GITHUB_TOKEN nor FLEET_ISSUES_REPOSITORY
 * is set (the service is off). A repository alone enables the prefilled "new
 * issue" link; a token alone is a configuration error because it names no
 * repository to file in.
 */
export function readIssuesEnv(
  source: Source,
  problems: string[]
): IssuesEnv | undefined {
  const token = value(source, 'FLEET_ISSUES_GITHUB_TOKEN');
  const repository = value(source, 'FLEET_ISSUES_REPOSITORY');
  if (repository === null) {
    if (token !== null)
      problems.push(
        'FLEET_ISSUES_GITHUB_TOKEN needs FLEET_ISSUES_REPOSITORY (owner/name) to say where to file'
      );
    return undefined;
  }
  if (token !== null && (token.length < MIN_TOKEN || /\s/.test(token)))
    problems.push(
      'FLEET_ISSUES_GITHUB_TOKEN must be a fine-grained token without whitespace (at least 20 characters)'
    );
  if (!REPOSITORY.test(repository))
    problems.push('FLEET_ISSUES_REPOSITORY must look like owner/name');
  return {
    ...(token === null ? {} : { token }),
    repository,
    labels: labels(source, problems),
    apiUrl: apiUrl(source, problems),
  };
}

/** The settings that allow sending: a repository and a token. */
export type FilingEnv = IssuesEnv & { readonly token: string };

export function canFile(env: IssuesEnv | undefined): env is FilingEnv {
  return env?.token !== undefined;
}
