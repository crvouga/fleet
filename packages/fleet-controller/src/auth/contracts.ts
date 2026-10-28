import type { AdminAuth } from '../deps';
import type { AccessStore, BrowserAuth, OidcConfig } from './browser-contract';

/** Trusted deployment composition, supplied once before the listener starts. */
export interface AuthContext {
  readonly adminToken: string;
  readonly access: AccessStore;
  readonly oidc?: OidcConfig;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>;
  readonly now: () => Date;
}

export interface AuthServices {
  readonly auth: AdminAuth;
  readonly browserAuth?: BrowserAuth;
}

export type AuthFactory = (context: AuthContext) => AuthServices;
