import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { readControllerEnv } from '../src/env';
import { litestreamConfig } from '../src/start';
import { S3_ALIASES, litestreamCredentials } from '../src/storage';

const valid = {
  FLEET_ADMIN_TOKEN: 'a'.repeat(32),
  FLEET_S3_BUCKET: 'my-bucket',
  AWS_ACCESS_KEY_ID: 'key',
  AWS_SECRET_ACCESS_KEY: 'secret-$literal',
};

describe('single-node configuration', () => {
  test('reports all missing required settings with the template and corrective action', () => {
    for (const key of Object.keys(valid)) {
      expect(() => readControllerEnv({ ...valid, [key]: '' })).toThrow(
        `${key} is required`
      );
    }
    expect(() => readControllerEnv({})).toThrow('deployment.env');
    expect(readControllerEnv(valid).storage.replicated).toBe(true);
  });
  test('rejects removed backends and unreplicated mode even when their values are blank', () => {
    for (const key of [
      'DATABASE_URL',
      'FLEET_DB_PREPARE',
      'FLEET_DATABASE_URL',
      'FLEET_DATABASE_AUTH_TOKEN',
      'FLEET_STORAGE_MODE',
    ]) {
      expect(() => readControllerEnv({ ...valid, [key]: '' })).toThrow(
        `${key} was removed; unset it`
      );
    }
  });
  test('rejects invalid bucket names, prefixes, endpoints, regions and database paths', () => {
    const cases = [
      ['FLEET_S3_BUCKET', 's3://private-bucket'],
      ['FLEET_S3_BUCKET', 'UPPER'],
      ['FLEET_S3_BUCKET', 'a..b'],
      ['FLEET_S3_PREFIX', '../production'],
      ['FLEET_S3_PREFIX', '/fleet'],
      ['FLEET_S3_PREFIX', 'fleet//production'],
      ['FLEET_S3_ENDPOINT', 'https://user:private-secret@host'],
      ['FLEET_S3_ENDPOINT', 'https://host/path'],
      ['FLEET_S3_ENDPOINT', 'http://public.example'],
      ['AWS_REGION', 'not a region'],
      ['FLEET_STARTUP_TIMEOUT_SECONDS', '0'],
      ['FLEET_STARTUP_TIMEOUT_SECONDS', '10m'],
      ['FLEET_ADMIN_TOKEN', 'a'.repeat(32) + ' secret'],
      ['FLEET_DATABASE_PATH', 'libsql://host'],
      ['FLEET_DATABASE_PATH', ':memory:'],
      ['AWS_SECRET_ACCESS_KEY', 'secret\nline'],
    ];
    for (const [key, value] of cases) {
      expect(() =>
        readControllerEnv({ ...valid, [key as string]: value })
      ).toThrow(key);
    }
  });
  test('S3-compatible configuration preserves literal paths and excludes credentials', () => {
    const storage = readControllerEnv({
      ...valid,
      FLEET_DATABASE_PATH: '/tmp/db $literal/file.db',
      FLEET_S3_ENDPOINT: 'https://objects.example.org',
      FLEET_S3_PREFIX: 'my-app/$db',
      AWS_REGION: 'auto',
    }).storage;
    const text = litestreamConfig(storage);
    expect(text).not.toContain('secret-$literal');
    expect(parse(text)).toMatchObject({
      dbs: [
        {
          path: storage.path,
          replica: {
            type: 's3',
            bucket: 'my-bucket',
            path: 'my-app/$db',
            endpoint: 'https://objects.example.org',
            region: 'auto',
            'force-path-style': true,
          },
        },
      ],
    });
  });
  test('generic S3_* names configure storage when Fleet names are unset', () => {
    const storage = readControllerEnv({
      FLEET_ADMIN_TOKEN: 'a'.repeat(32),
      S3_BUCKET: 'shared-bucket',
      S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      S3_REGION: 'auto',
      S3_ACCESS_KEY_ID: 'alias-key',
      S3_SECRET_ACCESS_KEY: 'alias-secret',
    }).storage;
    expect(storage).toMatchObject({
      bucket: 'shared-bucket',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
    });
    expect(JSON.stringify(storage)).not.toContain('alias-secret');
    expect(
      litestreamCredentials({
        S3_ACCESS_KEY_ID: 'alias-key',
        S3_SECRET_ACCESS_KEY: 'alias-secret',
      })
    ).toEqual({
      AWS_ACCESS_KEY_ID: 'alias-key',
      AWS_SECRET_ACCESS_KEY: 'alias-secret',
    });
  });
  test('Fleet names win over equal aliases and conflicting aliases refuse startup', () => {
    expect(
      readControllerEnv({ ...valid, S3_BUCKET: 'my-bucket' }).storage.bucket
    ).toBe('my-bucket');
    for (const [key, alias] of Object.entries(S3_ALIASES)) {
      expect(() =>
        readControllerEnv({
          ...valid,
          [key]: 'https://one.example.org',
          [alias]: 'https://two.example.org',
        })
      ).toThrow(`${key} and ${alias} are both set to different values`);
    }
  });
  test('alias values are validated like Fleet names', () => {
    expect(() =>
      readControllerEnv({ ...valid, FLEET_S3_BUCKET: '', S3_BUCKET: 'UPPER' })
    ).toThrow('FLEET_S3_BUCKET must be a bucket name');
  });
});
