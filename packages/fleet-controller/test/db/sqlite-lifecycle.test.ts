import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDb } from '../../src/db/client';
import { SqliteStore } from '../../src/db/sqlite-store';
import { SqliteAccessStore } from '../../src/db/access-store';
import { heartbeatBody, nodeIdOf, registerInput } from '../support/fixtures';

async function exercise(path: string): Promise<void> {
  const options = { path };
  const db = await createDb(options);
  const store = new SqliteStore(db);
  const access = new SqliteAccessStore(db);
  await store.registerNode(registerInput(1, { approval: 'approved' }));
  await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, new Date());
  await store.putSettings(
    'fleet',
    { heartbeat: { intervalSeconds: 90 } },
    'owner'
  );
  await access.allow('owner@example.org', 'owner');
  await access.createSession(
    'session-hash',
    {
      email: 'owner@example.org',
      issuer: 'https://issuer.example',
      subject: 'owner',
    },
    new Date(Date.now() + 60000),
    'context'
  );
  await expect(
    db.begin(async (tx) => {
      await tx`delete from nodes`;
      await tx`delete from allowed_emails`;
      throw new Error('interrupted mutation');
    })
  ).rejects.toThrow('interrupted mutation');
  await db.close();
  const reopened = await createDb(options);
  try {
    const persisted = new SqliteStore(reopened);
    expect(await persisted.findNode(nodeIdOf(1))).toMatchObject({
      approval: 'approved',
    });
    expect(
      await persisted.listHeartbeats(nodeIdOf(1), new Date(0))
    ).toHaveLength(1);
    expect((await persisted.listEvents({ limit: 20 })).length).toBeGreaterThan(
      0
    );
    expect((await persisted.getSettings('fleet'))?.value).toEqual({
      heartbeat: { intervalSeconds: 90 },
    });
    expect(await persisted.settingsHistory('fleet', 10)).toHaveLength(1);
    expect(
      await new SqliteAccessStore(reopened).session('session-hash', 'context')
    ).toMatchObject({ allowed: true });
    await persisted.deleteNode(nodeIdOf(1), 'owner');
    expect(
      await persisted.listHeartbeats(nodeIdOf(1), new Date(0))
    ).toHaveLength(0);
    expect(
      (await persisted.listEvents({ limit: 20 })).every(
        (event) => event.nodeId === null
      )
    ).toBe(true);
  } finally {
    await reopened.close();
  }
}

describe('SQLite lifecycle', () => {
  test('reopening preserves application and authorization state; failed writes roll back and deletion cascades', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-'));
    try {
      await exercise(join(directory, 'portable #$? path', 'fleet.db'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses a database from a newer controller without modifying it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-version-'));
    const path = join(directory, 'fleet.db');
    try {
      const db = await createDb({ path });
      await db.unsafe('PRAGMA user_version = 999');
      await db.close();
      await expect(createDb({ path })).rejects.toThrow('newer');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
