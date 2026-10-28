import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '@pkgs/logger';

import {
  ConfigurationError,
  readControllerEnv,
  type ControllerEnv,
} from './env';
import { preflight } from './preflight';
import { StartupError } from './startup-error';
import { litestreamCredentials } from './storage';
import type { OwnershipContext } from './ownership/acquire';
import { s3ConditionalStore } from './ownership/object-store';
import { OwnerRecordError, verifyConditionalWrites } from './ownership/record';
import { shutdownSignal, type Shutdown } from './ownership/shutdown';
import { superviseWriter } from './ownership/supervisor';

export { litestreamConfig } from './litestream';

function ownershipContext(
  env: ControllerEnv,
  log: Logger,
  shutdown: Shutdown
): OwnershipContext {
  const credentials = litestreamCredentials(process.env);
  const sessionToken = process.env['AWS_SESSION_TOKEN']?.trim();
  return {
    store: s3ConditionalStore(env.storage, {
      accessKeyId: credentials.AWS_ACCESS_KEY_ID,
      secretAccessKey: credentials.AWS_SECRET_ACCESS_KEY,
      ...(sessionToken ? { sessionToken } : {}),
    }),
    prefix: env.storage.prefix,
    instance: randomUUID(),
    timing: env.ownership,
    now: () => performance.now(),
    sleep: shutdown.sleep,
    stopped: shutdown.requested,
    log,
  };
}

async function requireConditionalWrites(ctx: OwnershipContext): Promise<void> {
  let supported = false;
  try {
    supported = await verifyConditionalWrites(
      ctx.store,
      ctx.prefix,
      ctx.instance
    );
  } catch {
    supported = false;
  }
  if (!supported)
    throw new StartupError(
      'ownership',
      'Object storage refused or ignored a conditional write (If-None-Match / If-Match). Fleet needs them to guarantee a single writer. Check bucket Put/Get/Delete permissions, endpoint and credentials, or use a provider with conditional writes (AWS S3, Cloudflare R2). The Fleet controller did not start listening.'
    );
}

async function serveAsWriter(
  env: ControllerEnv,
  binary: string,
  log: Logger,
  workerCommand?: string
): Promise<number> {
  const shutdown = shutdownSignal();
  try {
    const ctx = ownershipContext(env, log, shutdown);
    await requireConditionalWrites(ctx);
    return await superviseWriter({
      binary,
      storage: env.storage,
      log,
      worker:
        workerCommand ??
        `"${process.execPath}" "${new URL('controller.ts', import.meta.url).pathname}"`,
      ctx,
      shutdown,
      retention: env.retention,
    });
  } finally {
    shutdown.dispose();
  }
}

function describe(error: unknown): { stage: string; error: string } {
  if (error instanceof StartupError)
    return { stage: error.stage, error: error.message };
  if (error instanceof ConfigurationError)
    return { stage: 'configuration', error: error.message };
  if (error instanceof OwnerRecordError)
    return {
      stage: 'ownership',
      error: `${error.message}. Fleet will not guess who owns the replica: stop every instance using this FLEET_S3_PREFIX, then inspect fleet-owner.json under the prefix. The Fleet controller did not start listening.`,
    };
  return {
    stage: 'configuration',
    error:
      'Startup prerequisite failed. Check local directory permissions, available disk space and FLEET_LITESTREAM_BIN. See CONFIGURATION.md.',
  };
}

function reportFailure(log: Logger, error: unknown): void {
  log.error('fleet controller startup failed', {
    ...describe(error),
    fix: 'Edit deployment.env using deployment.env.example; rerun bun run check:config, then bun run start. See CONFIGURATION.md.',
  });
}

export async function start(
  checkOnly = false,
  workerCommand?: string
): Promise<void> {
  const log = createLogger({ name: 'fleet-controller', level: 'info' });
  try {
    const env = readControllerEnv();
    const binary = await preflight(env);
    if (checkOnly) {
      log.info(
        'configuration and local prerequisites are valid; S3 access is verified during startup'
      );
      return;
    }
    const code = await serveAsWriter(env, binary, log, workerCommand);
    if (code !== 0)
      log.error('Fleet controller or Litestream exited unsuccessfully', {
        stage: 'serve',
        exitCode: code,
        fix: 'Read the startup/runtime error above. Fix database permissions, PORT conflicts, assets or replica access before restarting. See CONFIGURATION.md.',
      });
    process.exitCode = code;
  } catch (error) {
    reportFailure(log, error);
    process.exitCode = 1;
  }
}

if (import.meta.main) void start(process.argv.includes('--check'));
