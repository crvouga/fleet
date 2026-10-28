/**
 * Public codes for GitHub failures. They are safe to show to an operator and to
 * return to a node: they name what to change, never what GitHub answered.
 */
export type GithubCode =
  | 'FLEET_GITHUB_KEY'
  | 'FLEET_GITHUB_SCOPE'
  | 'FLEET_GITHUB_REGISTRATION'
  | 'FLEET_GITHUB_UNCONFIGURED'
  | 'FLEET_GITHUB_UNAVAILABLE'
  | 'FLEET_GITHUB_RATE_LIMITED';

export interface GithubErrorInit {
  /** True for network errors, 5xx, 408, 429 and rate limits: retrying can succeed. */
  readonly temporary: boolean;
  readonly status?: number;
  /** How long GitHub (or the circuit) says to wait, in milliseconds. */
  readonly retryAfterMs?: number | null;
}

/**
 * A classified GitHub failure. The message is public text and never quotes a
 * response body, a token or a key.
 */
export class GithubError extends Error {
  readonly temporary: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    readonly code: GithubCode,
    message: string,
    init: GithubErrorInit
  ) {
    super(message);
    this.name = 'GithubError';
    this.temporary = init.temporary;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

export function isGithubError(value: unknown): value is GithubError {
  return value instanceof GithubError;
}

/** The wording operators already know from runner_control.py: what a refusal means. */
export function refusal(
  status: number,
  kind: 'installation' | 'target'
): GithubError {
  const permanent = { temporary: false, status } as const;
  if (kind === 'installation' && status === 401) {
    return new GithubError(
      'FLEET_GITHUB_KEY',
      'GitHub refused the App credential (HTTP 401): the App ID or private key is wrong, or the key was revoked',
      permanent
    );
  }
  if (kind === 'installation' && status === 404) {
    return new GithubError(
      'FLEET_GITHUB_SCOPE',
      'GitHub does not know this App installation (HTTP 404): the installation ID is wrong or the App was uninstalled',
      permanent
    );
  }
  return targetRefusal(status);
}

function targetRefusal(status: number): GithubError {
  const permanent = { temporary: false, status } as const;
  if (status === 404) {
    return new GithubError(
      'FLEET_GITHUB_SCOPE',
      'GitHub answered HTTP 404 for the runner target: the App installation cannot reach this repository or organization',
      permanent
    );
  }
  if (status === 403) {
    return new GithubError(
      'FLEET_GITHUB_SCOPE',
      'GitHub refused with HTTP 403: the App lacks the runner permission (repository Administration, or organization Self-hosted runners)',
      permanent
    );
  }
  if (status === 401) {
    return new GithubError(
      'FLEET_GITHUB_KEY',
      'GitHub refused the installation token (HTTP 401)',
      permanent
    );
  }
  return new GithubError(
    'FLEET_GITHUB_REGISTRATION',
    `GitHub refused the request with HTTP ${status}`,
    permanent
  );
}
