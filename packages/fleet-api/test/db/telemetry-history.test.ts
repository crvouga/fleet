import { expect, test } from 'bun:test';
import { describeStore } from '../support/describe-store';
import {
  at,
  heartbeatBody,
  nodeIdOf,
  registerInput,
} from '../support/fixtures';
import { maximumTelemetry, telemetry } from '../support/telemetry';
import {
  compactTelemetry,
  MAX_HISTORY_POINTS,
} from '../../src/domain/heartbeat-history';
import { MemoryStore } from '../../src/testing/memory-store';
describeStore('PgStore telemetry history', (ctx) => {
  test('maximum collections stay complete in facts but compact in persisted history and MemoryStore', async () => {
    const { store, db } = ctx();
    const registered = await store.registerNode(
      registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
    );
    const memory = new MemoryStore();
    memory.seedNode(registered.node);
    const full = maximumTelemetry();
    const body = heartbeatBody(1, { telemetry: full });
    await store.recordHeartbeat(nodeIdOf(1), body, null, at(0));
    await memory.recordHeartbeat(nodeIdOf(1), body, null, at(0));
    expect((await store.findNode(nodeIdOf(1)))?.facts['telemetry']).toEqual(
      full
    );
    expect((await memory.findNode(nodeIdOf(1)))?.facts['telemetry']).toEqual(
      full
    );
    const persisted =
      await db.sql`select telemetry from fleet.heartbeats where node_id = ${nodeIdOf(1)}`;
    expect(persisted[0]?.telemetry).toEqual(compactTelemetry(full));
    expect(JSON.stringify(persisted[0]?.telemetry).length).toBeLessThan(1200);
    const storedPoints = await store.listHeartbeats(nodeIdOf(1), at(-1));
    const memoryPoints = await memory.listHeartbeats(nodeIdOf(1), at(-1));
    expect(
      storedPoints.map((point) => ({
        at: point.at,
        telemetry: point.telemetry,
      }))
    ).toEqual(
      memoryPoints.map((point) => ({
        at: point.at,
        telemetry: point.telemetry,
      }))
    );
  });
  test('five-second reports return at most 1440 representative points across the whole day', async () => {
    const { store, db } = ctx();
    const registered = await store.registerNode(
      registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
    );
    const count = MAX_HISTORY_POINTS * 12;
    await db.sql`insert into fleet.heartbeats (node_id, at, load1)
      select ${nodeIdOf(1)}, ${at(0).toISOString()}::timestamptz + tick * interval '5 seconds', tick::real
      from generate_series(0, ${count - 1}::int) as tick`;
    const memory = new MemoryStore();
    memory.seedNode(
      registered.node,
      Array.from({ length: count }, (_, index) => ({
        at: at(index * 5),
        uptimeSeconds: null,
        load1: index,
        memUsedPercent: null,
        diskPercent: null,
        slots: null,
        busySlots: null,
      }))
    );
    const actual = await store.listHeartbeats(nodeIdOf(1), at(-1));
    const expected = await memory.listHeartbeats(nodeIdOf(1), at(-1));
    expect(actual.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS);
    expect(actual.map((point) => point.at)).toEqual(
      expected.map((point) => point.at)
    );
    expect(actual.at(-1)?.at).toEqual(at((count - 1) * 5));
    expect(actual[0]!.at.getTime() - at(0).getTime()).toBeLessThan(61_000);
  });
  test('readiness refuses a database missing the required additive schema', async () => {
    const { store, db } = ctx();
    await store.health();
    await db.sql`alter table fleet.heartbeats rename column telemetry to telemetry_pending_rollout`;
    const legacy = db.newStore({ prepare: false });
    try {
      await expect(legacy.store.health()).rejects.toThrow();
    } finally {
      await legacy.close();
      await db.sql`alter table fleet.heartbeats rename column telemetry_pending_rollout to telemetry`;
    }
    await store.health();
  });
  test('preserves measured samples in facts and history alongside legacy agents', async () => {
    const { store } = ctx();
    await store.registerNode(
      registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
    );
    const sample = telemetry();
    const node = await store.recordHeartbeat(
      nodeIdOf(1),
      heartbeatBody(1, { telemetry: sample }),
      null,
      at(0)
    );
    expect(node?.facts['telemetry']).toEqual(sample);
    await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, at(60));
    const points = await store.listHeartbeats(nodeIdOf(1), at(-1));
    expect(points[0]?.telemetry).toEqual(compactTelemetry(sample));
    expect(points[1]?.telemetry ?? null).toBeNull();
    expect(
      (await store.findNode(nodeIdOf(1)))?.facts['telemetry']
    ).toBeUndefined();
  });
});
