import { existsSync } from 'node:fs';
import { StartupError, databaseFailure } from '../startup-error';
import { createLogger } from '@pkgs/logger';

import { ConfigurationError } from '../env';
import { readStorage } from '../storage';
import { createDb } from './client';
import { SqliteAccessStore } from './access-store';

/** An explicit owner command, never automatic authorization on first browser login. */
async function main(): Promise<void> {
  const problems: string[] = [];
  const storage = readStorage(process.env, problems);
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    problems.push('usage: bun run access:allow owner@example.org');
  if (problems.length) throw new ConfigurationError(problems);
  if (!existsSync(storage.path))
    throw new StartupError(
      'access',
      'The SQLite working file does not exist. Start Fleet to restore/initialize it first, then run access:allow with the same deployment.env and FLEET_DATABASE_PATH.'
    );
  const db = await createDb(storage);
  try {
    await new SqliteAccessStore(db).allow(email as string, 'owner-cli');
  } finally {
    await db.close();
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    createLogger({ name: 'fleet-controller-access', level: 'info' }).error(
      'access update failed',
      {
        error:
          error instanceof ConfigurationError || error instanceof StartupError
            ? error.message
            : databaseFailure(error).message,
      }
    );
    process.exitCode = 1;
  });
