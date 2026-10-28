import { describe, expect, test } from 'bun:test';

import {
  ConfigurationError,
  readControllerEnv,
  type EnvSource,
} from '../src/env';

import { sha256 } from './support/fixtures';

const VALID: EnvSource = {
  FLEET_S3_BUCKET: 'test-bucket',
  AWS_ACCESS_KEY_ID: 'test-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret',
  FLEET_ADMIN_TOKEN: 'a'.repeat(32),
  FLEET_SESSION_SECRET: 'b'.repeat(32),
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
      ownership: {
        renewMs: 5_000,
        expireMs: 30_000,
        fenceMs: 20_000,
        pollMs: 2_000,
      },
      port: 8080,
      adminToken: 'a'.repeat(32),
      enrollmentTokens: [],
      github: { apiUrl: 'https://api.github.com' },
    });
  });
  test('validates writer ownership timing', () => {
    expect(
      readControllerEnv({
        ...VALID,
        FLEET_OWNERSHIP_RENEW_SECONDS: '1',
        FLEET_OWNERSHIP_EXPIRE_SECONDS: '15',
      }).ownership
    ).toEqual({ renewMs: 1000, expireMs: 15000, fenceMs: 10000, pollMs: 1000 });
    for (const [key, value] of [
      ['FLEET_OWNERSHIP_RENEW_SECONDS', '0'],
      ['FLEET_OWNERSHIP_EXPIRE_SECONDS', '14'],
      ['FLEET_OWNERSHIP_EXPIRE_SECONDS', '10s'],
      ['FLEET_OWNERSHIP_RENEW_SECONDS', '10'],
    ])
      expect(() =>
        readControllerEnv({ ...VALID, [key as string]: value })
      ).toThrow('FLEET_OWNERSHIP_');
  });

  test('core configuration needs no GitHub repository and supports an operator target revision', () => {
    const env = readControllerEnv({
      ...VALID,
      FLEET_TARGET_REVISION: 'a'.repeat(40),
    });
    expect(env.targetRevision).toBe('a'.repeat(40));
  });

  test('reads every optional setting', () => {
    const env = readControllerEnv({
      ...VALID,
      PORT: '9000',
      VAULT_ADDR: 'https://vault.example.com/',
      FLEET_ENROLLMENT_TOKENS: JSON.stringify([
        { sha256: sha256('x').toUpperCase(), role: 'ci' },
        { sha256: sha256('y'), role: null },
        { sha256: sha256('z') },
      ]),
    });
    expect(env).toMatchObject({
      port: 9000,
      enrollmentTokens: [
        { sha256: sha256('x'), role: 'ci' },
        { sha256: sha256('y'), role: null },
        { sha256: sha256('z'), role: null },
      ],
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

  test('refuses the retired role token hashes and names the replacement', () => {
    for (const value of ['{}', JSON.stringify({ ci: sha256('x') })]) {
      const message = problems({ ...VALID, FLEET_ROLE_TOKEN_HASHES: value });
      expect(message).toContain(
        'FLEET_ROLE_TOKEN_HASHES is no longer supported'
      );
      expect(message).toContain('FLEET_ENROLLMENT_TOKENS');
    }
    expect(
      readControllerEnv({ ...VALID, FLEET_ROLE_TOKEN_HASHES: ' ' })
    ).toBeDefined();
  });

  test('refuses malformed enrollment tokens', () => {
    const bad = (value: unknown) =>
      problems({ ...VALID, FLEET_ENROLLMENT_TOKENS: JSON.stringify(value) });
    expect(problems({ ...VALID, FLEET_ENROLLMENT_TOKENS: 'nope' })).toContain(
      'JSON array'
    );
    expect(bad({ sha256: sha256('x') })).toContain('JSON array');
    expect(bad([{ sha256: 'abc', role: 'ci' }])).toContain('64 hex');
    expect(bad([{ sha256: sha256('x'), role: 'gpu' }])).toContain(
      'active role or null'
    );
    expect(bad([{ sha256: sha256('x'), role: 'web' }])).toContain(
      'active role or null'
    );
    expect(bad([{ sha256: sha256('x'), role: 'ci', extra: 1 }])).toContain(
      'only have the keys'
    );
    expect(
      bad([
        { sha256: sha256('x'), role: 'ci' },
        { sha256: sha256('x'), role: null },
      ])
    ).toContain('more than once');
    expect(
      bad(
        Array.from({ length: 17 }, (_, i) => ({
          sha256: sha256(String(i)),
          role: null,
        }))
      )
    ).toContain('at most 16');
  });

  test('refuses invalid ports and removed pooler settings', () => {
    expect(problems({ ...VALID, PORT: '0' })).toContain('PORT');
    expect(problems({ ...VALID, PORT: 'http' })).toContain('PORT');
    expect(problems({ ...VALID, PORT: '70000' })).toContain('PORT');
    expect(problems({ ...VALID, FLEET_DB_PREPARE: 'maybe' })).toContain(
      'FLEET_DB_PREPARE'
    );
  });

  test('never prints a secret value, even when the value is the problem', () => {
    const message = problems({
      DATABASE_URL: 'mysql://user:hunter2-secret@db/app',
      FLEET_ADMIN_TOKEN: 'tiny-admin-secret',
      FLEET_SESSION_SECRET: 'tiny-session-secret',
      FLEET_ENROLLMENT_TOKENS: '[{"sha256":"super-secret-not-hex"}]',
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

test('browser login accepts only a complete OIDC configuration and exact HTTPS/loopback origins', () => {
  const settings = {
    ...VALID,
    FLEET_OIDC_ISSUER: 'https://auth.example.test/realms/fleet',
    FLEET_OIDC_CLIENT_ID: 'app-id',
    FLEET_PUBLIC_ORIGIN: 'http://localhost:5173',
  };
  expect(readControllerEnv(settings).oidc?.origin).toBe(
    'http://localhost:5173'
  );
  expect(
    readControllerEnv({
      ...settings,
      FLEET_PUBLIC_ORIGIN: 'http://127.0.0.1:8082',
    }).oidc
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
    }).oidc?.issuer
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
      }).oidc?.issuer
    ).toBe(issuer);
  }
});
