import { GithubError } from './errors';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openUntil: Date | null;
}

export interface Circuit {
  /** Throws a temporary error while the circuit is open. */
  check(): void;
  success(): void;
  /** `waitMs`: what GitHub said to wait (rate limits open the circuit at once). */
  failure(waitMs: number | null): void;
  snapshot(): CircuitSnapshot;
}

export interface CircuitOptions {
  readonly now: () => Date;
  /** Consecutive temporary failures before the circuit opens. */
  readonly threshold?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_BASE_MS = 5_000;
const DEFAULT_MAX_MS = 5 * 60_000;

/**
 * Stops calling GitHub while it is failing: after `threshold` consecutive
 * temporary failures (or one rate limit) every call fails fast until the wait
 * is over. The next call after that is the probe; its result closes or reopens.
 */
export function createCircuit(options: CircuitOptions): Circuit {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  let failures = 0;
  let openUntil = 0;
  const clock = () => options.now().getTime();
  return {
    check() {
      if (clock() >= openUntil) return;
      throw new GithubError(
        'FLEET_GITHUB_UNAVAILABLE',
        'GitHub calls are paused after repeated failures; retrying automatically',
        { temporary: true, retryAfterMs: openUntil - clock() }
      );
    },
    success() {
      failures = 0;
      openUntil = 0;
    },
    failure(waitMs) {
      failures += 1;
      const backoff = Math.min(
        maxMs,
        baseMs * 2 ** Math.max(0, failures - threshold)
      );
      if (waitMs !== null) {
        openUntil = clock() + Math.min(maxMs, waitMs);
      } else if (failures >= threshold) {
        openUntil = clock() + backoff;
      }
    },
    snapshot() {
      const open = clock() < openUntil;
      const probing = failures >= threshold && !open;
      return {
        state: open ? 'open' : probing ? 'half-open' : 'closed',
        consecutiveFailures: failures,
        openUntil: open ? new Date(openUntil) : null,
      };
    },
  };
}
