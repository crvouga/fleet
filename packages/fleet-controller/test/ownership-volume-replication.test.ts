import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import {
  enabled,
  healthy,
  integrityOf,
  killAll,
  newPrefix,
  read,
  seedLegacyReplica,
  startInstance,
  stop,
  write,
} from './support/ownership-drill';

const directories: string[] = [];
afterEach(() => {
  killAll();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!enabled)('persistent volume generation changes', () => {
  test('a retained database starts a new replica without the previous generation LTX files', async () => {
    const prefix = newPrefix();
    const directory = mkdtempSync(join(tmpdir(), 'fleet-volume-'));
    directories.push(directory);
    seedLegacyReplica(prefix, 31, directory);
    seedLegacyReplica(prefix, 32, directory);
    // Keep a real legacy working database and its index, but prune one old LTX.
    const metadata = join(directory, '.fleet.db-litestream');
    expect(existsSync(metadata)).toBe(true);
    const files = readdirSync(join(metadata, 'ltx'), { recursive: true })
      .filter((file) => typeof file === 'string' && file.endsWith('.ltx'))
      .sort();
    expect(files.length).toBeGreaterThan(1);
    rmSync(join(metadata, 'ltx', String(files[0])));
    const first = await startInstance(prefix, { directory });
    await healthy(first);
    expect(await write(first, 31)).toBe(200);
    expect(await stop(first)).toBe(0);
    const second = await startInstance(prefix, { directory });
    await healthy(second);
    expect(await read(second)).toBe(31);
    expect(await write(second, 32)).toBe(200);
    expect(await stop(second)).toBe(0);

    // A host with no local files must restore every acknowledged value.
    const fresh = await startInstance(prefix);
    await healthy(fresh);
    expect(await read(fresh)).toBe(32);
    expect(await stop(fresh)).toBe(0);
    expect(integrityOf(fresh.directory)).toEqual({ integrity_check: 'ok' });
    const restored = new Database(join(fresh.directory, 'fleet.db'), {
      readonly: true,
    });
    try {
      expect(restored.query('select v from legacy order by v').all()).toEqual([
        { v: 31 },
        { v: 32 },
      ]);
    } finally {
      restored.close();
    }
  }, 180_000);
});
