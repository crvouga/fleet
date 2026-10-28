import { existsSync } from 'node:fs';
import { StartupError, databaseFailure } from '../startup-error';
import { createLogger } from '@pkgs/logger';

import { isAccessRole, type AccessRole } from '../auth/roles';
import { ConfigurationError } from '../env';
import {
  checkLocalWrite,
  conditionalStoreFor,
  ownershipUnchanged,
  type WriteVerdict,
} from '../ownership/access-guard';
import { readStorage } from '../storage';
import { createDb } from './client';
import { SqliteAccessStore } from './access-store';

/** Refuses unless this local write provably cannot be a second writer of the replica. */
async function proveNotASecondWriter(
  storage: ReturnType<typeof readStorage>
): Promise<Extract<WriteVerdict, { allowed: true }>> {
  const verdict = await checkLocalWrite(
    conditionalStoreFor(storage, process.env),
    storage
  );
  if (!verdict.allowed) throw new StartupError('access', verdict.reason);
  return verdict;
}

async function writeAccess(
  storage: ReturnType<typeof readStorage>,
  email: string,
  role: AccessRole
): Promise<void> {
  const db = await createDb(storage);
  try {
    const access = new SqliteAccessStore(db);
    await access.allow(email, 'owner-cli', role);
    // An owner repairing access may promote (or demote) a person who is already listed.
    const result = await access.setRole(email, role, 'owner-cli');
    if (result === 'last_admin')
      throw new ConfigurationError([
        'the last administrator cannot be demoted; allow another admin first',
      ]);
  } finally {
    await db.close();
  }
}

function readRequest(problems: string[]): { email: string; role: string } {
  const email = process.argv[2]?.trim().toLowerCase() ?? '';
  const role = process.argv[3]?.trim().toLowerCase() ?? 'admin';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    problems.push(
      'usage: bun run access:allow owner@example.org [admin|viewer]'
    );
  if (!isAccessRole(role))
    problems.push('the role must be admin (the default) or viewer');
  return { email, role };
}

/** An explicit owner command, never automatic authorization on first browser login. */
async function main(): Promise<void> {
  const problems: string[] = [];
  const storage = readStorage(process.env, problems);
  const { email, role } = readRequest(problems);
  if (problems.length) throw new ConfigurationError(problems);
  if (!existsSync(storage.path))
    throw new StartupError(
      'access',
      'The SQLite working file does not exist. Start Fleet to restore/initialize it first, then run access:allow with the same deployment.env and FLEET_DATABASE_PATH.'
    );
  // Before opening the file: opening it already migrates (writes) it.
  const proof = await proveNotASecondWriter(storage);
  await writeAccess(storage, email, role as AccessRole);
  const store = conditionalStoreFor(storage, process.env);
  if (!(await ownershipUnchanged(store, storage.prefix, proof)))
    throw new StartupError(
      'access',
      'Ownership of the replica changed while the local file was being written, so the change may be lost. Check the result with GET /v1/access and repeat it with PUT /v1/access/:email.'
    );
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
