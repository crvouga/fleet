import * as oidc from 'openid-client';
import type { OidcConfig, IdentityProvider } from './browser-contract';

function requireLoopback(config: OidcConfig) {
  for (const value of [config.issuer, config.origin]) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('Emulated OIDC must stay on HTTP loopback');
  }
}

/** Public client, code + S256 PKCE only. Discovery/JWT validation is library-owned. */
export function createOidcClient(
  config: OidcConfig,
  customFetch: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>,
  allowLoopbackHttp = false
): IdentityProvider {
  if (allowLoopbackHttp) requireLoopback(config);
  let pending: Promise<oidc.Configuration> | undefined;
  function provider(): Promise<oidc.Configuration> {
    pending ??= oidc
      .discovery(
        new URL(config.issuer),
        config.clientId,
        undefined,
        undefined,
        {
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(allowLoopbackHttp ? [oidc.allowInsecureRequests] : []),
          ],
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
        throw new Error('Identity provider unavailable');
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
