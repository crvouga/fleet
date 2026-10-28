import type { ConditionalStore } from './object-store';

/**
 * The single-writer record at `<prefix>/fleet-owner.json`. `generation` names
 * the replica path the holder writes: every new owner takes the next
 * generation and restores from the previous one, so two writers can never
 * write the same Litestream objects.
 */
export interface OwnerRecord {
  readonly version: 1;
  readonly generation: number;
  /** null: released; the next claimant takes over without waiting. */
  readonly holder: string | null;
  /** A starting instance asks the holder to hand over to it. */
  readonly handoverTo: string | null;
  /** Bumped on every renewal so waiting instances can see the holder is alive. */
  readonly beat: number;
  /**
   * The generation whose replica is authoritative. A new owner restores from it
   * and only advances it to its own generation after its initial sync succeeds,
   * so a claimant that fails early never strands the data in an empty generation.
   */
  readonly replica: number;
}

/** The owner record cannot be trusted; never guess, refuse to write. */
export class OwnerRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerRecordError';
  }
}

export const OWNER_FILE = 'fleet-owner.json';

export const ownerKey = (prefix: string) => `${prefix}/${OWNER_FILE}`;

/** Generation 0 is the replica written directly under the prefix before ownership existed. */
export function generationPrefix(prefix: string, generation: number): string {
  return generation === 0 ? prefix : `${prefix}/generations/${generation}`;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isHolder = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length > 0);

/** A record written by another version or tampered with is never trusted. */
export function parseOwner(body: string): OwnerRecord {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OwnerRecordError('owner record is not JSON');
  }
  if (typeof value !== 'object' || value === null)
    throw new OwnerRecordError('owner record is not an object');
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    !isCount(record['generation']) ||
    !isCount(record['beat']) ||
    !isCount(record['replica']) ||
    !isHolder(record['holder']) ||
    !isHolder(record['handoverTo'])
  )
    throw new OwnerRecordError(
      'owner record is unreadable; another Fleet version may own this prefix'
    );
  return record as unknown as OwnerRecord;
}

export const serializeOwner = (record: OwnerRecord) => JSON.stringify(record);

/**
 * Fails closed when the provider ignores conditional writes: without them two
 * instances could both believe they own the replica.
 */
export async function verifyConditionalWrites(
  store: ConditionalStore,
  prefix: string,
  instance: string
): Promise<boolean> {
  // Per-instance key: simultaneous starts must not fail each other's probe.
  const key = `${prefix}/probes/${instance}.json`;
  const created = await store.put(key, '{}', { ifNoneMatch: '*' });
  if (!created.ok) return false;
  const duplicate = await store.put(key, '{}', { ifNoneMatch: '*' });
  const stale = await store.put(key, '{}', { ifMatch: '"fleet-stale"' });
  await store.remove(key);
  return !duplicate.ok && !stale.ok;
}
