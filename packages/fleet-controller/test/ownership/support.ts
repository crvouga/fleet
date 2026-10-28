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
} from '../../src/ownership/object-store';

/** Conditional-write semantics of S3/R2, with fault injection. */
export class MemoryStore implements ConditionalStore {
  readonly objects = new Map<string, { body: string; etag: string }>();
  private counter = 0;
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
    this.objects.set(key, { body, etag });
    return { ok: true as const, etag };
  }

  async remove(key: string) {
    this.check('delete');
    this.objects.delete(key);
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
