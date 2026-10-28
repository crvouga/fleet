import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { relayClient } from '../../src/auth/relay-client';

const config = {
  issuer: 'https://auth.example.test/realms/projects',
  origin: 'https://fleet.example.test',
  clientId: 'fleet',
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'persistent-key',
  use: 'sig',
  alg: 'RS256',
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
function mockRelay(
  overrides: Record<string, unknown> = {},
  badSignature = false,
  unavailable = false
) {
  let calls = 0;
  const verifier = 'v'.repeat(43),
    state = 's'.repeat(43),
    nonce = 'n'.repeat(43);
  const client = relayClient(config, async (input, init) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      });
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
    if (url.endsWith('/certs')) return json({ keys: [jwk] });
    if (!url.endsWith('/token')) throw new Error('Unexpected destination');
    calls++;
    if (unavailable)
      throw new Error('Connection lost during one-time code exchange');
    const params = new URLSearchParams(await new Response(init?.body).text());
    expect(params.get('code_verifier')).toBe(verifier);
    expect(params.get('redirect_uri')).toBe(`${config.origin}/auth/callback`);
    expect(params.get('client_id')).toBe(config.clientId);
    expect(params.get('client_secret')).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const data = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: config.issuer, aud: config.clientId, sub: 'google-subject', email: 'admin@example.test', email_verified: true, nonce, iat: now, exp: now + 300, ...overrides })}`;
    const signature = sign('RSA-SHA256', Buffer.from(data), privateKey);
    if (badSignature) signature[0] = signature[0]! ^ 1;
    return json({
      access_token: 'unused-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: `${data}.${signature.toString('base64url')}`,
    });
  });
  const callback = new URL(
    `${config.origin}/auth/callback?code=single-use&state=${state}`
  );
  return { client, verifier, nonce, state, callback, calls: () => calls };
}

test('wire OIDC uses only the relay, S256 PKCE and independently signed Google-backed identity claims', async () => {
  const w = mockRelay();
  const url = new URL(await w.client.authorize(w.state, w.nonce, w.verifier));
  expect(url.origin).toBe('https://auth.example.test');
  expect(url.searchParams.has('kc_idp_hint')).toBe(false);
  expect(url.searchParams.get('prompt')).toBe('select_account');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBe(
    createHash('sha256').update(w.verifier).digest('base64url')
  );
  const claims = await w.client.exchange(
    w.callback,
    w.state,
    w.nonce,
    w.verifier
  );
  expect(claims['email']).toBe('admin@example.test');
  expect(w.calls()).toBe(1);
});

test('invalid signatures, nonce, issuer, audience and expiry cannot establish a session', async () => {
  for (const overrides of [
    { nonce: 'wrong' },
    { iss: 'https://evil.example' },
    { aud: 'another-app' },
    { exp: 1 },
  ]) {
    const w = mockRelay(overrides);
    await expect(
      w.client.exchange(w.callback, w.state, w.nonce, w.verifier)
    ).rejects.toThrow();
    expect(w.calls()).toBe(1);
  }
  const broken = mockRelay({}, true);
  await expect(
    broken.client.exchange(
      broken.callback,
      broken.state,
      broken.nonce,
      broken.verifier
    )
  ).rejects.toThrow();
});

test('state mismatch is refused and a network-ambiguous code exchange is never retried', async () => {
  const wrong = mockRelay();
  await expect(
    wrong.client.exchange(
      wrong.callback,
      'wrong-state',
      wrong.nonce,
      wrong.verifier
    )
  ).rejects.toThrow();
  expect(wrong.calls()).toBe(0);
  const down = mockRelay({}, false, true);
  await expect(
    down.client.exchange(down.callback, down.state, down.nonce, down.verifier)
  ).rejects.toThrow();
  expect(down.calls()).toBe(1);
});
