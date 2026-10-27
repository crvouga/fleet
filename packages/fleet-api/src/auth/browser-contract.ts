import type { Context } from 'hono';

export interface FleetIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly allowed: boolean;
}
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
    identity: Omit<FleetIdentity, 'allowed'>,
    expires: Date,
    context: string
  ): Promise<void>;
  session(hash: string, context: string): Promise<FleetIdentity | null>;
  deleteSession(hash: string): Promise<void>;
  emails(): Promise<readonly string[]>;
  allow(email: string, actor: string): Promise<void>;
  revoke(email: string, actor: string): Promise<boolean>;
}
export interface BrowserAuth {
  identity(c: Context): Promise<FleetIdentity | null>;
  begin(c: Context): Promise<Response>;
  callback(c: Context): Promise<Response>;
  logout(c: Context): Promise<void>;
  readonly access: AccessStore;
}
export interface RelayConfig {
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
