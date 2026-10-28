import type { Logger } from '@pkgs/logger';

import type { Db } from '../db/client';
import { SqliteGithubStore } from '../db/github-store';
import type { AppDeps } from '../deps';

import { withRunnerDefaults } from './runner-defaults';
import { createGithubRuntime, type GithubRuntimeOptions } from './runtime';
import type { FetchLike } from './transport';

/**
 * Adds the GitHub integration to the dependencies: the runtime, and a store
 * that layers the integration's runner defaults under every CI node's settings.
 */
export function withGithub(
  deps: AppDeps,
  db: Db,
  options: {
    readonly log: Logger;
    readonly fetch?: FetchLike | undefined;
    /** Backoff controls; tests inject deterministic ones. */
    readonly tuning?: Pick<GithubRuntimeOptions, 'sleep' | 'random' | 'retry'>;
  }
): AppDeps {
  const github = new SqliteGithubStore(db);
  const runtime = createGithubRuntime({
    env: deps.env.github,
    store: github,
    now: deps.now,
    fetch: options.fetch ?? fetch,
    log: options.log,
    ...options.tuning,
  });
  return {
    ...deps,
    store: withRunnerDefaults(deps.store, github),
    github: runtime,
  };
}
