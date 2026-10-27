import { errorDetails, type Logger } from '@pkgs/logger';

import type { RevisionSource } from '../deps';

export interface GithubRevisionOptions {
  /** owner/name */
  readonly repo: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly log: Logger;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5000;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The newest commit sha on main, from the GitHub API. Cached for a minute and
 * revalidated with the ETag (a 304 does not count against the rate limit). Any
 * failure returns the last good value, or null when there has been none.
 */
export class GithubRevisionSource implements RevisionSource {
  private sha: string | null = null;
  private etag: string | null = null;
  private checkedAt = 0;
  private inflight: Promise<string | null> | null = null;

  constructor(private readonly options: GithubRevisionOptions) {}

  latest(): Promise<string | null> {
    const age = this.options.now().getTime() - this.checkedAt;
    if (this.checkedAt > 0 && age < (this.options.ttlMs ?? DEFAULT_TTL_MS)) {
      return Promise.resolve(this.sha);
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string | null> {
    try {
      await this.request();
    } catch (err: unknown) {
      this.options.log.warn('github revision lookup failed', {
        error: errorDetails(err),
      });
    }
    // Failures count as a check too, so an outage is retried once per TTL.
    this.checkedAt = this.options.now().getTime();
    return this.sha;
  }

  private async request(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.sha',
      'User-Agent': 'fleet-api',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.etag !== null) headers['If-None-Match'] = this.etag;
    const url = `https://api.github.com/repos/${this.options.repo}/commits/main`;
    const res = await this.options.fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`github answered ${res.status}`);
    const sha = (await res.text()).trim().toLowerCase();
    if (!SHA.test(sha))
      throw new Error('github answered with something other than a sha');
    this.sha = sha;
    this.etag = res.headers.get('etag');
  }
}
