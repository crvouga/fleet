import * as oidc from 'openid-client';
import type { RelayConfig } from './browser-contract';

export interface RelayClient {
  authorize(state: string, nonce: string, verifier: string): Promise<string>;
  exchange(
    url: URL,
    state: string,
    nonce: string,
    verifier: string
  ): Promise<Record<string, unknown>>;
}

/** Public client, code + S256 PKCE only. Discovery/JWT validation is library-owned. */
export function relayClient(
  config: RelayConfig,
  customFetch: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response> = fetch
): RelayClient {
  let pending: Promise<oidc.Configuration> | undefined;
  function provider(): Promise<oidc.Configuration> {
    pending ??= oidc
      .discovery(
        new URL(config.issuer),
        config.clientId,
        undefined,
        undefined,
        {
          execute: [oidc.enableNonRepudiationChecks],
          [oidc.customFetch]: (url, init) =>
            customFetch(url, {
              ...init,
              body:
                init.body instanceof Uint8Array
                  ? new Uint8Array(init.body).buffer
                  : (init.body ?? null),
              signal: AbortSignal.timeout(5000),
              redirect: 'error',
            }),
        }
      )
      .catch(() => {
        pending = undefined;
        throw new Error('Authentication relay unavailable');
      });
    return pending;
  }
  return {
    async authorize(state, nonce, verifier) {
      return oidc.buildAuthorizationUrl(await provider(), {
        redirect_uri: `${config.origin}/auth/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        prompt: 'select_account',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }).href;
    },
    async exchange(url, state, nonce, verifier) {
      // A timed-out or rejected one-time code is never retried.
      const tokens = await oidc.authorizationCodeGrant(await provider(), url, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('Missing verified identity');
      return claims;
    },
  };
}
