import { createLogger } from '@pkgs/logger';

import type { VirtualClock } from './clock';

export { VirtualClock, flush } from './clock';

import {
  DEFAULT_TIMING,
  type OwnershipContext,
} from '../../src/ownership/acquire';
import {
  ObjectStoreError,
  type ConditionalStore,
  type ListedObject,
} from '../../src/ownership/object-store';

/** Conditional-write semantics of S3/R2, with fault injection. */
export class MemoryStore implements ConditionalStore {
  readonly objects = new Map<
    string,
    { body: string; etag: string; modified?: number }
  >();
  private counter = 0;
  /** The storage server's clock (epoch ms), reported as LastModified. */
  wall = (): number => Date.now();
  /** Called before every remove; throw to inject a failure or change state mid-sweep. */
  onRemove: (key: string) => void | Promise<void> = () => {};
  /** Every key removed, in order. */
  readonly removed: string[] = [];
  /** Listings are served in pages of this size, like S3 continuation tokens. */
  listPageSize = 1000;
  /** Number of list requests served (one per page). */
  listRequests = 0;
  /** Every operation throws while true: an object-storage outage. */
  down = false;
  /** A provider that silently ignores If-Match / If-None-Match. */
  ignoreConditions = false;

  private check(operation: string): void {
    if (this.down) throw new ObjectStoreError(operation, 'unavailable');
  }

  async get(key: string) {
    this.check('read');
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    body: string,
    condition: { ifNoneMatch: '*' } | { ifMatch: string }
  ) {
    this.check('write');
    const current = this.objects.get(key);
    const allowed =
      this.ignoreConditions ||
      ('ifNoneMatch' in condition
        ? current === undefined
        : current?.etag === condition.ifMatch);
    if (!allowed) return { ok: false as const };
    this.counter += 1;
    const etag = `"e${this.counter}"`;
    this.objects.set(key, { body, etag, modified: this.wall() });
    return { ok: true as const, etag };
  }

  async remove(key: string) {
    this.check('delete');
    await this.onRemove(key);
    this.objects.delete(key);
    this.removed.push(key);
  }

  /** Places an object last modified `ageMs` ago. */
  seed(key: string, ageMs: number): void {
    this.counter += 1;
    this.objects.set(key, {
      body: '',
      etag: `"s${this.counter}"`,
      modified: this.wall() - ageMs,
    });
  }

  async list(prefix: string): Promise<ListedObject[]> {
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const found: ListedObject[] = [];
    for (let at = 0; at === 0 || at < keys.length; at += this.listPageSize) {
      this.check('list');
      this.listRequests += 1;
      for (const key of keys.slice(at, at + this.listPageSize))
        found.push({
          key,
          lastModified: this.objects.get(key)?.modified ?? this.wall(),
        });
    }
    return found;
  }
}

export const PREFIX = 'fleet-api/production';

export function contextFor(
  instance: string,
  store: MemoryStore,
  clock: VirtualClock,
  stop: { stopped: boolean } = { stopped: false }
): OwnershipContext {
  return {
    store,
    prefix: PREFIX,
    instance,
    timing: DEFAULT_TIMING,
    now: clock.now,
    sleep: clock.sleep,
    stopped: () => stop.stopped,
    log: createLogger({ name: 'ownership-test', level: 'silent' }),
  };
}
