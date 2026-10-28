import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../src/db/client';
import { SCHEMA_VERSION } from '../../src/db/migrations';
import { ConfigurationError } from '../../src/env';
import {
  DrillRefusal,
  drillGeneration,
  drillPrefix,
  inspectRestored,
  runDrill,
} from '../../src/ownership/restore-drill';
import { ownerKey, serializeOwner } from '../../src/ownership/record';
import { MemoryStore, PREFIX } from './support';

const directory = mkdtempSync(join(tmpdir(), 'fleet-drill-unit-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const record = (extra: Record<string, unknown>) =>
  serializeOwner({
    version: 1,
    generation: 5,
    holder: null,
    handoverTo: null,
    beat: 1,
    replica: 4,
    ...extra,
  } as never);

/** The error a promise rejects with (null when it resolves). */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

async function storeWith(body?: string) {
  const store = new MemoryStore();
  if (body !== undefined)
    await store.put(ownerKey(PREFIX), body, { ifNoneMatch: '*' });
  return store;
}

describe('restore drill refusal', () => {
  test('refuses a prefix with a live owner, whoever holds it', async () => {
    const store = await storeWith(record({ holder: 'instance-a' }));
    const refusal = await failure(drillGeneration(store, PREFIX));
    expect(refusal).toBeInstanceOf(DrillRefusal);
    const message = (refusal as DrillRefusal).message;
    expect(message).toContain('--prefix');
    expect(message).not.toContain('instance-a');
  });

  test('refuses when the owner record cannot be read or understood', async () => {
    const down = await storeWith();
    down.down = true;
    expect(await failure(drillGeneration(down, PREFIX))).toBeInstanceOf(
      DrillRefusal
    );
    for (const body of ['nonsense', '{"version":9}'])
      expect(
        await failure(drillGeneration(await storeWith(body), PREFIX))
      ).toBeInstanceOf(DrillRefusal);
  });

  test('restores the authoritative generation of a released prefix', async () => {
    expect(await drillGeneration(await storeWith(record({})), PREFIX)).toBe(4);
    expect(
      await drillGeneration(await storeWith(record({ replica: 0 })), PREFIX)
    ).toBe(0);
  });

  test('a prefix without an owner record is the pre-ownership generation 0 replica', async () => {
    expect(await drillGeneration(await storeWith(), PREFIX)).toBe(0);
  });

  test('a refused drill never starts Litestream', async () => {
    const store = await storeWith(record({ holder: 'instance-a' }));
    const run = runDrill({
      store,
      storage: {
        path: join(directory, 'never.db'),
        bucket: 'b',
        prefix: PREFIX,
        region: 'us-east-1',
        replicated: true,
        startupTimeoutMs: 1000,
      },
      binary: '/nonexistent/litestream',
    });
    await expect(run).rejects.toBeInstanceOf(DrillRefusal);
  });
});

describe('restore drill arguments and inspection', () => {
  test('--prefix is the only accepted argument', () => {
    expect(drillPrefix([])).toBeUndefined();
    expect(drillPrefix(['--prefix', 'fleet-api/drill-1'])).toBe(
      'fleet-api/drill-1'
    );
    expect(drillPrefix(['--prefix=fleet-api/drill-2'])).toBe(
      'fleet-api/drill-2'
    );
    for (const bad of [
      ['--prefix'],
      ['--prefix='],
      ['--prefix', 'a', 'b'],
      ['--yes'],
      ['other'],
    ])
      expect(() => drillPrefix(bad)).toThrow(ConfigurationError);
  });

  test('reports only versions and counts, and fails integrity on a damaged file', async () => {
    const path = join(directory, 'restored.db');
    const db = await createDb({ path });
    await db`insert into settings (scope, value) values ('fleet', '{}')`;
    await db.close();
    const report = inspectRestored(path);
    expect(report).toMatchObject({
      userVersion: SCHEMA_VERSION,
      integrity: 'ok',
      nodes: 0,
      settings: 1,
    });
    expect(Object.keys(report).sort()).toEqual([
      'integrity',
      'nodes',
      'settings',
      'userVersion',
    ]);
    const damaged = join(directory, 'damaged.db');
    writeFileSync(damaged, 'this is not a database'.repeat(200));
    expect(() => inspectRestored(damaged)).toThrow();
  });
});
