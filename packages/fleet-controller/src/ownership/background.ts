import type { Logger } from '@pkgs/logger';

import type { OwnershipContext } from './acquire';
import type { Lease } from './lease';
import { generationPrefix } from './record';
import { startRetention } from './retention';
import type { RetentionPolicy } from './retention-policy';
import { startSyncMonitor } from './replica-sync';

/** A timer that never keeps the process alive: background work must not delay exit. */
const idleSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

export interface BackgroundInput {
  readonly ctx: OwnershipContext;
  readonly lease: Lease;
  readonly policy: RetentionPolicy;
  readonly log: Logger;
  /** Litestream's loopback metrics port for this generation. */
  readonly metricsPort: number;
  /** Receives the wall time at which the replica last held everything committed. */
  readonly onSynced: (atWall: number) => void;
}

/**
 * Work that runs beside serving and must never affect it: the replica sync
 * monitor and old-generation cleanup. Start only after the generation is
 * published as the authoritative replica.
 */
export function startBackground(input: BackgroundInput): { stop(): void } {
  const { ctx, lease } = input;
  const sync = startSyncMonitor({
    metricsUrl: `http://127.0.0.1:${input.metricsPort}/metrics`,
    list: () =>
      ctx.store.list(
        `${generationPrefix(ctx.prefix, lease.claim.generation)}/`
      ),
    wall: Date.now,
    onSynced: input.onSynced,
    sleep: idleSleep,
    log: input.log,
  });
  const retention = startRetention({
    ctx,
    lease,
    policy: input.policy,
    wall: Date.now,
    sleep: idleSleep,
  });
  return {
    stop: () => {
      sync.stop();
      retention.stop();
    },
  };
}
