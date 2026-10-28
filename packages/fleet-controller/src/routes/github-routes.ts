import type { Hono } from 'hono';

import type { AppDeps } from '../deps';

import { mountGithubAdmin } from './github-admin';
import { mountGithubWebhook } from './github-webhook';
import { mountRunnerRegistration } from './runner-registration';

/** Everything of the GitHub integration: admin API, webhook and node registration. */
export function mountGithub(app: Hono, deps: AppDeps): void {
  mountGithubAdmin(app, deps);
  mountGithubWebhook(app, deps);
  mountRunnerRegistration(app, deps);
}
