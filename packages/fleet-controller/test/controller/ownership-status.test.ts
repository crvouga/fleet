import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OWNERSHIP_STATUS_ENV,
  resetOwnershipStatusCache,
  writeOwnershipStatus,
  type OwnershipStatus,
} from '../../src/ownership/status';
import { CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { T0 } from '../support/fixtures';
import { signInAs } from '../support/session';

const directory = mkdtempSync(join(tmpdir(), 'fleet-ownership-status-'));
const file = join(directory, 'ownership-status');
const status = (extra: Partial<OwnershipStatus> = {}): OwnershipStatus => ({
  state: 'held',
  generation: 7,
  holder: 'instance-a',
  renewedAtWall: T0.getTime() - 3_000,
  lastSyncAtWall: T0.getTime() - 1_500,
  replicaGeneration: 7,
  ...extra,
});
const supervise = (value: OwnershipStatus | string) => {
  resetOwnershipStatusCache();
  if (typeof value === 'string') writeFileSync(file, value);
  else writeOwnershipStatus(file, value);
  process.env[OWNERSHIP_STATUS_ENV] = file;
};

beforeEach(() => resetOwnershipStatusCache());
afterEach(() => {
  delete process.env[OWNERSHIP_STATUS_ENV];
  resetOwnershipStatusCache();
});

describeController('GET /v1/ownership and ownership metrics', (ctx) => {
  beforeEach(async () => {
    await ctx().db.sql.unsafe('delete from audit_log');
    ctx().h.clock.set(T0);
  });

  test('unsupervised: reports supervised false and adds no ownership series', async () => {
    const { h } = ctx();
    const reply = await h.admin('GET', '/v1/ownership');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ supervised: false });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect((await h.admin('GET', '/metrics')).text).not.toContain(
      'fleet_ownership'
    );
    expect((await h.admin('GET', '/metrics')).text).not.toContain(
      'fleet_replica_last_sync'
    );
  });

  test('supervised: the state, generation, holder and ages', async () => {
    const { h } = ctx();
    supervise(status());
    const reply = await h.admin('GET', '/v1/ownership');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      supervised: true,
      state: 'held',
      held: true,
      generation: 7,
      holder: 'instance-a',
      replicaGeneration: 7,
      renewalAgeSeconds: 3,
      replicaLastSyncAgeSeconds: 1.5,
    });
  });

  test('ages grow with time; a stale status is visible, not hidden', async () => {
    const { h } = ctx();
    supervise(status());
    h.clock.advance(120);
    const body = (await h.admin('GET', '/v1/ownership')).body;
    expect(body.renewalAgeSeconds).toBe(123);
    expect(body.replicaLastSyncAgeSeconds).toBe(121.5);
  });

  test('Prometheus series are valid samples with the documented names', async () => {
    const { h } = ctx();
    supervise(status());
    const text = (await h.admin('GET', '/metrics')).text;
    const lines = text.trimEnd().split('\n');
    for (const line of lines)
      expect(line).toMatch(
        /^(# (HELP|TYPE) fleet_\w+ .+|fleet_\w+(\{[a-z_]+="[^"\n]*"(,[a-z_]+="[^"\n]*")*\})? -?\d+(\.\d+)?)$/
      );
    expect(lines).toContain('fleet_ownership_held 1');
    expect(lines).toContain('fleet_ownership_generation 7');
    expect(lines).toContain('fleet_ownership_renewal_age_seconds 3');
    expect(lines).toContain('fleet_replica_last_sync_age_seconds 1.5');
    expect(text).toContain('# TYPE fleet_ownership_held gauge');
  });

  test('a handing-over or fenced instance is not held; a missing sync age omits that series', async () => {
    const { h } = ctx();
    supervise(status({ state: 'handover', lastSyncAtWall: null }));
    expect((await h.admin('GET', '/v1/ownership')).body).toMatchObject({
      state: 'handover',
      held: false,
      replicaLastSyncAgeSeconds: null,
    });
    const text = (await h.admin('GET', '/metrics')).text;
    expect(text).toContain('fleet_ownership_held 0');
    expect(text).not.toContain('fleet_replica_last_sync_age_seconds ');
    supervise(status({ state: 'lost' }));
    expect((await h.admin('GET', '/metrics')).text).toContain(
      'fleet_ownership_held 0'
    );
  });

  test('supervised but unreadable status: 503 on the route, held 0 in metrics, never a crash', async () => {
    const { h } = ctx();
    supervise('{ not json');
    const reply = await h.admin('GET', '/v1/ownership');
    expect(reply.status).toBe(503);
    expect(reply.body.error).toBe('ownership_unavailable');
    const metrics = await h.admin('GET', '/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('fleet_ownership_held 0');
    expect(metrics.text).not.toContain('fleet_ownership_generation');
  });

  test('only administrators may read it: anonymous 401, node 401, viewer 403 and audited, admin 200', async () => {
    const { h } = ctx();
    supervise(status());
    expect((await h.call('GET', '/v1/ownership')).status).toBe(401);
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    expect((await h.asNode(1, 'GET', '/v1/ownership')).status).toBe(401);
    const viewer = await signInAs(ctx(), 'viewer@example.test', 'viewer');
    const denied = await viewer.h.call('GET', '/v1/ownership', {
      headers: viewer.headers,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden');
    expect(denied.text).not.toContain('instance-a');
    const audit = await ctx().store.listAudit({
      actor: 'viewer@example.test',
      limit: 5,
    });
    expect(audit.map((entry) => entry.action)).toEqual(['ownership.read']);
    const admin = await signInAs(ctx(), 'admin@example.test', 'admin', 'a');
    const allowed = await admin.h.call('GET', '/v1/ownership', {
      headers: admin.headers,
    });
    expect(allowed.status).toBe(200);
    expect((await h.admin('GET', '/v1/ownership')).status).toBe(200);
  });

  test('/health is unchanged by ownership state', async () => {
    const { h } = ctx();
    supervise(status({ state: 'lost' }));
    const reply = await h.call('GET', '/health');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
  });
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
