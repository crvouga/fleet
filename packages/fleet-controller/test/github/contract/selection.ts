/**
 * What Fleet uses of GitHub's REST API. This is the single list both the
 * refresh script (which trims the vendored description down to it) and the
 * tests (which check the vendored file still matches it) read.
 *
 * Adding a GitHub call to the controller means adding it here, then running
 * `bun run scripts/refresh-github-openapi.ts <commit>` (see SOURCE.md).
 */

export const UPSTREAM = {
  repository: 'github/rest-api-description',
  /** The 2022-11-28 API version: the one the client sends in X-GitHub-Api-Version. */
  file: 'descriptions/api.github.com/api.github.com.2022-11-28.json',
} as const;

export const METHODS = ['get', 'post', 'delete'] as const;
export type Method = (typeof METHODS)[number];

/** `path template` to the methods Fleet calls on it. */
export const OPERATIONS: Readonly<Record<string, readonly Method[]>> = {
  // src/github/client.ts, token-cache.ts: authenticated as the App.
  '/app': ['get'],
  '/app/installations': ['get'],
  '/app/installations/{installation_id}/access_tokens': ['post'],
  // src/github/client.ts: authenticated as the installation.
  '/installation/repositories': ['get'],
  '/repos/{owner}/{repo}/actions/runners': ['get'],
  '/orgs/{org}/actions/runners': ['get'],
  '/repos/{owner}/{repo}/actions/runners/registration-token': ['post'],
  '/orgs/{org}/actions/runners/registration-token': ['post'],
  '/repos/{owner}/{repo}/actions/runners/{runner_id}': ['delete'],
  '/orgs/{org}/actions/runners/{runner_id}': ['delete'],
  '/repos/{owner}/{repo}/actions/runners/{runner_id}/labels/{name}': ['delete'],
  '/orgs/{org}/actions/runners/{runner_id}/labels/{name}': ['delete'],
  '/repos/{owner}/{repo}/actions/runs': ['get'],
  '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs': ['get'],
  // src/issues/github-issues.ts
  '/repos/{owner}/{repo}/issues': ['get', 'post'],
  '/repos/{owner}/{repo}/issues/{issue_number}': ['get'],
  '/repos/{owner}/{repo}/issues/{issue_number}/comments': ['post'],
};

/** Webhook events the controller reads (src/github/webhook.ts), by the description's key. */
export const WEBHOOKS: readonly string[] = [
  'ping',
  'workflow-job-queued',
  'workflow-job-waiting',
  'workflow-job-in-progress',
  'workflow-job-completed',
  'workflow-run-requested',
  'workflow-run-in-progress',
  'workflow-run-completed',
];

/**
 * Components kept although no kept operation references them: GitHub documents
 * the rate-limit headers only here, and the contract tests check ours against them.
 */
export const EXTRA_COMPONENTS: readonly string[] = [
  '#/components/headers/x-rate-limit-limit',
  '#/components/headers/x-rate-limit-remaining',
  '#/components/headers/x-rate-limit-reset',
  '#/components/schemas/basic-error',
  '#/components/schemas/validation-error',
];

/**
 * Calls the controller makes that are deliberately not in the description,
 * each with the reason. The coverage test accepts these and nothing else.
 */
export const ALLOWED_OUTSIDE_DESCRIPTION: Readonly<Record<string, string>> = {};

/**
 * `METHOD template status` each contract test file must have seen answered. The
 * coverage test checks that together they exercise every operation above.
 */
export const EXERCISED = {
  githubClient: [
    'GET /app 200',
    'GET /app/installations 200',
    'POST /app/installations/{installation_id}/access_tokens 201',
    'GET /installation/repositories 200',
    'GET /repos/{owner}/{repo}/actions/runners 200',
    'GET /orgs/{org}/actions/runners 200',
    'POST /repos/{owner}/{repo}/actions/runners/registration-token 201',
    'POST /orgs/{org}/actions/runners/registration-token 201',
    'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id} 204',
    'DELETE /orgs/{org}/actions/runners/{runner_id} 204',
    'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}/labels/{name} 200',
    'DELETE /orgs/{org}/actions/runners/{runner_id}/labels/{name} 200',
    'GET /repos/{owner}/{repo}/actions/runs 200',
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs 200',
  ],
  issuesClient: [
    'GET /repos/{owner}/{repo}/issues 200',
    'POST /repos/{owner}/{repo}/issues 201',
    'GET /repos/{owner}/{repo}/issues/{issue_number} 200',
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments 201',
  ],
} as const;
