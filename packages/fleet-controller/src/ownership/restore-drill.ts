import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@pkgs/logger';

import { ConfigurationError } from '../env';
import { configArgs, runBounded } from '../litestream';
import { litestreamBinary } from '../preflight';
import { StartupError } from '../startup-error';
import { readStorage, type StorageConfig } from '../storage';
import { conditionalStoreFor } from './access-guard';
import type { ConditionalStore } from './object-store';
import {
  OwnerRecordError,
  generationPrefix,
  ownerKey,
  parseOwner,
} from './record';

/** What a restore drill reports: counts and versions only, never row contents. */
export interface DrillReport {
  readonly prefix: string;
  readonly generation: number;
  readonly userVersion: number;
  readonly integrity: string;
  readonly nodes: number;
  readonly settings: number;
}

/** The drill refused to touch the replica; nothing was read from the replica itself. */
export class DrillRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrillRefusal';
  }
}

/**
 * The generation a restore must read, or a refusal. A live owner (a holder
 * that has not released, even a crashed one that has not expired yet) means
 * the prefix is in use: the drill must use a copy under another prefix.
 */
export async function drillGeneration(
  store: ConditionalStore,
  prefix: string
): Promise<number> {
  let body: string | null;
  try {
    body = (await store.get(ownerKey(prefix)))?.body ?? null;
  } catch {
    throw new DrillRefusal(
      'The owner record could not be read from object storage, so a live owner cannot be ruled out. Check the endpoint and credentials.'
    );
  }
  if (body === null) return 0;
  try {
    const record = parseOwner(body);
    if (record.holder !== null)
      throw new DrillRefusal(
        `Prefix ${prefix} has a live owner (generation ${record.generation}). Restore drills never run against a prefix in use: copy the replica to another prefix and pass --prefix <other>, or stop every instance and let it release ownership first.`
      );
    return record.replica;
  } catch (error) {
    if (error instanceof OwnerRecordError)
      throw new DrillRefusal(
        `The owner record is unreadable (${error.message}), so a live owner cannot be ruled out.`
      );
    throw error;
  }
}

function count(db: Database, table: string): number {
  const row = db
    .query<{ n: number }, []>(`select count(*) as n from ${table}`)
    .get();
  return row?.n ?? 0;
}

/**
 * Checks the restored file; only counts leave this function. It is a private
 * temporary copy, and a read-only open cannot create the WAL index a restored
 * write-ahead-log database needs, so it is opened normally.
 */
export function inspectRestored(
  path: string
): Pick<DrillReport, 'userVersion' | 'integrity' | 'nodes' | 'settings'> {
  const db = new Database(path);
  try {
    const check = db
      .query<{ integrity_check: string }, []>('pragma integrity_check')
      .get();
    const version = db
      .query<{ user_version: number }, []>('pragma user_version')
      .get();
    return {
      userVersion: version?.user_version ?? 0,
      integrity: check?.integrity_check ?? 'missing',
      nodes: count(db, 'nodes'),
      settings: count(db, 'settings'),
    };
  } finally {
    db.close();
  }
}

function inspect(path: string): ReturnType<typeof inspectRestored> {
  try {
    return inspectRestored(path);
  } catch {
    throw new StartupError(
      'restore',
      'The restored file could not be read as a Fleet database (damaged, or not a Fleet schema); the replica is not restorable.'
    );
  }
}

export interface DrillInput {
  readonly store: ConditionalStore;
  readonly storage: StorageConfig;
  readonly binary: string;
}

/** Restores the authoritative generation into a temporary directory and checks it. */
export async function runDrill(input: DrillInput): Promise<DrillReport> {
  const { storage } = input;
  const generation = await drillGeneration(input.store, storage.prefix);
  const directory = mkdtempSync(join(tmpdir(), 'fleet-restore-drill-'));
  try {
    const target: StorageConfig = {
      ...storage,
      path: join(directory, 'drill.db'),
      prefix: generationPrefix(storage.prefix, generation),
    };
    const args = [
      'restore',
      ...configArgs(directory, 'restore', target),
      target.path,
    ];
    if ((await runBounded(input.binary, args, target)) !== 0)
      throw new StartupError(
        'restore',
        `Litestream restore of generation ${generation} under ${storage.prefix} failed. Check the Litestream error above, the bucket, prefix and credentials, and that a replica exists there.`
      );
    const inspected = inspect(target.path);
    if (inspected.integrity !== 'ok')
      throw new StartupError(
        'restore',
        'The restored database failed PRAGMA integrity_check; the replica is not restorable.'
      );
    return { prefix: storage.prefix, generation, ...inspected };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** `--prefix <name>` or `--prefix=<name>`; nothing else is accepted. */
export function drillPrefix(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  const joined = args[0]?.startsWith('--prefix=') && args.length === 1;
  const parts = joined
    ? ['--prefix', (args[0] as string).slice('--prefix='.length)]
    : args;
  if (parts.length !== 2 || parts[0] !== '--prefix' || !parts[1])
    throw new ConfigurationError([
      'usage: bun run restore:drill [--prefix <other-prefix>]',
    ]);
  return parts[1];
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const override = drillPrefix(process.argv.slice(2));
  const storage = readStorage(
    override === undefined
      ? process.env
      : { ...process.env, FLEET_S3_PREFIX: override },
    problems
  );
  if (problems.length) throw new ConfigurationError(problems);
  const binary = await litestreamBinary();
  const report = await runDrill({
    store: conditionalStoreFor(storage, process.env),
    storage,
    binary,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    const known =
      error instanceof ConfigurationError ||
      error instanceof StartupError ||
      error instanceof DrillRefusal;
    createLogger({ name: 'fleet-restore-drill', level: 'info' }).error(
      'restore drill failed',
      {
        error: known
          ? error.message
          : 'Unexpected failure; no replica was changed. Check FLEET_LITESTREAM_BIN, the endpoint and credentials.',
      }
    );
    process.exitCode = 1;
  });
