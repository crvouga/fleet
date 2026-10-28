import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createOidcClient } from '../../src/auth/oidc-client';

const config = {
  issuer: 'https://auth.example.test/realms/projects',
  origin: 'https://fleet.example.test',
  clientId: 'fleet',
};

test('HTTP OIDC is refused by default and the explicit emulator exception only accepts loopback', async () => {
  const transport = async () => {
    throw new Error('Network must not be reached');
  };
  const http = {
    ...config,
    issuer: 'http://127.0.0.1:8810',
    origin: 'http://127.0.0.1:3000',
  };
  await expect(
    createOidcClient(http, transport).authorize('state', 'nonce', 'verifier')
  ).rejects.toThrow();
  for (const invalid of [
    config,
    { ...http, issuer: 'http://id.example.test' },
    { ...http, origin: 'http://0.0.0.0:3000' },
  ])
    expect(() => createOidcClient(invalid, transport, true)).toThrow(
      'Emulated OIDC must stay on HTTP loopback'
    );
});
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
function mockProvider(
  overrides: Record<string, unknown> = {},
  badSignature = false,
  unavailable = false,
  providerConfig = config
) {
  let calls = 0;
  const verifier = 'v'.repeat(43),
    state = 's'.repeat(43),
    nonce = 'n'.repeat(43);
  const client = createOidcClient(providerConfig, async (input, init) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.endsWith('/.well-known/openid-configuration'))
      return json({
        issuer: providerConfig.issuer,
        authorization_endpoint: `${providerConfig.issuer}/authorize`,
        token_endpoint: `${providerConfig.issuer}/token`,
        jwks_uri: `${providerConfig.issuer}/certs`,
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
    expect(params.get('redirect_uri')).toBe(
      `${providerConfig.origin}/auth/callback`
    );
    expect(params.get('client_id')).toBe(providerConfig.clientId);
    expect(params.get('client_secret')).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const data = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: providerConfig.issuer, aud: providerConfig.clientId, sub: 'pool-user', email: 'admin@example.test', email_verified: true, nonce, iat: now, exp: now + 300, ...overrides })}`;
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
    `${providerConfig.origin}/auth/callback?code=single-use&state=${state}`
  );
  return { client, verifier, nonce, state, callback, calls: () => calls };
}

test('wire OIDC uses only the provider, S256 PKCE and independently signed provider-issued identity claims', async () => {
  const w = mockProvider();
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
    const w = mockProvider(overrides);
    await expect(
      w.client.exchange(w.callback, w.state, w.nonce, w.verifier)
    ).rejects.toThrow();
    expect(w.calls()).toBe(1);
  }
  const broken = mockProvider({}, true);
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
  const wrong = mockProvider();
  await expect(
    wrong.client.exchange(
      wrong.callback,
      'wrong-state',
      wrong.nonce,
      wrong.verifier
    )
  ).rejects.toThrow();
  expect(wrong.calls()).toBe(0);
  const down = mockProvider({}, false, true);
  await expect(
    down.client.exchange(down.callback, down.state, down.nonce, down.verifier)
  ).rejects.toThrow();
  expect(down.calls()).toBe(1);
});

for (const issuer of [
  'https://accounts.example.test',
  'https://id.example.test/pools/deployment',
]) {
  test(`the identity provider and transport are injected for ${issuer}`, async () => {
    const current = { ...config, issuer, clientId: 'operator-owned-client' };
    const w = mockProvider({}, false, false, current);
    const url = new URL(await w.client.authorize(w.state, w.nonce, w.verifier));
    expect(url.origin).toBe(new URL(issuer).origin);
    expect(url.searchParams.get('client_id')).toBe(current.clientId);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    const claims = await w.client.exchange(
      w.callback,
      w.state,
      w.nonce,
      w.verifier
    );
    expect(claims['iss']).toBe(issuer);
    expect(claims['sub']).toBe('pool-user');
    expect(w.calls()).toBe(1);
  });
}
