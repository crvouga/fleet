import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { readControllerEnv } from '../src/env';
import { configArgs } from '../src/litestream';

const directory = mkdtempSync(join(tmpdir(), 'fleet-metadata-'));
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('initial, continuous and final sync share metadata only within a generation', () => {
  const storage = readControllerEnv({
    FLEET_ADMIN_TOKEN: 'a'.repeat(32),
    FLEET_S3_BUCKET: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  }).storage;
  const metadata = (prefix: string): string => {
    configArgs(directory, 'replica', { ...storage, prefix });
    return parse(readFileSync(join(directory, 'replica.yml'), 'utf8')).dbs[0][
      'meta-path'
    ];
  };
  const first = metadata('app/generations/1');
  expect(dirname(first)).toBe(directory);
  expect(metadata('app/generations/1')).toBe(first);
  expect(metadata('app/generations/2')).not.toBe(first);
});
