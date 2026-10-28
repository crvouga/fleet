import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@pkgs/logger';

import {
  configArgs,
  runBounded,
  spawnLitestream,
  stopWithin,
  type LitestreamProcess,
} from '../litestream';
import { createDb } from '../db/client';
import { StartupError, databaseFailure } from '../startup-error';
import type { StorageConfig } from '../storage';
import { acquire, type Claim, type OwnershipContext } from './acquire';
import { startBackground } from './background';
import { keepAlive, type KeepAlive } from './keep-alive';
import { Lease } from './lease';
import { generationPrefix } from './record';
import { DEFAULT_RETENTION, type RetentionPolicy } from './retention-policy';
import { freeLoopbackPort } from './replica-sync';
import { OWNERSHIP_STATUS_ENV } from './status';
import type { Shutdown } from './shutdown';
import { markGeneration, prepareWorkingFile } from './working-file';
import { WRITE_GATE_ENV } from './write-gate';

/**
 * Covers the worker's own 10 s shutdown grace plus Litestream's final sync when
 * storage is healthy. Under degraded storage the final sync can outlast it (up
 * to three attempts of FLEET_STARTUP_TIMEOUT_SECONDS) and the platform's SIGKILL
 * arrives first: ownership is then not released and the successor takes over
 * after expiry (see CONFIGURATION.md, Writer ownership).
 */
const DRAIN_GRACE_MS = 50_000;
/** Exit status of a writer that lost ownership (self-fenced). */
const FENCED_EXIT_CODE = 75;
/** A fenced holder's writes go to an abandoned generation; stop it promptly. */
const FENCED_GRACE_MS = 15_000;

export interface WriterOptions {
  readonly binary: string;
  readonly storage: StorageConfig;
  readonly log: Logger;
  readonly worker: string;
  readonly ctx: OwnershipContext;
  readonly shutdown: Shutdown;
  /** Which old generations the owner may delete; defaults to 2 generations and 7 days. */
  readonly retention?: RetentionPolicy;
}

type Served =
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'standby' };

const at = (storage: StorageConfig, generation: number): StorageConfig => ({
  ...storage,
  prefix: generationPrefix(storage.prefix, generation),
});

async function prepare(
  options: WriterOptions,
  claim: Claim,
  directory: string,
  metricsPort: number
): Promise<string[]> {
  const { binary, storage, log } = options;
  const local = prepareWorkingFile(storage.path, claim.restoreFrom);
  log.info('claimed writer ownership; restoring', {
    generation: claim.generation,
    restoreFrom: claim.restoreFrom,
    localWorkingFile: local,
  });
  const source = at(storage, claim.restoreFrom);
  const restore = [
    'restore',
    ...configArgs(directory, 'restore', source),
    '-if-db-not-exists',
    '-if-replica-exists',
    storage.path,
  ];
  if ((await runBounded(binary, restore, source)) !== 0)
    throw new StartupError(
      'restore',
      'Litestream restore failed. Fix FLEET_S3_BUCKET, FLEET_S3_PREFIX, FLEET_S3_ENDPOINT, AWS_REGION or AWS credentials (or their S3_* equivalents); verify bucket List/Get permissions and connectivity. Check the Litestream error above. If the operation timed out, increase FLEET_STARTUP_TIMEOUT_SECONDS for a large restore. The Fleet controller did not start listening.'
    );
  try {
    await (await createDb(storage)).close();
  } catch (error) {
    throw databaseFailure(error);
  }
  return configArgs(
    directory,
    'replica',
    at(storage, claim.generation),
    metricsPort
  );
}

async function initialSync(
  options: WriterOptions,
  claim: Claim,
  common: string[]
): Promise<void> {
  markGeneration(options.storage.path, claim.generation);
  options.log.info('verifying S3 replication before accepting traffic');
  const target = at(options.storage, claim.generation);
  if (
    (await runBounded(
      options.binary,
      ['replicate', ...common, '-once'],
      target
    )) !== 0
  )
    throw new StartupError(
      'replica-write',
      'Initial Litestream replication failed. Verify S3 List/Get/Put/Delete permissions for the configured bucket/prefix, endpoint, region and credentials. Retain the local database and retry after fixing the error above. Increase FLEET_STARTUP_TIMEOUT_SECONDS if a slow initial sync exceeded its deadline. The Fleet controller did not start listening.'
    );
}

type Event = 'exited' | 'shutdown' | 'handover' | 'lost';

async function nextEvent(
  child: LitestreamProcess,
  alive: KeepAlive,
  shutdown: Shutdown
): Promise<Event> {
  return Promise.race([
    child.exited.then((): Event => 'exited'),
    shutdown.promise.then((): Event => 'shutdown'),
    alive.changed.then((state): Event =>
      state === 'lost' ? 'lost' : 'handover'
    ),
  ]);
}

interface Running {
  readonly child: LitestreamProcess;
  readonly lease: Lease;
  readonly log: Logger;
  /** One explicit `replicate -once` of the stopped database to its generation. */
  readonly syncOnce: () => Promise<number>;
}

/**
 * Litestream 0.5.17 exits without syncing when stopped before its first sync
 * tick, so the final sync never relies on its shutdown path: once the worker
 * has stopped, the supervisor syncs explicitly, then releases ownership.
 */
async function finalSync(running: Running): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if ((await running.syncOnce()) === 0) return true;
    running.log.warn('final replica sync failed; retrying', { attempt });
  }
  running.log.error(
    'final replica sync failed; the local working file is retained for recovery',
    { generation: running.lease.claim.generation }
  );
  return false;
}

async function settle(event: Event, running: Running): Promise<Served> {
  const { child, lease, log } = running;
  const generation = lease.claim.generation;
  if (event === 'lost') {
    // Another instance owns a newer generation; this one's writes are abandoned.
    // Exit nonzero (the platform's restart policy brings it back as a new
    // deployment, which asks the live owner to hand over): a fenced process
    // never lingers as a writer candidate that could be mistaken for healthy.
    log.error('writer ownership lost; stopped accepting writes and exiting', {
      generation,
    });
    await stopWithin(child, FENCED_GRACE_MS);
    return { kind: 'exited', code: FENCED_EXIT_CODE };
  }
  if (event !== 'exited')
    log.info(
      event === 'shutdown'
        ? 'stopping; final replica sync'
        : 'handing over; final replica sync',
      { generation }
    );
  const code =
    event === 'exited'
      ? await child.exited
      : await stopWithin(child, DRAIN_GRACE_MS);
  const synced = await finalSync(running);
  await lease.release();
  if (event === 'handover') return { kind: 'standby' };
  // The worker never exits on its own while healthy; a clean exit is still a failure.
  if (event === 'exited')
    return { kind: 'exited', code: code === 0 ? 1 : code };
  return { kind: 'exited', code: synced ? 0 : 1 };
}

async function serve(
  options: WriterOptions,
  claim: Claim,
  directory: string
): Promise<Served> {
  const lease = new Lease(options.ctx, claim);
  const gate = join(directory, 'write-gate');
  const statusFile = join(directory, 'ownership-status');
  const synced: { at: number | null } = { at: null };
  const metricsPort = freeLoopbackPort();
  const alive = keepAlive(lease, options.ctx, gate, {
    path: statusFile,
    lastSyncAt: () => synced.at,
  });
  try {
    const common = await prepare(options, claim, directory, metricsPort);
    await initialSync(options, claim, common);
    if (!(await lease.confirmReplica()))
      throw new StartupError(
        'ownership',
        'Could not record this generation as the authoritative replica in object storage. Check connectivity and Put permissions; the next start retries. The Fleet controller did not start listening.'
      );
    synced.at = Date.now();
    alive.refresh();
    const child = spawnLitestream(
      options.binary,
      ['replicate', ...common, '-exec', options.worker],
      at(options.storage, claim.generation),
      { [WRITE_GATE_ENV]: gate, [OWNERSHIP_STATUS_ENV]: statusFile }
    );
    const background = startBackground({
      ctx: options.ctx,
      lease,
      policy: options.retention ?? DEFAULT_RETENTION,
      log: options.log,
      metricsPort,
      onSynced: (atWall) => (synced.at = atWall),
    });
    const event = await nextEvent(child, alive, options.shutdown);
    background.stop();
    alive.closeGate();
    const target = at(options.storage, claim.generation);
    return await settle(event, {
      child,
      lease,
      log: options.log,
      syncOnce: () =>
        runBounded(
          options.binary,
          ['replicate', ...common, '-once'],
          target,
          false
        ),
    });
  } catch (error) {
    await lease.release();
    throw error;
  } finally {
    alive.stop();
  }
}

/**
 * Runs the controller as the only writer of its replica. A newly started
 * instance asks the current writer to hand over; after handing over or being
 * fenced, an instance waits as a standby that only takes released or expired
 * ownership. Returns the process exit code.
 */
export async function superviseWriter(options: WriterOptions): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-litestream-'));
  let mode: 'request' | 'standby' = 'request';
  try {
    for (;;) {
      const claim = await acquire(options.ctx, mode);
      if (claim === null) return 0;
      const served = await serve(options, claim, directory);
      if (served.kind === 'exited') return served.code;
      options.log.info('waiting as a standby writer');
      mode = 'standby';
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
