import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { readControllerEnv } from '../src/env';
import { litestreamConfig } from '../src/start';

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
});
