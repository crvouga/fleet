import { describe, expect, test } from 'bun:test';

import { ConfigurationError, readControllerEnv, type EnvSource } from '../src/env';

import { sha256 } from './support/fixtures';

const VALID: EnvSource = {
  FLEET_S3_BUCKET: 'test-bucket',
  AWS_ACCESS_KEY_ID: 'test-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret',
  FLEET_GITHUB_REPO: 'example/fleet',
  FLEET_ADMIN_TOKEN: 'a'.repeat(32),
  FLEET_SESSION_SECRET: 'b'.repeat(32),
  FLEET_ROLE_TOKEN_HASHES: '{}',
};

function problems(source: EnvSource): string {
  try {
    readControllerEnv(source);
  } catch (err: unknown) {
    if (err instanceof ConfigurationError) return err.message;
    throw err;
  }
  throw new Error('expected the environment to be refused');
}

describe('readControllerEnv', () => {
  test('accepts the minimum and applies defaults', () => {
    expect(readControllerEnv(VALID)).toEqual({
      storage: expect.objectContaining({
        replicated: true,
        path: expect.stringContaining('fleet.db'),
      }),
      port: 8080,
      adminToken: 'a'.repeat(32),
      roleTokenHashes: {},
      githubRepo: 'example/fleet',
    });
  });

  test('reads every optional setting', () => {
    const env = readControllerEnv({
      ...VALID,
      PORT: '9000',
      VAULT_ADDR: 'https://vault.example.com/',
      FLEET_GITHUB_REPO: 'someone/else',
      FLEET_ROLE_TOKEN_HASHES: JSON.stringify({
        ci: sha256('x').toUpperCase(),
        web: sha256('y'),
      }),
    });
    expect(env).toMatchObject({
      port: 9000,
      githubRepo: 'someone/else',
      roleTokenHashes: { ci: sha256('x'), web: sha256('y') },
    });
  });

  test('trims whitespace and treats blank as unset', () => {
    const env = readControllerEnv({
      ...VALID,
      PORT: '  ',
      VAULT_ADDR: '',
    });
    expect(env.port).toBe(8080);
    expect(env).not.toHaveProperty('vaultAddr');
    expect(env.githubRepo).toBe('example/fleet');
  });

  test('names every missing variable at once', () => {
    const message = problems({});
    for (const name of ['FLEET_ADMIN_TOKEN']) {
      expect(message).toContain(name);
    }
  });

  test('refuses short secrets', () => {
    expect(problems({ ...VALID, FLEET_ADMIN_TOKEN: 'a'.repeat(31) })).toContain(
      'FLEET_ADMIN_TOKEN must be at least 32'
    );
  });

  test('refuses malformed role token hashes', () => {
    expect(problems({ ...VALID, FLEET_ROLE_TOKEN_HASHES: 'nope' })).toContain(
      'JSON object'
    );
    expect(problems({ ...VALID, FLEET_ROLE_TOKEN_HASHES: '[]' })).toContain(
      'JSON object'
    );
    expect(
      problems({ ...VALID, FLEET_ROLE_TOKEN_HASHES: '{"ci":"abc"}' })
    ).toContain('64 hex');
    expect(
      problems({
        ...VALID,
        FLEET_ROLE_TOKEN_HASHES: JSON.stringify({ gpu: sha256('x') }),
      })
    ).toContain('unknown role "gpu"');
  });

  test('refuses invalid ports, repositories and removed pooler settings', () => {
    expect(problems({ ...VALID, PORT: '0' })).toContain('PORT');
    expect(problems({ ...VALID, PORT: 'http' })).toContain('PORT');
    expect(problems({ ...VALID, PORT: '70000' })).toContain('PORT');
    expect(problems({ ...VALID, FLEET_GITHUB_REPO: 'no-slash' })).toContain(
      'FLEET_GITHUB_REPO'
    );
    expect(problems({ ...VALID, FLEET_DB_PREPARE: 'maybe' })).toContain(
      'FLEET_DB_PREPARE'
    );
  });

  test('never prints a secret value, even when the value is the problem', () => {
    const message = problems({
      DATABASE_URL: 'mysql://user:hunter2-secret@db/app',
      FLEET_ADMIN_TOKEN: 'tiny-admin-secret',
      FLEET_SESSION_SECRET: 'tiny-session-secret',
      FLEET_ROLE_TOKEN_HASHES: '{"ci":"super-secret-not-hex"}',
    });
    for (const secret of [
      'hunter2-secret',
      'tiny-admin-secret',
      'tiny-session-secret',
      'super-secret-not-hex',
    ]) {
      expect(message).not.toContain(secret);
    }
  });
});

test('browser login accepts only a complete relay configuration and exact HTTPS/loopback origins', () => {
  const settings = {
    ...VALID,
    FLEET_OIDC_ISSUER: 'https://auth.example.test/realms/fleet',
    FLEET_OIDC_CLIENT_ID: 'app-id',
    FLEET_PUBLIC_ORIGIN: 'http://localhost:5173',
  };
  expect(readControllerEnv(settings).relay?.origin).toBe('http://localhost:5173');
  expect(
    readControllerEnv({ ...settings, FLEET_PUBLIC_ORIGIN: 'http://127.0.0.1:8082' })
      .relay
  ).toBeDefined();
  for (const bad of [
    'http://fleet.example',
    'https://fleet.example/path',
    'https://fleet.example/',
  ])
    expect(problems({ ...settings, FLEET_PUBLIC_ORIGIN: bad })).toContain(
      'FLEET_PUBLIC_ORIGIN'
    );
  for (const bad of [
    'http://auth.example.test/realms/fleet',
    'https://auth.example/realms/fleet?x=1',
  ])
    expect(problems({ ...settings, FLEET_OIDC_ISSUER: bad })).toContain(
      'FLEET_OIDC_ISSUER'
    );
  expect(
    readControllerEnv({
      ...settings,
      FLEET_OIDC_ISSUER: 'https://login.example.org/tenant/v2.0',
    }).relay?.issuer
  ).toBe('https://login.example.org/tenant/v2.0');
  expect(problems({ ...settings, FLEET_OIDC_CLIENT_ID: '' })).toContain(
    'FLEET_OIDC_CLIENT_ID'
  );
  expect(
    readControllerEnv({ ...VALID, VAULT_ADDR: 'invalid-and-unused' })
  ).not.toHaveProperty('vaultAddr');
});

// OIDC issuer identifiers are exact strings: URL.href adds a slash to roots.
test('browser login preserves root issuer identifiers with and without a slash', () => {
  for (const issuer of [
    'https://identity.example.org',
    'https://identity.example.org/',
  ]) {
    expect(
      readControllerEnv({
        ...VALID,
        FLEET_OIDC_ISSUER: issuer,
        FLEET_OIDC_CLIENT_ID: 'public-client',
        FLEET_PUBLIC_ORIGIN: 'https://fleet.example.org',
      }).relay?.issuer
    ).toBe(issuer);
  }
});
