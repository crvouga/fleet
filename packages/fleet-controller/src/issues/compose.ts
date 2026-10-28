import type { Logger } from '@pkgs/logger';

import type { Db } from '../db/client';
import { SqliteIssueStore } from '../db/issue-store';
import type { AppDeps } from '../deps';

import { canFile, DEFAULT_ISSUES_API_URL } from './env';
import { createErrorRing } from './errors';
import {
  DEFAULT_TUNING,
  type IssueFetch,
  type IssuesRuntime,
  type IssueTuning,
} from './runtime';
import type { IssueStore } from './store';

export interface IssuesOptions {
  readonly store: IssueStore;
  readonly log: Logger;
  readonly fetch?: IssueFetch | undefined;
  readonly random?: () => number;
  /** Tests inject small, deterministic delays. */
  readonly tuning?: Partial<IssueTuning>;
}

/** github.com for the public API; a GitHub Enterprise Server's own origin otherwise. */
function webOrigin(apiUrl: string | undefined): string {
  if (apiUrl === undefined || apiUrl === DEFAULT_ISSUES_API_URL)
    return 'https://github.com';
  return new URL(apiUrl).origin;
}

/** The runtime for one controller process. Filing is on only when the operator configured it. */
export function createIssuesRuntime(
  deps: AppDeps,
  options: IssuesOptions
): IssuesRuntime {
  return {
    store: options.store,
    config: canFile(deps.env.issues) ? deps.env.issues : null,
    repository: deps.env.issues?.repository ?? null,
    webOrigin: webOrigin(deps.env.issues?.apiUrl),
    errors: createErrorRing(),
    now: deps.now,
    fetch: options.fetch ?? fetch,
    log: options.log,
    random: options.random ?? Math.random,
    tuning: { ...DEFAULT_TUNING, ...options.tuning },
    literals: [],
  };
}

/** Adds one-click issue reporting to the dependencies. */
export function withIssues(deps: AppDeps, options: IssuesOptions): AppDeps {
  return { ...deps, issues: createIssuesRuntime(deps, options) };
}

/** The production composition: reports live in the controller's SQLite database. */
export function withSqliteIssues(
  deps: AppDeps,
  db: Db,
  options: Omit<IssuesOptions, 'store'>
): AppDeps {
  return withIssues(deps, { ...options, store: new SqliteIssueStore(db) });
}
