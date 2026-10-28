import { litestreamCredentials, type StorageConfig } from '../storage';
import { s3ConditionalStore, type ConditionalStore } from './object-store';
import { OwnerRecordError, ownerKey, parseOwner } from './record';
import { continuesGeneration } from './working-file';

type Source = Readonly<Record<string, string | undefined>>;

/** Whether a command may write to the local working file without becoming a second writer. */
export type WriteVerdict =
  | { readonly allowed: true; readonly etag: string | null }
  | { readonly allowed: false; readonly reason: string };

const API =
  'Use PUT /v1/access/:email with the admin token against the running service instead (hosted bootstrap); it goes through the owner.';

const refuse = (reason: string): WriteVerdict => ({
  allowed: false,
  reason: `${reason} ${API}`,
});

/** The conditional store for the configured replica, with the credentials Litestream uses. */
export function conditionalStoreFor(
  storage: StorageConfig,
  env: Source
): ConditionalStore {
  const credentials = litestreamCredentials(env);
  const sessionToken = env['AWS_SESSION_TOKEN']?.trim();
  return s3ConditionalStore(storage, {
    accessKeyId: credentials.AWS_ACCESS_KEY_ID,
    secretAccessKey: credentials.AWS_SECRET_ACCESS_KEY,
    ...(sessionToken ? { sessionToken } : {}),
  });
}

async function readRecord(store: ConditionalStore, prefix: string) {
  try {
    const found = await store.get(ownerKey(prefix));
    return found === null
      ? { kind: 'absent' as const }
      : {
          kind: 'record' as const,
          etag: found.etag,
          record: parseOwner(found.body),
        };
  } catch (error) {
    return {
      kind: 'unverified' as const,
      reason:
        error instanceof OwnerRecordError
          ? `The owner record under the prefix is unreadable (${error.message}).`
          : 'The owner record under the prefix could not be read from object storage.',
    };
  }
}

/**
 * Proves that a local write cannot be a second writer. A holder that has not
 * released ownership (even one that crashed and has not expired yet) means a
 * live instance may be writing; the local working file may also be a stale
 * copy that the next restore would discard. Anything unverifiable refuses:
 * there is no bypass.
 */
export async function checkLocalWrite(
  store: ConditionalStore,
  storage: Pick<StorageConfig, 'path' | 'prefix'>
): Promise<WriteVerdict> {
  const found = await readRecord(store, storage.prefix);
  if (found.kind === 'unverified') return refuse(found.reason);
  const authoritative = found.kind === 'absent' ? 0 : found.record.replica;
  if (found.kind === 'record') {
    const { holder, handoverTo, generation } = found.record;
    if (holder !== null)
      return refuse(
        `Generation ${generation} of this replica is owned by a running or recently crashed instance, so a local write would be a second writer.`
      );
    if (handoverTo !== null)
      return refuse(
        'A starting instance has just been handed the replica and is about to restore it, so a local write would be lost or race it.'
      );
  }
  if (!continuesGeneration(storage.path, authoritative))
    return refuse(
      `The local database file does not continue the authoritative replica (generation ${authoritative}); a change written to it would be discarded by the next restore.`
    );
  return {
    allowed: true,
    etag: found.kind === 'record' ? found.etag : null,
  };
}

/**
 * After the local write: true while the owner record is exactly as the check
 * saw it. False means an instance claimed the replica meanwhile and the
 * change may not survive.
 */
export async function ownershipUnchanged(
  store: ConditionalStore,
  prefix: string,
  verdict: Extract<WriteVerdict, { allowed: true }>
): Promise<boolean> {
  const found = await readRecord(store, prefix);
  if (found.kind === 'unverified') return false;
  return found.kind === 'absent'
    ? verdict.etag === null
    : found.etag === verdict.etag;
}
