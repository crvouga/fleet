import { expect, test } from 'bun:test';

import { compactTelemetry } from '../../src/domain/heartbeat-history';
import { at, heartbeatBody, nodeIdOf, T0 } from '../support/fixtures';
import { maximumTelemetry, telemetry } from '../support/telemetry';

import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode } from './support/sim-node';

const ID = nodeIdOf(1);
const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

const detail = async (p: ControllerProcess) =>
  (await p.h.admin('GET', `/v1/nodes/${ID}`)).body;

/** The value of a metric line for node 1, or undefined when the series is absent. */
async function metric(
  p: ControllerProcess,
  name: string,
  contains = ''
): Promise<string | undefined> {
  const text = (await p.h.admin('GET', '/metrics')).text;
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`) && line.includes(contains))
    .at(0)
    ?.split(' ')
    .at(-1);
}

describeRig(
  'Observability: observability data collection (PROTOCOL.md, Extended telemetry)',
  (rig) => {
    async function enrolled() {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      return { p, node: simNode(1) };
    }

    test('an older agent without telemetry is accepted; absence is unknown, never zero', async () => {
      const { p, node } = await enrolled();
      const reply = await node.beat(p.h, { readiness: { issues: [] } });
      expect(reply.status).toBe(200);
      const { node: view, heartbeats } = await detail(p);
      expect(view.facts.telemetry).toBeUndefined();
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0].telemetry ?? null).toBeNull();
      // The node is online, so its capacity shows, but no resource series is invented.
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('0');
      for (const name of [
        'fleet_node_cpu_usage_percent',
        'fleet_node_temperature_celsius',
        'fleet_node_power_watts',
        'fleet_node_filesystem_bytes',
        'fleet_node_network_bytes_per_second',
        'fleet_node_swap_bytes',
      ]) {
        expect([name, await metric(p, name)]).toEqual([name, undefined]);
      }
      expect(
        await metric(p, 'fleet_node_memory_bytes', 'state="total"')
      ).toBeDefined();
    });

    test('telemetry is stored whole in the latest facts and as a compact summary in history', async () => {
      const { p, node } = await enrolled();
      const sample = telemetry({
        sampledAt: iso(rig().clock.now()),
        cpuUsagePercent: 37.5,
        temperatures: [
          { name: 'cpu-package', celsius: 61 },
          { name: 'nvme', celsius: 44 },
        ],
        power: [
          { name: 'package-0', watts: 35, source: 'powercap' },
          { name: 'core', watts: 12, source: 'powercap' },
        ],
      });
      await node.beat(p.h, { telemetry: sample });
      const { node: view, heartbeats } = await detail(p);
      expect(view.facts.telemetry).toEqual(sample);
      const point = heartbeats[0].telemetry;
      expect(point).toEqual(compactTelemetry(sample));
      expect(point.temperatures).toEqual([
        { name: 'cpu-package', celsius: 61 },
      ]);
      expect(point.power).toEqual([
        { name: 'package-0', watts: 35, source: 'powercap' },
      ]);
      for (const dropped of [
        'filesystems',
        'network',
        'runnerSlots',
        'logs',
        'issues',
      ] as const) {
        expect([dropped, point[dropped]]).toEqual([dropped, []]);
      }
      expect(point.swap).toBeNull();
      expect(point.cpuUsagePercent).toBe(37.5);
    });

    test('an upgrade, then a downgrade: facts follow the latest report and the old sample does not linger', async () => {
      const { p, node } = await enrolled();
      await node.beat(p.h, {
        telemetry: telemetry({ sampledAt: iso(rig().clock.now()) }),
      });
      expect((await detail(p)).node.facts.telemetry).toBeDefined();
      rig().clock.advance(60);
      await node.beat(p.h);
      const view = (await detail(p)).node;
      expect(view.facts.telemetry).toBeUndefined();
      expect(await metric(p, 'fleet_node_cpu_usage_percent')).toBeUndefined();
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('0');
    });

    test('zero is preserved, unknown measurements are omitted, unknown keys are discarded', async () => {
      const { p, node } = await enrolled();
      const sample = telemetry({
        sampledAt: iso(rig().clock.now()),
        cpuUsagePercent: null,
      });
      const withExtras = {
        ...sample,
        undocumented: { secret: 'x' },
      } as unknown as typeof sample;
      expect((await node.beat(p.h, { telemetry: withExtras })).status).toBe(
        200
      );
      const stored = (await detail(p)).node.facts.telemetry;
      expect(stored.undocumented).toBeUndefined();
      expect(await metric(p, 'fleet_node_cpu_usage_percent')).toBeUndefined(); // null, not 0
      expect(await metric(p, 'fleet_node_power_watts')).toBe('0'); // a real zero
      expect(
        await metric(
          p,
          'fleet_node_network_bytes_per_second',
          'direction="receive"'
        )
      ).toBeUndefined();
      expect(
        await metric(
          p,
          'fleet_node_network_bytes_per_second',
          'direction="transmit"'
        )
      ).toBe('0');
    });

    test('freshness: a current sample is exported, a stale one is labelled stale and its series vanish', async () => {
      const { p, node } = await enrolled();
      const { clock } = rig();
      await node.beat(p.h, {
        telemetry: telemetry({ sampledAt: iso(clock.now()) }),
      });
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('1');
      expect(await metric(p, 'fleet_node_cpu_usage_percent')).toBe('0');
      clock.advance(150);
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('1'); // boundary: still online and fresh
      clock.advance(1);
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('0');
      expect(await metric(p, 'fleet_node_cpu_usage_percent')).toBeUndefined();
      // Stale: no resource series at all, and not even capacity for a node that is no longer online.
      expect(await metric(p, 'fleet_node_memory_bytes')).toBeUndefined();
      expect(await metric(p, 'fleet_node_ready')).toBe('0');
    });

    test('an online node whose sample is old (a skewed node clock) is labelled stale while capacity still shows', async () => {
      const { p, node } = await enrolled();
      const { clock } = rig();
      await node.beat(p.h, {
        telemetry: telemetry({ sampledAt: iso(at(-600, clock.now())) }),
      });
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('0');
      expect(await metric(p, 'fleet_node_cpu_usage_percent')).toBeUndefined();
      expect(
        await metric(p, 'fleet_node_memory_bytes', 'state="total"')
      ).toBeDefined();
      // A sample from the future is not trusted either.
      await node.beat(p.h, {
        telemetry: telemetry({ sampledAt: iso(at(+600, clock.now())) }),
      });
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('0');
    });

    test('resource series follow the node interval: a slow reporter stays fresh for 2.5 intervals', async () => {
      const { p, node } = await enrolled();
      const { clock } = rig();
      await p.h.admin('PUT', `/v1/settings/node:${ID}`, {
        heartbeat: { intervalSeconds: 120 },
      });
      await node.beat(p.h, {
        telemetry: telemetry({ sampledAt: iso(clock.now()) }),
      });
      clock.advance(250);
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('1');
      clock.advance(60);
      expect(await metric(p, 'fleet_node_telemetry_fresh')).toBe('0');
    });

    test('the largest legal report is accepted and invalid ones are refused whole, keeping the last good state', async () => {
      const { p, node } = await enrolled();
      const { clock } = rig();
      const full = { ...maximumTelemetry(), sampledAt: iso(clock.now()) };
      expect((await node.beat(p.h, { telemetry: full })).status).toBe(200);
      const stored = await p.store.findNode(ID);
      const heartbeats = await p.store.listHeartbeats(ID, at(-1, T0));
      clock.advance(60);
      const tooMany = {
        ...full,
        filesystems: [...full.filesystems, full.filesystems[0]!],
      };
      const badRange = { ...full, cpuUsagePercent: 101 };
      for (const bad of [tooMany, badRange]) {
        const reply = await p.h.asNode(1, 'POST', '/v1/heartbeat', {
          ...heartbeatBody(1),
          telemetry: bad,
        });
        expect(reply.status).toBe(400);
      }
      const after = await p.store.findNode(ID);
      expect(after?.lastSeenAt).toEqual(stored?.lastSeenAt as Date);
      expect(after?.facts).toEqual(stored?.facts as Record<string, unknown>);
      expect(await p.store.listHeartbeats(ID, at(-1, T0))).toHaveLength(
        heartbeats.length
      );
    });

    test('history is bounded to 1,440 points, keeps the newest report, and leaves sparse histories alone', async () => {
      const { p } = await enrolled();
      const { clock } = rig();
      const sample = telemetry({ sampledAt: iso(clock.now()) });
      const insert = `insert into heartbeats (node_id, at, uptime_seconds, load1, telemetry) values (?, ?, ?, ?, ?)`;
      const hours = 23;
      const count = 3000;
      await rig().db.sql.begin(async (tx) => {
        for (let i = 0; i < count; i += 1) {
          const when = at(
            -hours * 3600 + Math.floor((i * hours * 3600) / count),
            clock.now()
          );
          await tx.unsafe(insert, [
            ID,
            when.toISOString(),
            i,
            0.5,
            JSON.stringify(compactTelemetry(sample)),
          ]);
        }
      });
      const dense = (await detail(p)).heartbeats as { at: string }[];
      expect(dense.length).toBeLessThanOrEqual(1440);
      expect(dense.length).toBeGreaterThan(1000);
      const times = dense.map((point) => Date.parse(point.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times); // ascending, no duplicates
      expect(new Set(times).size).toBe(times.length);
      const newest = at(
        -hours * 3600 + Math.floor(((count - 1) * hours * 3600) / count),
        clock.now()
      );
      expect(times.at(-1)).toBe(newest.getTime()); // the newest actual sample survives bucketing

      // A sparse history is returned exactly as stored.
      await rig().db.sql.unsafe(
        `delete from heartbeats where node_id = '${ID}'`
      );
      for (let i = 0; i < 50; i += 1)
        await p.store.recordHeartbeat(
          ID,
          heartbeatBody(1),
          null,
          at(-3000 + i * 60, clock.now())
        );
      expect(((await detail(p)).heartbeats as unknown[]).length).toBe(50);
    });

    test('history keeps only the compact summary of each sample, however large the report was', async () => {
      const { p, node } = await enrolled();
      const { clock } = rig();
      await node.beat(p.h, {
        telemetry: { ...maximumTelemetry(), sampledAt: iso(clock.now()) },
      });
      const row = (
        await rig().db.sql.unsafe(
          `select telemetry from heartbeats where node_id = '${ID}'`
        )
      )[0] as { telemetry: string };
      const stored = JSON.parse(row.telemetry) as ReturnType<typeof telemetry>;
      expect(stored.temperatures).toHaveLength(1);
      expect(stored.power).toHaveLength(1);
      expect(stored.runnerSlots).toEqual([]);
      expect(stored.logs).toEqual([]);
      expect(row.telemetry.length).toBeLessThan(4096);
    });
  }
);
