import type { Context } from 'hono';
import type { AccessStore, BrowserAuth } from './auth/browser-contract';
import type { AccessRole } from './auth/roles';

import type { EnrollmentTokenEntry } from './auth/enrollment-token';
import type { GithubEnv } from './github/env';
import type { GithubRuntime } from './github/runtime';
import type { IssuesEnv } from './issues/env';
import type { IssuesRuntime } from './issues/runtime';
import type { Store } from './store';

/** Everything read from the environment, parsed once at boot. */
export interface AppEnv {
  /** Bearer token for scripts and CI (`bun run health`). */
  readonly adminToken: string;
  /** Accepted alongside `adminToken` while it is rotated without downtime. */
  readonly adminTokenNext?: string | undefined;
  /** A node that presents one of these tokens is approved; the entry's role is assigned if it has none. */
  readonly enrollmentTokens: readonly EnrollmentTokenEntry[];
  /** Optional operator-supplied desired revision; no provider lookup. */
  readonly targetRevision?: string;
  readonly installerDir?: string;
  /** Operator-supplied GitHub App key, webhook secret and API origin (src/github/env.ts). */
  readonly github?: GithubEnv;
  /** Operator-supplied token and repository for filing issues (src/issues/env.ts). Optional. */
  readonly issues?: IssuesEnv;
}

/** Who is making an administrative request. Implemented in src/auth. */
export interface AdminAuth {
  /** The actor for a Bearer token or a valid session cookie, else null. */
  actor(c: Context): Promise<string | null>;
  /**
   * The actor's role: the admin token is an admin, a session takes its
   * allowlist role. Absent means every authenticated actor is an admin
   * (in-memory fixtures only).
   */
  role?(c: Context): Promise<AccessRole | null>;
  /** A Set-Cookie header value that clears the session. */
  logoutCookie(): string;
  /** True when a state-changing request came from this site (Origin check). */
  sameOrigin(c: Context): boolean;
}

/** The newest commit on main, for "behind" badges. Cached by the implementation. */
export interface RevisionSource {
  latest(): Promise<string | null>;
}

export interface AppDeps {
  /** Present when the controller runs the GitHub integration (not in synthetic fixtures). */
  readonly github?: GithubRuntime;
  /** One-click issue reporting: drafts, delivery and recent controller errors (src/issues). */
  readonly issues?: IssuesRuntime;
  readonly browserAuth?: BrowserAuth;
  /** The browser allowlist, also present while browser login is off. */
  readonly access?: AccessStore;
  readonly store: Store;
  readonly auth: AdminAuth;
  readonly revisions: RevisionSource;
  readonly env: AppEnv;
  readonly now: () => Date;
}
