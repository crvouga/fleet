import type { KeyObject } from 'node:crypto';

import { createCircuit, type Circuit, type CircuitSnapshot } from './circuit';
import { GithubError } from './errors';
import { integer, record, repositoryOf, text } from './normalize';
import { createTokenCache, type TokenCache } from './token-cache';
import {
  DEFAULT_RETRY,
  send,
  type FetchLike,
  type GithubRequest,
  type RetryPolicy,
  type Transport,
} from './transport';
import { targetPath, type RunnerTarget } from './types';

export interface GithubClientOptions {
  readonly apiUrl: string;
  readonly appId: string;
  readonly installationId: string;
  readonly key: KeyObject;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly retry?: Partial<RetryPolicy>;
  readonly circuit?: Circuit;
}

export interface RegistrationToken {
  readonly token: string;
  readonly expiresAt: string | null;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DEFAULT_LABELS = new Set(['self-hosted', 'linux', 'x64']);

/** The part of GitHub's REST API the controller uses, authenticated as the App. */
export class GithubClient {
  private readonly transport: Transport;
  private readonly tokens: TokenCache;

  constructor(options: GithubClientOptions) {
    this.transport = {
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      now: options.now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
      retry: { ...DEFAULT_RETRY, ...options.retry },
      circuit: options.circuit ?? createCircuit({ now: options.now }),
    };
    this.tokens = createTokenCache({
      transport: this.transport,
      appId: options.appId,
      installationId: options.installationId,
      key: options.key,
    });
  }

  circuit(): CircuitSnapshot {
    return this.transport.circuit.snapshot();
  }

  /** As the installation. A 401 means the token expired or was revoked: mint once more. */
  private async call(
    method: GithubRequest['method'],
    path: string,
    body?: unknown
  ): Promise<unknown> {
    for (let again = false; ; again = true) {
      const bearer = await this.tokens.token();
      try {
        return await send(this.transport, {
          method,
          path,
          bearer,
          kind: 'target',
          ...(body === undefined ? {} : { body }),
        });
      } catch (error) {
        const expired = error instanceof GithubError && error.status === 401;
        if (!expired || again) throw error;
        this.tokens.invalidate();
      }
    }
  }

  private async pages(path: string, field: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`;
      const list = record(await this.call('GET', url))[field];
      const batch = Array.isArray(list) ? list : [];
      items.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  /** Every self-hosted runner of the repository or organization. */
  listRunners(target: RunnerTarget): Promise<unknown[]> {
    return this.pages(targetPath(target), 'runners');
  }

  /** Newest workflow runs of one status (a single page: the sync is bounded). */
  async listRuns(
    repository: string,
    status: 'queued' | 'in_progress' | 'completed',
    perPage: number
  ): Promise<unknown[]> {
    const path = `/repos/${repository}/actions/runs?status=${status}&per_page=${perPage}`;
    const runs = record(await this.call('GET', path))['workflow_runs'];
    return Array.isArray(runs) ? runs : [];
  }

  async listRunJobs(repository: string, runId: number): Promise<unknown[]> {
    const path = `/repos/${repository}/actions/runs/${runId}/jobs?per_page=${PAGE_SIZE}`;
    const jobs = record(await this.call('GET', path))['jobs'];
    return Array.isArray(jobs) ? jobs : [];
  }

  /** The repositories the installation can reach (an organization with none configured). */
  async listInstallationRepositories(): Promise<string[]> {
    const items = await this.pages(
      '/installation/repositories',
      'repositories'
    );
    return items
      .map(repositoryOf)
      .filter((name): name is string => name !== null);
  }

  /** A short-lived (one hour) token a runner uses once to register itself. */
  async createRegistrationToken(
    target: RunnerTarget
  ): Promise<RegistrationToken> {
    const answer = record(
      await this.call('POST', `${targetPath(target)}/registration-token`)
    );
    const token = text(answer['token']);
    if (token === null) {
      throw new GithubError(
        'FLEET_GITHUB_UNAVAILABLE',
        'GitHub sent no registration token',
        { temporary: true }
      );
    }
    return { token, expiresAt: text(answer['expires_at']) };
  }

  /** Removes a runner. A runner that is already gone counts as removed. */
  async deleteRunner(target: RunnerTarget, runnerId: number): Promise<boolean> {
    try {
      await this.call('DELETE', `${targetPath(target)}/${runnerId}`);
      return true;
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return false;
      throw error;
    }
  }

  /** Removes routing labels so no new job is assigned; the runner itself stays. */
  async removeCustomLabels(
    target: RunnerTarget,
    runnerId: number,
    labels: readonly string[]
  ): Promise<number> {
    let removed = 0;
    for (const label of labels) {
      if (DEFAULT_LABELS.has(label.toLowerCase())) continue;
      const path = `${targetPath(target)}/${runnerId}/labels/${encodeURIComponent(label)}`;
      await this.call('DELETE', path);
      removed += 1;
    }
    return removed;
  }

  /** As the App itself (JWT): checks the App ID and private key. */
  async getApp(): Promise<{ slug: string | null }> {
    const answer = record(
      await send(this.transport, {
        method: 'GET',
        path: '/app',
        bearer: this.tokens.appJwt(),
        kind: 'installation',
      })
    );
    return { slug: text(answer['slug']) };
  }

  /** Installations this App has: lets an operator find the right installation ID. */
  async listInstallations(): Promise<{ id: number; account: string | null }[]> {
    const answer = await send(this.transport, {
      method: 'GET',
      path: '/app/installations?per_page=30',
      bearer: this.tokens.appJwt(),
      kind: 'installation',
    });
    const list = Array.isArray(answer) ? answer : [];
    return list.flatMap((entry) => {
      const id = integer(record(entry)['id']);
      const account = text(record(record(entry)['account'])['login']);
      return id === null ? [] : [{ id, account }];
    });
  }

  /** Mints an installation token now, so a wrong installation ID shows up as such. */
  async checkInstallation(): Promise<void> {
    await this.tokens.token();
  }
}
