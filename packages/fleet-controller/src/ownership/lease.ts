import { errorDetails } from '@pkgs/logger';

import type { Claim, OwnershipContext } from './acquire';
import {
  ownerKey,
  parseOwner,
  serializeOwner,
  type OwnerRecord,
} from './record';

/** What the holder should do after a renewal round. */
export type LeaseState = 'held' | 'handover' | 'lost';

/**
 * Held ownership of one generation. The holder renews on an interval, notices
 * hand-over requests, and fences itself (stops accepting writes) once it can
 * no longer prove ownership: before any waiter may consider it expired.
 */
export class Lease {
  private renewedAt: number;
  private state: LeaseState = 'held';
  private replicated = false;
  private replicaPublished = false;

  constructor(
    private readonly ctx: OwnershipContext,
    readonly claim: Claim
  ) {
    this.renewedAt = claim.since;
  }

  /** Monotonic time until which this holder may acknowledge writes. */
  writableUntil(): number {
    return this.state === 'lost' ? 0 : this.renewedAt + this.ctx.timing.fenceMs;
  }

  private ours(record: OwnerRecord): boolean {
    return (
      record.generation === this.claim.generation &&
      record.holder === this.ctx.instance
    );
  }

  /** False when the record changed underneath (a hand-over request); re-read at once. */
  private async renewOnce(): Promise<boolean> {
    // Taken before the request: storage cannot apply the renewal any earlier.
    const started = this.ctx.now();
    const found = await this.ctx.store.get(ownerKey(this.ctx.prefix));
    const record = found === null ? null : parseOwner(found.body);
    if (found === null || record === null || !this.ours(record)) {
      this.state = 'lost';
      return true;
    }
    const written = await this.ctx.store.put(
      ownerKey(this.ctx.prefix),
      serializeOwner({
        ...record,
        beat: record.beat + 1,
        replica: this.replicated ? this.claim.generation : record.replica,
      }),
      { ifMatch: found.etag }
    );
    if (!written.ok) return false;
    this.renewedAt = started;
    this.replicaPublished = this.replicated;
    if (record.handoverTo !== null && this.state === 'held')
      this.state = 'handover';
    return true;
  }

  /** One renewal round. Storage errors only matter once they outlast fenceMs. */
  async renew(): Promise<LeaseState> {
    if (this.state === 'lost') return this.state;
    try {
      for (let round = 0; round < 3 && !(await this.renewOnce()); round += 1);
    } catch (error) {
      this.ctx.log.warn('could not renew writer ownership', {
        generation: this.claim.generation,
        error: errorDetails(error),
      });
    }
    if (this.ctx.now() >= this.writableUntil()) this.state = 'lost';
    return this.state;
  }

  /**
   * Publishes this generation as the authoritative replica after its initial
   * sync. Must succeed before the worker acknowledges any write.
   */
  async confirmReplica(): Promise<boolean> {
    this.replicated = true;
    for (let attempt = 0; attempt < 5 && !this.replicaPublished; attempt += 1) {
      if ((await this.renew()) === 'lost') return false;
      if (!this.replicaPublished) await this.ctx.sleep(this.ctx.timing.pollMs);
    }
    return this.replicaPublished;
  }

  private async releaseOnce(): Promise<boolean> {
    const found = await this.ctx.store.get(ownerKey(this.ctx.prefix));
    if (found === null) return true;
    const record = parseOwner(found.body);
    if (!this.ours(record)) return true;
    const written = await this.ctx.store.put(
      ownerKey(this.ctx.prefix),
      serializeOwner({ ...record, holder: null, beat: record.beat + 1 }),
      { ifMatch: found.etag }
    );
    return written.ok;
  }

  /**
   * Gives ownership up after the final sync so the next instance starts at
   * once instead of waiting for expiry. Best effort: expiry remains the fallback.
   */
  async release(): Promise<void> {
    this.state = 'lost';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        if (await this.releaseOnce()) return;
      } catch (error) {
        this.ctx.log.warn('could not release writer ownership; retrying', {
          error: errorDetails(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.ctx.log.warn(
      'writer ownership was not released; the next instance takes over after expiry'
    );
  }
}
