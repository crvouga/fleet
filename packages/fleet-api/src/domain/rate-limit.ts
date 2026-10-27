export interface RateLimitOptions {
  /** Requests allowed per key in one window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Epoch milliseconds. Injected so tests control time. */
  readonly now: () => number;
  /** Bound on remembered keys; the oldest are dropped past it. */
  readonly maxKeys?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/** Fixed-window limiter held in memory: one process, one window per key. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  hit(key: string): RateLimitDecision {
    const now = this.options.now();
    const existing = this.buckets.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.remember(
        key,
        { count: 1, resetAt: now + this.options.windowMs },
        now
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count <= this.options.limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.resetAt - now) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  private remember(key: string, bucket: Bucket, now: number): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    const max = this.options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (this.buckets.size <= max) return;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= max) break;
      this.buckets.delete(k);
    }
  }
}
