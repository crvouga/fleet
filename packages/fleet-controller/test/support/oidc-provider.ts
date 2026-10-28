/** Deterministic standards-shaped provider: independent signing keys, single-use codes. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createOidcClient } from '../../src/auth/oidc-client';
import type { OidcConfig } from '../../src/auth/browser-contract';

interface Grant {
  nonce: string;
  challenge: string;
  email: string;
}
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const key = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'mock-key',
  use: 'sig',
  alg: 'RS256',
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
function signedToken(config: OidcConfig, tx: Grant) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: 'RS256', kid: key.kid })}.${encode({ iss: config.issuer, aud: config.clientId, sub: `subject-${tx.email}`, email: tx.email, email_verified: true, nonce: tx.nonce, iat: now, exp: now + 300 })}`;
  return json({
    access_token: 'unused',
    token_type: 'Bearer',
    id_token: `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`,
  });
}
function validRequest(
  config: OidcConfig,
  params: URLSearchParams,
  tx: Grant | undefined
): tx is Grant {
  const challenge = createHash('sha256')
    .update(params.get('code_verifier') ?? '')
    .digest('base64url');
  return (
    !!tx &&
    tx.challenge === challenge &&
    params.get('client_id') === config.clientId &&
    params.get('redirect_uri') === `${config.origin}/auth/callback`
  );
}
export function mockIdentityProvider(config: OidcConfig) {
  const codes = new Map<string, Grant>();
  const client = createOidcClient(config, async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration'))
      return json({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}/authorize`,
        token_endpoint: `${config.issuer}/token`,
        jwks_uri: `${config.issuer}/certs`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none'],
        subject_types_supported: ['public'],
      });
    if (url.endsWith('/certs')) return json({ keys: [key] });
    if (!url.endsWith('/token')) throw new Error('Unexpected provider request');
    const params = new URLSearchParams(await new Response(init?.body).text());
    const code = params.get('code') ?? '';
    const tx = codes.get(code);
    codes.delete(code);
    if (!validRequest(config, params, tx))
      return new Response('', { status: 400 });
    return signedToken(config, tx);
  });
  return {
    client,
    authorize(url: URL, email: string) {
      if (url.searchParams.get('code_challenge_method') !== 'S256')
        throw new Error('Wrong authorization flow');
      const code = crypto.randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        email,
      });
      const callback = new URL(`${config.origin}/auth/callback`);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', code);
      return callback.href;
    },
  };
}
