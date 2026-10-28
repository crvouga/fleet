import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createRuntime as createS3 } from '@crvouga/mockingbird-service-s3';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../src/db/client';
import {
  checkLocalWrite,
  ownershipUnchanged,
} from '../../src/ownership/access-guard';
import { s3ConditionalStore } from '../../src/ownership/object-store';
import {
  ownerKey,
  serializeOwner,
  type OwnerRecord,
} from '../../src/ownership/record';
import { markGeneration } from '../../src/ownership/working-file';
import { MemoryStore, PREFIX } from './support';

const directory = mkdtempSync(join(tmpdir(), 'fleet-access-guard-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let counter = 0;
/** A local working file whose `.generation` marker is `generation` (undefined: no marker). */
function workingFile(generation?: number) {
  counter += 1;
  const path = join(directory, `fleet-${counter}.db`);
  writeFileSync(path, '');
  if (generation !== undefined) markGeneration(path, generation);
  return { path, prefix: PREFIX };
}

const base: OwnerRecord = {
  version: 1,
  generation: 3,
  holder: null,
  handoverTo: null,
  beat: 7,
  replica: 3,
};

async function seed(store: MemoryStore, record: Partial<OwnerRecord>) {
  const written = await store.put(
    ownerKey(PREFIX),
    serializeOwner({ ...base, ...record }),
    { ifNoneMatch: '*' }
  );
  if (!written.ok) throw new Error('seed failed');
}

const REFUSAL = 'PUT /v1/access/:email';

describe('access:allow guard (every local writer goes through ownership)', () => {
  test('refuses while a holder has not released, even one that may have crashed', async () => {
    const store = new MemoryStore();
    await seed(store, { holder: 'instance-a' });
    const verdict = await checkLocalWrite(store, workingFile(3));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain(REFUSAL);
      expect(verdict.reason).toContain('second writer');
      expect(verdict.reason).not.toContain('instance-a');
    }
  });

  test('refuses while a release is reserved for a starting instance', async () => {
    const store = new MemoryStore();
    await seed(store, { holder: null, handoverTo: 'instance-b' });
    const verdict = await checkLocalWrite(store, workingFile(3));
    expect(verdict.allowed).toBe(false);
  });

  test('refuses when the owner record is unreadable or foreign', async () => {
    for (const body of ['not json', '{"version":2}', '[]']) {
      const store = new MemoryStore();
      await store.put(ownerKey(PREFIX), body, { ifNoneMatch: '*' });
      const verdict = await checkLocalWrite(store, workingFile(3));
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toContain(REFUSAL);
    }
  });

  test('refuses when object storage cannot be read: unverifiable is never allowed', async () => {
    const store = new MemoryStore();
    store.down = true;
    const verdict = await checkLocalWrite(store, workingFile(3));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain('could not be read');
  });

  test('allows a released replica when the local file continues its authoritative generation', async () => {
    const store = new MemoryStore();
    await seed(store, { generation: 4, replica: 3 });
    const verdict = await checkLocalWrite(store, workingFile(3));
    expect(verdict.allowed).toBe(true);
  });

  test('refuses a stale local copy: the next restore would silently discard the change', async () => {
    const store = new MemoryStore();
    await seed(store, { replica: 3 });
    for (const marker of [2, 4, undefined]) {
      const verdict = await checkLocalWrite(store, workingFile(marker));
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toContain('generation 3');
    }
  });

  test('without an owner record the replica is generation 0: a marker-less or generation 0 file matches', async () => {
    const store = new MemoryStore();
    expect((await checkLocalWrite(store, workingFile())).allowed).toBe(true);
    expect((await checkLocalWrite(store, workingFile(0))).allowed).toBe(true);
    expect((await checkLocalWrite(store, workingFile(2))).allowed).toBe(false);
  });

  test('a change of ownership during the write is detected afterwards', async () => {
    const store = new MemoryStore();
    await seed(store, { replica: 3 });
    const target = workingFile(3);
    const verdict = await checkLocalWrite(store, target);
    if (!verdict.allowed) throw new Error('expected allowed');
    expect(await ownershipUnchanged(store, PREFIX, verdict)).toBe(true);
    const current = store.objects.get(ownerKey(PREFIX))!;
    await store.put(
      ownerKey(PREFIX),
      serializeOwner({ ...base, generation: 4, holder: 'instance-b' }),
      { ifMatch: current.etag }
    );
    expect(await ownershipUnchanged(store, PREFIX, verdict)).toBe(false);
    store.down = true;
    expect(await ownershipUnchanged(store, PREFIX, verdict)).toBe(false);
  });

  test('an owner record that appears during the write is detected for a never-owned prefix', async () => {
    const store = new MemoryStore();
    const verdict = await checkLocalWrite(store, workingFile());
    if (!verdict.allowed) throw new Error('expected allowed');
    expect(await ownershipUnchanged(store, PREFIX, verdict)).toBe(true);
    await seed(store, { holder: 'instance-a' });
    expect(await ownershipUnchanged(store, PREFIX, verdict)).toBe(false);
  });
});

/** The real CLI process, against a loopback S3 emulator with conditional writes. */
describe('bun src/db/allow-email.ts', () => {
  const s3 = createS3({
    buckets: ['guard-bucket'],
    credentials: { 'guard-key': 'guard-secret' },
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => s3.fetch(request),
  });
  afterAll(() => server.stop(true));
  const stores: string[] = [];
  afterEach(() => {
    for (const path of stores.splice(0))
      rmSync(path, { recursive: true, force: true });
  });

  async function putRecord(prefix: string, record: OwnerRecord) {
    const store = s3ConditionalStore(
      {
        path: '',
        bucket: 'guard-bucket',
        prefix,
        endpoint: `http://127.0.0.1:${server.port}`,
        region: 'us-east-1',
        replicated: true,
        startupTimeoutMs: 1000,
      },
      { accessKeyId: 'guard-key', secretAccessKey: 'guard-secret' }
    );
    const written = await store.put(ownerKey(prefix), serializeOwner(record), {
      ifNoneMatch: '*',
    });
    expect(written.ok).toBe(true);
  }

  async function run(prefix: string, generation: number) {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-allow-'));
    stores.push(dir);
    const path = join(dir, 'fleet.db');
    await (await createDb({ path })).close();
    markGeneration(path, generation);
    const child = Bun.spawn(
      [process.execPath, 'src/db/allow-email.ts', 'New.Admin@example.test'],
      {
        cwd: join(import.meta.dir, '../..'),
        env: {
          PATH: process.env['PATH'] ?? '',
          AWS_ACCESS_KEY_ID: 'guard-key',
          AWS_SECRET_ACCESS_KEY: 'guard-secret',
          FLEET_S3_BUCKET: 'guard-bucket',
          FLEET_S3_ENDPOINT: `http://127.0.0.1:${server.port}`,
          FLEET_S3_PREFIX: prefix,
          FLEET_DATABASE_PATH: path,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const output =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    const code = await child.exited;
    const db = new Database(path, { readonly: true });
    const rows = db
      .query("select email from allowed_emails where email like 'new.admin%'")
      .all();
    db.close();
    return { code, output, rows };
  }

  test('refuses and leaves the local file untouched while an owner is live', async () => {
    const prefix = `guard/${Math.random().toString(16).slice(2)}`;
    await putRecord(prefix, { ...base, holder: 'instance-a' });
    const result = await run(prefix, 3);
    expect(result.code).toBe(1);
    expect(result.output).toContain(REFUSAL);
    expect(result.rows).toHaveLength(0);
  });

  test('writes after a release when the local file continues the replica', async () => {
    const prefix = `guard/${Math.random().toString(16).slice(2)}`;
    await putRecord(prefix, { ...base, generation: 4, replica: 3 });
    const result = await run(prefix, 3);
    expect(result.output).not.toContain('access update failed');
    expect(result.code).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  test('refuses a stale local file after a release', async () => {
    const prefix = `guard/${Math.random().toString(16).slice(2)}`;
    await putRecord(prefix, { ...base, generation: 4, replica: 3 });
    const result = await run(prefix, 1);
    expect(result.code).toBe(1);
    expect(result.output).toContain('does not continue the authoritative');
    expect(result.rows).toHaveLength(0);
  });

  test('refuses when object storage is unreachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-allow-'));
    stores.push(dir);
    const path = join(dir, 'fleet.db');
    await (await createDb({ path })).close();
    const child = Bun.spawn(
      [process.execPath, 'src/db/allow-email.ts', 'someone@example.test'],
      {
        cwd: join(import.meta.dir, '../..'),
        env: {
          PATH: process.env['PATH'] ?? '',
          AWS_ACCESS_KEY_ID: 'guard-key',
          AWS_SECRET_ACCESS_KEY: 'guard-secret',
          FLEET_S3_BUCKET: 'guard-bucket',
          FLEET_S3_ENDPOINT: 'http://127.0.0.1:1',
          FLEET_S3_PREFIX: 'guard/none',
          FLEET_DATABASE_PATH: path,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const output =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    expect(await child.exited).toBe(1);
    expect(output).toContain(REFUSAL);
  }, 30_000);
});
