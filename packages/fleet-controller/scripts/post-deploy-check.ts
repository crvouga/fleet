#!/usr/bin/env bun
/**
 * Post-deploy gate for a running Fleet controller.
 *
 *   FLEET_URL=https://fleet.example.com FLEET_ADMIN_TOKEN=... \
 *     bun packages/fleet-controller/scripts/post-deploy-check.ts [options]
 *
 * It proves the deployment answers as a controller of this release should:
 * /health, the admin boundary, the authenticated API, the schema-3 endpoints
 * and the GitHub integration status. It only reads. The admin token comes from
 * the environment (never an argument), is never printed, and is sent only to the
 * given origin (redirects are refused).
 *
 * Options:
 *   --url URL            controller base URL (default $FLEET_URL); https required except on loopback
 *   --expect-schema N    database schema the deployment must be at (default 3). The controller
 *                        exposes no version number, so this is inferred from endpoints that exist
 *                        only at that schema (audit log, settings revisions, operations)
 *   --timeout SECONDS    per request (default 10)
 *   --retries N          extra attempts for a service still starting (default 5)
 *   --backoff SECONDS    first wait between attempts, doubling up to 30 s (default 2)
 *   --require-github     fail unless the GitHub integration is connected (default: unconfigured is fine)
 *
 * Exit 0 all checks passed, 1 a check failed, 2 bad usage or configuration.
 */
import { randomBytes } from 'node:crypto';

import {
  KNOWN_SCHEMA,
  checkAudit,
  checkAuthBoundary,
  checkGithub,
  checkHealth,
  checkNodes,
  checkSchema,
  checkSummary,
  type Ctx,
} from './post-deploy/checks';
import { createHttp } from './post-deploy/http';
import { createReport } from './post-deploy/report';

export interface Config {
  readonly url: string;
  readonly adminToken: string;
  readonly expectSchema: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly backoffMs: number;
  readonly requireGithub: boolean;
}

export interface Runtime {
  readonly write: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class UsageError extends Error {}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const NUMBER_FLAGS = ['--expect-schema', '--timeout', '--retries', '--backoff'];

function number(flag: string, raw: string | undefined, min: number): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value < min)
    throw new UsageError(`${flag} needs a number of at least ${min}`);
  return value;
}

/** The base URL, or why it may not carry an admin token. */
export function baseUrl(raw: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new UsageError(
      'FLEET_URL (or --url) must be the controller address, for example https://fleet.example.com'
    );
  }
  if (url.username !== '' || url.password !== '')
    throw new UsageError('the URL must not contain credentials');
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure)
    throw new UsageError(
      'the URL must be https (plain http is only accepted for a loopback address): the admin token would travel in clear text'
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function flagValues(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--require-github') flags.set(flag, true);
    else if (flag === '--url' || NUMBER_FLAGS.includes(flag)) {
      flags.set(flag, argv[i + 1] ?? '');
      i += 1;
    } else throw new UsageError(`unknown option ${flag}`);
  }
  return flags;
}

export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): Config {
  const flags = flagValues(argv);
  const text = (flag: string): string | undefined => {
    const value = flags.get(flag);
    return typeof value === 'string' ? value : undefined;
  };
  const adminToken = env['FLEET_ADMIN_TOKEN'] ?? '';
  if (adminToken.trim() === '')
    throw new UsageError(
      'FLEET_ADMIN_TOKEN is not set (it is read from the environment only)'
    );
  return {
    url: baseUrl(text('--url') ?? env['FLEET_URL']),
    adminToken,
    expectSchema: number(
      '--expect-schema',
      text('--expect-schema') ?? String(KNOWN_SCHEMA),
      1
    ),
    timeoutMs: number('--timeout', text('--timeout') ?? '10', 1) * 1000,
    retries: number('--retries', text('--retries') ?? '5', 0),
    backoffMs: number('--backoff', text('--backoff') ?? '2', 0) * 1000,
    requireGithub: flags.has('--require-github'),
  };
}

/** Runs every check and returns the exit code. */
export async function runPostDeploy(
  config: Config,
  runtime: Runtime
): Promise<number> {
  const redact = (text: string): string =>
    text.split(config.adminToken).join('[redacted]');
  const report = createReport(runtime.write, redact);
  const http = createHttp({
    base: config.url,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    backoffMs: config.backoffMs,
    sleep: runtime.sleep ?? ((ms) => Bun.sleep(ms)),
    redact,
  });
  const ctx: Ctx = {
    http,
    report,
    options: {
      adminToken: config.adminToken,
      wrongToken: `wrong-${randomBytes(16).toString('hex')}`,
      expectSchema: config.expectSchema,
      requireGithub: config.requireGithub,
    },
  };
  runtime.write(`post-deploy check of ${config.url}`);
  if (await checkHealth(ctx)) {
    await checkAuthBoundary(ctx);
    if (await checkNodes(ctx)) {
      await checkSummary(ctx);
      await checkAudit(ctx);
      await checkSchema(ctx);
      await checkGithub(ctx);
    }
  }
  const verdict = report.failures.length === 0 ? 'PASSED' : 'FAILED';
  runtime.write(
    `post-deploy check ${verdict}: ${report.passed} ok, ${report.warnings.length} warning(s), ${report.failures.length} failure(s)`
  );
  return report.failures.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const write = (line: string) => void process.stdout.write(`${line}\n`);
  try {
    const config = parseConfig(process.argv.slice(2), process.env);
    return await runPostDeploy(config, { write });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`post-deploy check: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main());
