import type { Context } from 'hono';

import type { AccessRole } from './roles';

export interface FleetIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly allowed: boolean;
  /** The allowlist role at this moment; a demotion applies to live sessions at once. */
  readonly role: AccessRole;
}
/** One allowlisted person, for the access page. */
export interface AccessEntry {
  readonly email: string;
  readonly role: AccessRole;
  readonly addedBy: string;
  readonly addedAt: Date;
}
export type RoleChange = 'changed' | 'unchanged' | 'last_admin' | 'missing';
export interface LoginTransaction {
  readonly stateHash: string;
  readonly bindingHash: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly next: string;
  readonly expires: Date;
}
export interface AccessStore {
  saveLogin(input: LoginTransaction): Promise<void>;
  consumeLogin(
    stateHash: string,
    bindingHash: string
  ): Promise<LoginTransaction | null>;
  createSession(
    hash: string,
    identity: Omit<FleetIdentity, 'allowed' | 'role'>,
    expires: Date,
    context: string
  ): Promise<void>;
  session(hash: string, context: string): Promise<FleetIdentity | null>;
  deleteSession(hash: string): Promise<void>;
  emails(): Promise<readonly string[]>;
  /** Every allowlisted person with their role. */
  entries(): Promise<readonly AccessEntry[]>;
  /** Adds the person (default role admin); an existing entry is left as it is. */
  allow(email: string, actor: string, role?: AccessRole): Promise<void>;
  /** Removes the person. False when absent or when they are the last admin. */
  revoke(email: string, actor: string): Promise<boolean>;
  /** Changes a role. The last admin cannot be demoted. */
  setRole(email: string, role: AccessRole, actor: string): Promise<RoleChange>;
}
export interface BrowserAuth {
  identity(c: Context): Promise<FleetIdentity | null>;
  begin(c: Context): Promise<Response>;
  callback(c: Context): Promise<Response>;
  logout(c: Context): Promise<void>;
  readonly access: AccessStore;
}
/** Trusted adapter: exchange returns only cryptographically validated OIDC claims. */
export interface IdentityProvider {
  authorize(state: string, nonce: string, verifier: string): Promise<string>;
  exchange(
    url: URL,
    state: string,
    nonce: string,
    verifier: string
  ): Promise<Record<string, unknown>>;
}

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly origin: string;
}
export function emailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(
      email
    )
    ? email
    : null;
}
