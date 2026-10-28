import type { Logger } from '@pkgs/logger';

import type { ErrorRing } from './errors';
import type { FilingEnv } from './env';
import type { IssueStore } from './store';

/** Delivery tuning. Tests inject small, deterministic values. */
export interface IssueTuning {
  /** First retry delay; doubles per attempt up to `capMs`. */
  readonly baseMs: number;
  readonly capMs: number;
  /** Delivery attempts before a report becomes `failed`. */
  readonly maxAttempts: number;
  /** One HTTP call. */
  readonly timeoutMs: number;
  /** How long a claimed attempt may run before another may start. */
  readonly leaseMs: number;
  /** The longest wait GitHub may ask for with Retry-After. */
  readonly maxRetryAfterMs: number;
  /** A recurrence comment at most this often per issue. */
  readonly commentEveryMs: number;
}

export const DEFAULT_TUNING: IssueTuning = {
  baseMs: 30_000,
  capMs: 3_600_000,
  maxAttempts: 8,
  timeoutMs: 10_000,
  leaseMs: 120_000,
  maxRetryAfterMs: 7_200_000,
  commentEveryMs: 24 * 3_600_000,
};

export type IssueFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/** What routes, pages and the retry job share. Built once at boot. */
export interface IssuesRuntime {
  readonly store: IssueStore;
  /** Null when the operator has not configured filing (no token): previews and drafts still work. */
  readonly config: FilingEnv | null;
  /** `owner/name` when known, with or without a token: enough for a prefilled "new issue" link. */
  readonly repository: string | null;
  /** Where the prefilled link points: the repository's web origin. */
  readonly webOrigin: string;
  readonly errors: ErrorRing;
  readonly now: () => Date;
  readonly fetch: IssueFetch;
  readonly log: Logger;
  readonly random: () => number;
  readonly tuning: IssueTuning;
  /** Secret values the redactor must remove from every report. */
  readonly literals: readonly string[];
}
