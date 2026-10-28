import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileWriteGate, openGateUntil } from '../../src/ownership/write-gate';
import { describeController } from '../support/describe-controller';

describeController('write gate', (ctx) => {
  test('a closed gate answers 503 with Retry-After for reads and writes, but not /health', async () => {
    let open = false;
    const h = ctx().harness({ controller: { writable: () => open } });
    for (const [method, path] of [
      ['GET', '/v1/nodes'],
      ['PUT', '/v1/settings/fleet'],
      ['POST', '/v1/heartbeat'],
    ] as const) {
      const reply = await h.admin(
        method,
        path,
        method === 'GET' ? undefined : {}
      );
      expect(reply.status).toBe(503);
      expect(reply.body.error).toBe('not_writer');
      expect(reply.headers.get('retry-after')).toBe('5');
    }
    expect((await h.call('GET', '/health')).status).toBe(200);
    open = true;
    expect((await h.admin('GET', '/v1/nodes')).status).toBe(200);
  });
});

test('the gate file closes when missing, unreadable, expired or zeroed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-gate-'));
  try {
    const path = join(directory, 'gate');
    let now = 1_000;
    const writable = fileWriteGate(path, () => now);
    expect(writable()).toBe(false);
    openGateUntil(path, 2_000);
    expect(writable()).toBe(true);
    now = 2_000; // A process resuming after a pause sees the deadline passed.
    expect(writable()).toBe(false);
    openGateUntil(path, 5_000);
    now = 1_500;
    expect(writable()).toBe(true);
    openGateUntil(path, 0);
    expect(writable()).toBe(false);
    rmSync(path);
    expect(writable()).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
