import { expect, test } from 'bun:test';

import { compactTelemetry } from '../../src/domain/heartbeat-history';
import { MemoryStore } from '../../src/testing/memory-store';
import { describeStore } from '../support/describe-store';
import {
  at,
  heartbeatBody,
  nodeIdOf,
  registerInput,
} from '../support/fixtures';
import { healthTelemetry } from '../support/telemetry';

describeStore('SqliteStore health history and derived health events', (ctx) => {
  async function approved() {
    const { store } = ctx();
    return store.registerNode(
      registerInput(1, {
        approval: 'approved',
        enrolledVia: 'enrollment-token',
      })
    );
  }

  test('facts keep every family; history keeps the compact summary and matches MemoryStore', async () => {
    const { store, db } = ctx();
    const registered = await approved();
    const memory = new MemoryStore();
    memory.seedNode(registered.node);
    const full = healthTelemetry();
    const body = heartbeatBody(1, { telemetry: full });
    await store.recordHeartbeat(nodeIdOf(1), body, null, at(0));
    await memory.recordHeartbeat(nodeIdOf(1), body, null, at(0));
    expect((await store.findNode(nodeIdOf(1)))?.facts['telemetry']).toEqual(
      full
    );
    const persisted =
      await db.sql`select telemetry from heartbeats where node_id = ${nodeIdOf(1)}`;
    const summary = JSON.parse(String(persisted[0]?.['telemetry']));
    expect(summary).toEqual(compactTelemetry(full));
    expect(summary).not.toHaveProperty('diskHealth');
    const stored = await store.listHeartbeats(nodeIdOf(1), at(-1));
    const kept = await memory.listHeartbeats(nodeIdOf(1), at(-1));
    expect(stored.map((point) => point.telemetry)).toEqual(
      kept.map((point) => point.telemetry)
    );
    expect(stored[0]?.telemetry?.gpus?.devices[0]?.utilizationPercent).toBe(0);
  });

  test('a degraded disk raises one event across repeated reports and one when it recovers', async () => {
    const { store } = ctx();
    await approved();
    const disk = (state: 'ok' | 'failing') =>
      healthTelemetry({
        diskHealth: {
          status: 'measured',
          reason: null,
          devices: [
            {
              name: 'sda',
              state,
              source: 'smartctl',
              temperatureCelsius: null,
              wearPercent: null,
              powerOnHours: null,
              detail: null,
            },
          ],
        },
      });
    const send = (state: 'ok' | 'failing', seconds: number) =>
      store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1, { telemetry: disk(state) }),
        null,
        at(seconds)
      );
    await send('ok', 0);
    await send('failing', 15);
    await send('failing', 30);
    await send('failing', 45);
    await send('ok', 60);
    await send('ok', 75);
    const kinds = (
      await store.listEvents({
        nodeId: nodeIdOf(1),
        limit: 50,
        kinds: ['disk_health_degraded', 'disk_health_ok'],
      })
    )
      .map((event) => [event.kind, event.severity])
      .reverse();
    expect(kinds).toEqual([
      ['disk_health_degraded', 'error'],
      ['disk_health_ok', 'info'],
    ]);
    const incidents = await store.listEvents({
      nodeId: nodeIdOf(1),
      limit: 50,
      kinds: ['disk_health_ok'],
    });
    expect(incidents).toHaveLength(1);
  });

  test('listEvents narrows by kind and keeps paging', async () => {
    const { store } = ctx();
    for (const kind of ['a', 'b', 'a', 'c', 'a'])
      await store.addEvent({
        nodeId: null,
        nodeLabel: null,
        kind,
        severity: 'info',
        message: kind,
      });
    const first = await store.listEvents({ kinds: ['a', 'c'], limit: 2 });
    expect(first.map((event) => event.kind)).toEqual(['a', 'c']);
    const rest = await store.listEvents({
      kinds: ['a', 'c'],
      limit: 5,
      beforeId: first[1]!.id,
    });
    expect(rest.map((event) => event.kind)).toEqual(['a', 'a']);
    expect(await store.listEvents({ kinds: [], limit: 5 })).toEqual([]);
  });
});
