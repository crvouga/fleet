import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { ConfigurationError, readControllerEnv } from '../../src/env';
import { parseIntegration, parsePolicy } from '../../src/github/policy';
import { readGithubEnv } from '../../src/github/env';

const directory = mkdtempSync(join(tmpdir(), 'fleet-github-env-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const pkcs8 = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function read(source: Record<string, string>) {
  const problems: string[] = [];
  const env = readGithubEnv(source, problems);
  return { env, problems };
}

describe('GitHub environment', () => {
  test('is entirely optional', () => {
    const { env, problems } = read({});
    expect(problems).toEqual([]);
    expect(env.privateKey).toBeUndefined();
    expect(env.webhookSecret).toBeUndefined();
    expect(env.apiUrl).toBe('https://api.github.com');
  });

  test('reads the key from the variable, with escaped newlines, or from a file', () => {
    expect(
      read({ FLEET_GITHUB_APP_PRIVATE_KEY: pem }).env.privateKey
        ?.asymmetricKeyType
    ).toBe('rsa');
    expect(
      read({ FLEET_GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n') }).env
        .privateKey
    ).toBeDefined();
    const file = join(directory, 'app.pem');
    writeFileSync(file, pkcs8, { mode: 0o600 });
    expect(
      read({ FLEET_GITHUB_APP_PRIVATE_KEY_FILE: file }).env.privateKey
    ).toBeDefined();
  });

  test('refuses a bad key, two sources, a relative or missing file, without echoing the value', () => {
    const bad = read({
      FLEET_GITHUB_APP_PRIVATE_KEY: 'super-secret-not-a-key',
    });
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems.join()).not.toContain('super-secret');
    expect(
      read({
        FLEET_GITHUB_APP_PRIVATE_KEY: pem,
        FLEET_GITHUB_APP_PRIVATE_KEY_FILE: '/x',
      }).problems.join()
    ).toContain('only one');
    expect(
      read({
        FLEET_GITHUB_APP_PRIVATE_KEY_FILE: 'relative.pem',
      }).problems.join()
    ).toContain('absolute');
    expect(
      read({
        FLEET_GITHUB_APP_PRIVATE_KEY_FILE: join(directory, 'missing.pem'),
      }).problems.join()
    ).toContain('could not be read');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(read({ FLEET_GITHUB_APP_PRIVATE_KEY: ec }).problems).toHaveLength(1);
  });

  test('validates the webhook secret and the API origin', () => {
    expect(
      read({ FLEET_GITHUB_WEBHOOK_SECRET: 'short' }).problems.join()
    ).toContain('at least 16');
    expect(
      read({ FLEET_GITHUB_WEBHOOK_SECRET: 'x'.repeat(24) }).env.webhookSecret
    ).toHaveLength(24);
    expect(
      read({ FLEET_GITHUB_API_URL: 'http://github.example.com' }).problems
    ).toHaveLength(1);
    expect(
      read({ FLEET_GITHUB_API_URL: 'https://user:pw@ghe.example.com' }).problems
    ).toHaveLength(1);
    expect(
      read({ FLEET_GITHUB_API_URL: 'http://127.0.0.1:9999/' }).env.apiUrl
    ).toBe('http://127.0.0.1:9999');
    expect(
      read({ FLEET_GITHUB_API_URL: 'https://ghe.example.com/api/v3' }).env
        .apiUrl
    ).toBe('https://ghe.example.com/api/v3');
  });

  test('a problem fails controller startup with the variable named, never the value', () => {
    const source = {
      FLEET_ADMIN_TOKEN: 'a'.repeat(40),
      FLEET_DATABASE_PATH: join(directory, 'db'),
      FLEET_GITHUB_APP_PRIVATE_KEY: 'topsecret-material',
    };
    try {
      readControllerEnv(source);
      throw new Error('expected a ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain('GitHub App private key');
      expect((error as Error).message).not.toContain('topsecret');
    }
  });
});

describe('integration validation', () => {
  test('accepts a complete repository setup and defaults the policy', () => {
    const parsed = parseIntegration({
      scope: 'repository',
      repositories: ['a/b'],
      appId: '1',
      installationId: '2',
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        policy: {
          orphanAutoRemoval: false,
          orphanGraceSeconds: 1800,
          maxNodesPerRepository: 0,
          extraLabels: [],
        },
      },
    });
  });

  test('an organization needs a name; labels may not shadow the image’s', () => {
    expect(parseIntegration({ scope: 'organization' })).toMatchObject({
      ok: false,
    });
    expect(
      parseIntegration({
        scope: 'organization',
        organization: 'acme',
        runnerGroup: 'ci group',
      })
    ).toMatchObject({ ok: true });
    expect(parsePolicy({ extraLabels: ['gpu'] })).toMatchObject({ ok: false });
    expect(
      parsePolicy({ extraLabels: ['team-a'], syncIntervalSeconds: 5 })
    ).toMatchObject({ ok: false });
    expect(
      parsePolicy({ repositoryRequirements: { 'a/b': ['gpu'] } })
    ).toMatchObject({ ok: true });
    expect(
      parsePolicy({ repositoryRequirements: { bad: ['gpu'] } })
    ).toMatchObject({ ok: false });
  });
});
