import type { Context } from 'hono';
import type { AccessStore, BrowserAuth, RelayConfig } from './browser-contract';
import { emailAddress } from './browser-contract';
import { browserCookies } from './browser-cookies';
import { sha256Hex } from './hash';
import { relayClient, type RelayClient } from './relay-client';
import { safeNext } from '../ui/routes/guard';

const random = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const noncePattern = /^[A-Za-z0-9_-]{43}$/;

export class FleetBrowserAuth implements BrowserAuth {
  private readonly cookies;
  private readonly context: string;
  private readonly provider: RelayClient;
  constructor(
    readonly access: AccessStore,
    private readonly config: RelayConfig,
    client?: RelayClient
  ) {
    this.cookies = browserCookies(config.origin);
    this.context = sha256Hex(
      JSON.stringify([config.issuer, config.clientId, config.origin])
    );
    this.provider = client ?? relayClient(config);
  }
  async identity(c: Context) {
    const value = this.cookies.read(c);
    if (!value || !noncePattern.test(value)) return null;
    return this.access.session(sha256Hex(value), this.context);
  }
  async begin(c: Context): Promise<Response> {
    const state = random(),
      nonce = random(),
      verifier = random(),
      binding = random();
    try {
      const destination = await this.provider.authorize(state, nonce, verifier);
      await this.access.saveLogin({
        stateHash: sha256Hex(state),
        bindingHash: sha256Hex(binding),
        nonce,
        verifier,
        next: safeNext(c.req.query('next')),
        expires: new Date(Date.now() + 600000),
      });
      this.cookies.bind(c, state, binding);
      return c.redirect(destination, 303);
    } catch {
      return c.redirect('/login?error=unavailable', 303);
    }
  }
  async callback(c: Context): Promise<Response> {
    const state = c.req.query('state') ?? '';
    if (!noncePattern.test(state))
      return c.redirect('/login?error=failed', 303);
    const binding = this.cookies.readBinding(c, state);
    this.cookies.unbind(c, state);
    if (!binding || !noncePattern.test(binding))
      return c.redirect('/login?error=failed', 303);
    try {
      const tx = await this.access.consumeLogin(
        sha256Hex(state),
        sha256Hex(binding)
      );
      if (!tx) throw new Error('Expired or consumed login');
      const url = new URL(`${this.config.origin}/auth/callback`);
      url.search = new URL(c.req.url).search;
      const claims = await this.provider.exchange(
        url,
        state,
        tx.nonce,
        tx.verifier
      );
      const identity = verifiedIdentity(claims, this.config.issuer);
      await this.logout(c);
      const token = random();
      await this.access.createSession(
        sha256Hex(token),
        identity,
        new Date(Date.now() + 43200000),
        this.context
      );
      this.cookies.set(c, token);
      return c.redirect(
        (await this.access.session(sha256Hex(token), this.context))?.allowed
          ? safeNext(tx.next)
          : '/not-allowed',
        303
      );
    } catch {
      return c.redirect('/login?error=failed', 303);
    }
  }
  async logout(c: Context): Promise<void> {
    const token = this.cookies.read(c);
    try {
      if (token && noncePattern.test(token))
        await this.access.deleteSession(sha256Hex(token));
    } finally {
      this.cookies.clear(c);
    }
  }
}

function verifiedIdentity(claims: Record<string, unknown>, issuer: string) {
  const email = emailAddress(claims['email']);
  if (
    !email ||
    claims['email_verified'] !== true ||
    claims['iss'] !== issuer ||
    typeof claims['sub'] !== 'string' ||
    !claims['sub']
  )
    throw new Error('Unverified identity');
  return { issuer, subject: claims['sub'], email };
}
