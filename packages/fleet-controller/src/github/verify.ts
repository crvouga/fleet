import type { GithubClient } from './client';
import { GithubError, isGithubError } from './errors';
import type { GithubRuntime } from './runtime';
import { isConfigured } from './policy';
import { runnerTargets } from './sync-collect';
import type { Integration, RunnerTarget } from './types';

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
}

export interface Verification {
  readonly ok: boolean;
  /** `temporary`: GitHub could not be asked; nothing is wrong with the settings. */
  readonly temporary: boolean;
  readonly checks: readonly Check[];
}

function pass(name: string, message: string): Check {
  return { name, ok: true, message };
}

function fail(name: string, error: unknown): Check {
  if (isGithubError(error)) {
    return { name, ok: false, code: error.code, message: error.message };
  }
  return {
    name,
    ok: false,
    code: 'FLEET_GITHUB_UNAVAILABLE',
    message: 'the check could not be completed',
  };
}

async function installationHint(client: GithubClient): Promise<string> {
  try {
    const found = await client.listInstallations();
    if (found.length === 0) return ' This App has no installations.';
    const list = found
      .map((i) => `${i.id}${i.account === null ? '' : ` (${i.account})`}`)
      .join(', ');
    return ` Installations of this App: ${list}.`;
  } catch {
    return '';
  }
}

async function checkApp(client: GithubClient): Promise<Check[]> {
  try {
    const app = await client.getApp();
    return [
      pass(
        'app',
        `The App credential works${app.slug === null ? '' : ` (${app.slug})`}.`
      ),
    ];
  } catch (error) {
    return [fail('app', error)];
  }
}

async function checkInstallation(client: GithubClient): Promise<Check[]> {
  try {
    await client.checkInstallation();
    return [pass('installation', 'The installation ID is valid.')];
  } catch (error) {
    const scope =
      error instanceof GithubError && error.code === 'FLEET_GITHUB_SCOPE';
    const hint = scope ? await installationHint(client) : '';
    const check = fail('installation', error);
    return [
      { ...check, message: `${check.message}.${hint}`.replace('..', '.') },
    ];
  }
}

async function checkTarget(
  client: GithubClient,
  target: RunnerTarget
): Promise<Check[]> {
  const label = target.name;
  const checks: Check[] = [];
  try {
    await client.listRunners(target);
    checks.push(pass(`runners:${label}`, `Runners of ${label} can be listed.`));
  } catch (error) {
    return [fail(`runners:${label}`, error)];
  }
  try {
    await client.createRegistrationToken(target);
    checks.push(
      pass(
        `registration:${label}`,
        `A registration token for ${label} can be created.`
      )
    );
  } catch (error) {
    checks.push(fail(`registration:${label}`, error));
  }
  return checks;
}

async function checkJobs(
  client: GithubClient,
  repository: string
): Promise<Check> {
  try {
    await client.listRuns(repository, 'queued', 1);
    return pass(
      `jobs:${repository}`,
      `Workflow runs of ${repository} can be read.`
    );
  } catch (error) {
    const check = fail(`jobs:${repository}`, error);
    const permission = check.code === 'FLEET_GITHUB_SCOPE';
    return permission
      ? {
          ...check,
          message: `${check.message}. Workflow runs also need the Actions: read permission.`,
        }
      : check;
  }
}

function unavailable(integration: Integration, message: string): Verification {
  const configured = isConfigured(integration);
  return {
    ok: false,
    temporary: false,
    checks: [
      {
        name: configured ? 'key' : 'settings',
        ok: false,
        code: 'FLEET_GITHUB_UNCONFIGURED',
        message,
      },
    ],
  };
}

/**
 * Asks GitHub, as the App, whether every part of the saved integration works
 * and says exactly which permission or installation is missing. Creates one
 * registration token per target to prove the runner permission; it is discarded.
 */
export async function verifyConnection(
  runtime: GithubRuntime
): Promise<Verification> {
  const connection = await runtime.connect();
  if (!connection.ok)
    return unavailable(connection.integration, connection.message);
  const { client, integration } = connection;
  const checks: Check[] = [...(await checkApp(client))];
  if (checks.every((c) => c.ok))
    checks.push(...(await checkInstallation(client)));
  if (checks.every((c) => c.ok)) {
    for (const target of runnerTargets(integration)) {
      checks.push(...(await checkTarget(client, target)));
    }
    for (const repository of integration.repositories.slice(0, 20)) {
      checks.push(await checkJobs(client, repository));
    }
  }
  const failedChecks = checks.filter((c) => !c.ok);
  const temporary =
    failedChecks.length > 0 &&
    failedChecks.every(
      (c) =>
        c.code === 'FLEET_GITHUB_UNAVAILABLE' ||
        c.code === 'FLEET_GITHUB_RATE_LIMITED'
    );
  return { ok: failedChecks.length === 0, temporary, checks };
}
