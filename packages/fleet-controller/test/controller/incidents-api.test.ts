import { expect, test } from 'bun:test';

import { CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';
import { signInAs } from '../support/session';
import { healthTelemetry } from '../support/telemetry';

const hotGpu = (celsius: number) =>
  healthTelemetry({
    gpus: {
      status: 'measured',
      reason: null,
      devices: [
        {
          name: 'nvidia0/RTX',
          vendor: 'nvidia',
          utilizationPercent: 50,
          memoryUsedBytes: null,
          memoryTotalBytes: null,
          temperatureCelsius: celsius,
          powerWatts: null,
        },
      ],
    },
  });

describeController('incidents and restart history over HTTP', (ctx) => {
  async function beat(
    n: number,
    overrides: Parameters<typeof heartbeatBody>[1] = {}
  ) {
    const { h } = ctx();
    h.clock.advance(15_000);
    const reply = await h.asNode(
      n,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(n, overrides)
    );
    expect(reply.status).toBe(200);
  }

  test('a hot GPU is announced once, becomes an open incident, then resolves', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat(1, { telemetry: hotGpu(60) });
    await beat(1, { telemetry: hotGpu(90) });
    await beat(1, { telemetry: hotGpu(92) });
    const open = await h.admin('GET', '/v1/incidents?open=true');
    expect(open.status).toBe(200);
    expect(open.body.incidents).toHaveLength(1);
    expect(open.body.incidents[0]).toMatchObject({
      rule: 'gpu_hot',
      open: true,
      nodeId: nodeIdOf(1),
      severity: 'warn',
    });
    expect(open.body.incidents[0].reportHref).toMatch(
      /^\/report-issue\?kind=node&event=\d+$/
    );
    const kinds = (await h.admin('GET', '/v1/events?limit=50')).body.events.map(
      (e: { kind: string }) => e.kind
    );
    expect(kinds.filter((kind: string) => kind === 'gpu_hot')).toHaveLength(1);
    await beat(1, { telemetry: hotGpu(50) });
    const all = await h.admin('GET', `/v1/incidents?node=${nodeIdOf(1)}`);
    expect(all.body.incidents).toHaveLength(1);
    expect(all.body.incidents[0]).toMatchObject({ open: false });
    expect(all.body.incidents[0].durationSeconds).toBeGreaterThan(0);
    expect(all.body.summary).toMatchObject({ open: 0, total: 1 });
    expect(
      (await h.admin('GET', '/v1/incidents?open=true')).body.incidents
    ).toEqual([]);
  });

  test('filters, paging and bad parameters', async () => {
    const { h, store } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    for (let i = 0; i < 3; i += 1) {
      await store.addEvent({
        nodeId: nodeIdOf(1),
        nodeLabel: 'n',
        kind: 'offline',
        severity: 'error',
        message: 'down',
      });
      await store.addEvent({
        nodeId: nodeIdOf(1),
        nodeLabel: 'n',
        kind: 'recovered',
        severity: 'info',
        message: 'up',
      });
    }
    const first = await h.admin('GET', '/v1/incidents?limit=2');
    expect(first.body.incidents).toHaveLength(2);
    expect(first.body.nextBefore).toBe(first.body.incidents[1].openEventId);
    const second = await h.admin(
      'GET',
      `/v1/incidents?limit=2&before=${String(first.body.nextBefore)}`
    );
    expect(second.body.incidents).toHaveLength(1);
    expect(second.body.nextBefore).toBeNull();
    for (const query of [
      'open=maybe',
      'node=abc',
      'before=0',
      'before=x',
      'limit=0',
      'limit=201',
    ]) {
      const reply = await h.admin('GET', `/v1/incidents?${query}`);
      expect([query, reply.status]).toEqual([query, 400]);
      expect(reply.body.error).toBe('invalid_request');
    }
    expect((await h.call('GET', '/v1/incidents')).status).toBe(401);
  });

  test('viewers can read incidents, restarts and history', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat(1);
    const viewer = await signInAs(ctx(), 'viewer@example.test', 'viewer');
    for (const path of [
      '/v1/incidents',
      `/v1/nodes/${nodeIdOf(1)}/restarts`,
      `/v1/nodes/${nodeIdOf(1)}/history?hours=24`,
    ]) {
      const reply = await viewer.h.call('GET', path, {
        headers: viewer.headers,
      });
      expect([path, reply.status]).toEqual([path, 200]);
    }
  });

  test('restart history lists boots, clean and unclean shutdowns and the current uptime', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat(1, {
      bootId: 'boot-1',
      uptimeSeconds: 100,
      events: [
        {
          kind: 'boot',
          severity: 'info',
          message: 'node started',
          key: 'boot:boot-1',
        },
      ],
    });
    await beat(1, {
      bootId: 'boot-2',
      uptimeSeconds: 50,
      events: [
        {
          kind: 'boot',
          severity: 'info',
          message: 'node started',
          key: 'boot:boot-2',
        },
        {
          kind: 'unclean-shutdown',
          severity: 'warn',
          message: 'ended badly',
          key: 'unclean:boot-1',
          data: { bootId: 'boot-1' },
        },
      ],
    });
    await beat(1, {
      bootId: 'boot-3',
      uptimeSeconds: 20,
      events: [
        {
          kind: 'boot',
          severity: 'info',
          message: 'node started',
          key: 'boot:boot-3',
        },
      ],
    });
    const reply = await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}/restarts`);
    expect(reply.status).toBe(200);
    expect(
      reply.body.boots.map(
        (boot: { bootId: string; previousShutdown: string }) => [
          boot.bootId,
          boot.previousShutdown,
        ]
      )
    ).toEqual([
      ['boot-3', 'clean'],
      ['boot-2', 'unclean'],
      ['boot-1', 'unknown'],
    ]);
    expect(reply.body).toMatchObject({
      restarts: 2,
      uncleanShutdowns: 1,
      restartsLast24h: 2,
    });
    expect(reply.body.current).toMatchObject({
      bootId: 'boot-3',
      uptimeSeconds: 20,
    });
    expect(
      (await h.admin('GET', `/v1/nodes/${'0'.repeat(64)}/restarts`)).status
    ).toBe(404);
    expect((await h.admin('GET', '/v1/nodes/nope/restarts')).status).toBe(404);
  });

  test('history serves a bounded window of 1 hour to 365 days', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await beat(1);
    const reply = await h.admin(
      'GET',
      `/v1/nodes/${nodeIdOf(1)}/history?hours=720`
    );
    expect(reply.status).toBe(200);
    expect(reply.body.windowHours).toBe(720);
    expect(reply.body.heartbeats.length).toBeGreaterThanOrEqual(1);
    for (const hours of ['0', '8761', 'x', '-1'])
      expect(
        (
          await h.admin(
            'GET',
            `/v1/nodes/${nodeIdOf(1)}/history?hours=${hours}`
          )
        ).status
      ).toBe(400);
  });
});
