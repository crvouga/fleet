import { describe, expect, test } from 'bun:test';

import { renderMetrics } from '../../src/routes/metrics';
import type { NodeView } from '../../src/types';
import { ADMIN_TOKEN, CI_ENROLLMENT_TOKEN } from '../support/controller';
import { describeController } from '../support/describe-controller';
import { heartbeatBody, nodeIdOf, T0 } from '../support/fixtures';

describeController('GET /v1/events', (ctx) => {
  const seed = async (count: number) => {
    for (let i = 1; i <= count; i += 1) {
      await ctx().store.addEvent({
        nodeId: null,
        nodeLabel: null,
        kind: `k${i}`,
        severity: i % 3 === 0 ? 'error' : i % 2 === 0 ? 'warn' : 'info',
        message: `event ${i}`,
      });
    }
  };

  test('newest first, with a cursor while there is more', async () => {
    const { h } = ctx();
    await seed(5);
    const first = await h.admin('GET', '/v1/events?limit=2');
    expect(
      first.body.events.map((e: { message: string }) => e.message)
    ).toEqual(['event 5', 'event 4']);
    expect(first.body.nextBefore).toBe(first.body.events[1].id);
    const second = await h.admin(
      'GET',
      `/v1/events?limit=2&before=${String(first.body.nextBefore)}`
    );
    expect(
      second.body.events.map((e: { message: string }) => e.message)
    ).toEqual(['event 3', 'event 2']);
    const last = await h.admin(
      'GET',
      `/v1/events?limit=2&before=${String(second.body.nextBefore)}`
    );
    expect(last.body.events.map((e: { message: string }) => e.message)).toEqual(
      ['event 1']
    );
    expect(last.body.nextBefore).toBeNull();
  });

  test('defaults to 50 and caps at 200', async () => {
    const { h } = ctx();
    await seed(60);
    expect((await h.admin('GET', '/v1/events')).body.events).toHaveLength(50);
    expect(
      (await h.admin('GET', '/v1/events?limit=200')).body.events
    ).toHaveLength(60);
    expect((await h.admin('GET', '/v1/events?limit=201')).status).toBe(400);
  });

  test('severity warn includes errors; error is only errors', async () => {
    const { h } = ctx();
    await seed(6);
    const warn = await h.admin('GET', '/v1/events?severity=warn');
    expect(
      warn.body.events.map((e: { severity: string }) => e.severity).sort()
    ).toEqual(['error', 'error', 'warn', 'warn']);
    const error = await h.admin('GET', '/v1/events?severity=error');
    expect(error.body.events).toHaveLength(2);
  });

  test('filters by node', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.register(2, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    const only = await h.admin('GET', `/v1/events?node=${nodeIdOf(2)}`);
    expect(only.body.events.length).toBeGreaterThan(0);
    expect(
      only.body.events.every(
        (e: { nodeId: string }) => e.nodeId === nodeIdOf(2)
      )
    ).toBe(true);
  });

  test('refuses bad parameters', async () => {
    const { h } = ctx();
    for (const query of [
      'limit=0',
      'limit=-1',
      'limit=abc',
      'limit=1.5',
      'before=0',
      'before=x',
      'before=1e3',
      'severity=info',
      'severity=fatal',
      'node=short',
      `node=${'g'.repeat(64)}`,
    ]) {
      const reply = await h.admin('GET', `/v1/events?${query}`);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe('invalid_request');
    }
  });

  test('empty parameters count as absent', async () => {
    const { h } = ctx();
    await seed(2);
    expect(
      (await h.admin('GET', '/v1/events?node=&severity=&before=&limit=')).body
        .events
    ).toHaveLength(2);
  });

  test('each event has the documented fields', async () => {
    const { h } = ctx();
    await ctx().store.addEvent({
      nodeId: null,
      nodeLabel: 'x',
      kind: 'k',
      severity: 'warn',
      message: 'm',
      data: { a: 1 },
    });
    const [event] = (await h.admin('GET', '/v1/events')).body.events;
    expect(Object.keys(event).sort()).toEqual([
      'at',
      'data',
      'id',
      'kind',
      'message',
      'nodeId',
      'nodeLabel',
      'severity',
    ]);
    expect(event.data).toEqual({ a: 1 });
  });
});

describeController('settings endpoints', (ctx) => {
  const put = (scope: string, json: unknown) =>
    ctx().h.admin('PUT', `/v1/settings/${scope}`, json);

  test('list is empty until something is written', async () => {
    expect((await ctx().h.admin('GET', '/v1/settings')).body).toEqual({
      settings: [],
    });
  });

  test('PUT replaces a scope and GET reads it back', async () => {
    const { h } = ctx();
    const saved = await put('fleet', {
      sync: { paused: true },
      disk: { alertPercent: 85 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      scope: 'fleet',
      value: { sync: { paused: true }, disk: { alertPercent: 85 } },
      updatedBy: 'admin-token',
    });
    const replaced = await put('fleet', { disk: { alertPercent: 90 } });
    expect(replaced.body.value).toEqual({ disk: { alertPercent: 90 } });
    expect((await h.admin('GET', '/v1/settings/fleet')).body).toMatchObject({
      scope: 'fleet',
      value: { disk: { alertPercent: 90 } },
    });
    expect((await h.admin('GET', '/v1/settings')).body.settings).toHaveLength(
      1
    );
  });

  test('an unwritten but valid scope reads as an empty document', async () => {
    const { h } = ctx();
    for (const scope of ['fleet', 'role:cache']) {
      expect((await h.admin('GET', `/v1/settings/${scope}`)).body).toEqual({
        scope,
        value: {},
        updatedAt: null,
        updatedBy: null,
      });
    }
  });

  test('an invalid scope is a 400', async () => {
    const { h } = ctx();
    for (const scope of [
      'nope',
      'role:gpu',
      'node:short',
      'role:',
      'fleet2',
      `node:${'G'.repeat(64)}`,
    ]) {
      const reply = await h.admin('GET', `/v1/settings/${scope}`);
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe('invalid_scope');
      expect((await put(scope, {})).status).toBe(400);
      expect(
        (await h.admin('GET', `/v1/settings/${scope}/history`)).status
      ).toBe(400);
    }
  });

  test('the colon in a scope may be percent-encoded', async () => {
    const { h } = ctx();
    await put('role:ci', { sync: { paused: true } });
    expect((await h.admin('GET', '/v1/settings/role%3Aci')).body.value).toEqual(
      { sync: { paused: true } }
    );
  });

  test('unknown keys and wrong values are refused, with every reason, and nothing is stored', async () => {
    const { h } = ctx();
    const reply = await put('fleet', {
      sync: { pauzed: true },
      heartbeat: { intervalSeconds: 5 },
      reboot: { enabled: 'yes' },
      commands: {},
      alerts: { webhookUrl: 'http://insecure.example' },
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe('invalid_settings');
    expect(reply.body.errors).toEqual(
      expect.arrayContaining([
        'sync.pauzed is not a setting',
        'heartbeat.intervalSeconds must be between 15 and 3600',
        'reboot.enabled must be true or false',
        'commands is not a settings section',
        'alerts.webhookUrl must be https',
      ])
    );
    expect((await h.admin('GET', '/v1/settings')).body.settings).toEqual([]);
    expect(
      (await h.admin('GET', '/v1/settings/fleet/history')).body.history
    ).toEqual([]);
  });

  test('a body that is not an object is refused', async () => {
    for (const json of [[], 'x', 5, null])
      expect((await put('fleet', json)).status).toBe(400);
    const bad = await ctx().h.call('PUT', '/v1/settings/fleet', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: '{',
    });
    expect(bad.status).toBe(400);
  });

  test('a node scope needs a node that exists, and shows what applies to it', async () => {
    const { h } = ctx();
    expect(
      (await put(`node:${nodeIdOf(1)}`, { sync: { paused: true } })).status
    ).toBe(404);
    expect(
      (await h.admin('GET', `/v1/settings/node:${nodeIdOf(1)}`)).status
    ).toBe(404);
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await put('fleet', {
      disk: { alertPercent: 80 },
      alerts: { offlineAfterSeconds: 120 },
    });
    await put('role:ci', { disk: { alertPercent: 70 } });
    await put(`node:${nodeIdOf(1)}`, { sync: { paused: true } });
    const reply = await h.admin('GET', `/v1/settings/node:${nodeIdOf(1)}`);
    expect(reply.body.value).toEqual({ sync: { paused: true } });
    expect(reply.body.effective).toEqual({
      disk: { alertPercent: 70 },
      alerts: { offlineAfterSeconds: 120 },
      sync: { paused: true },
    });
    expect(
      'effective' in (await h.admin('GET', '/v1/settings/fleet')).body
    ).toBe(false);
  });

  test('history lists who changed what, newest first', async () => {
    const { h } = ctx();
    await put('fleet', { disk: { alertPercent: 80 } });
    await put('fleet', { disk: { alertPercent: 81 } });
    await put('role:ci', { disk: { alertPercent: 70 } });
    const history = (await h.admin('GET', '/v1/settings/fleet/history')).body
      .history;
    expect(
      history.map(
        (entry: { value: { disk: { alertPercent: number } } }) =>
          entry.value.disk.alertPercent
      )
    ).toEqual([81, 80]);
    expect(history[0]).toMatchObject({
      scope: 'fleet',
      changedBy: 'admin-token',
    });
    expect(
      (await h.admin('GET', '/v1/settings/fleet/history?limit=1')).body.history
    ).toHaveLength(1);
    for (const limit of ['0', '201', 'x']) {
      expect(
        (await h.admin('GET', `/v1/settings/fleet/history?limit=${limit}`))
          .status
      ).toBe(400);
    }
  });

  test('every accepted setting round-trips with its type', async () => {
    const { h } = ctx();
    const everything = {
      heartbeat: { intervalSeconds: 30 },
      sync: { paused: true },
      reboot: { enabled: true, delayMaxSeconds: 600 },
      disk: { alertPercent: 85 },
      capacity: {
        reserveGiB: 8,
        perRunnerGiB: 16,
        perRunnerCores: 2,
        slotMax: 6,
        highMemGiB: 64,
      },
      runners: {
        enabled: true,
        cordoned: false,
        repositories: ['crvouga/fleet'],
        extraLabels: ['gpu-2080'],
      },
      alerts: {
        offlineAfterSeconds: 240,
        webhookUrl: 'https://hooks.example/x',
      },
    };
    expect((await put('fleet', everything)).body.value).toEqual(everything);
    expect((await h.admin('GET', '/v1/settings/fleet')).body.value).toEqual(
      everything
    );
  });
});

describeController('GET /v1/summary', (ctx) => {
  test('counts nodes by status and role, revisions and capacity', async () => {
    const { h } = ctx();
    h.clock.set(T0);
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.register(2, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.register(3);
    await h.register(4, {
      role: 'devbox',
      hostname: 'devbox-1234',
      enrollmentToken: 'wrong-token-value',
    });
    await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, {
        runners: { slots: 4, busy: 1 },
        failedUnits: ['a.service'],
      })
    );
    await h.asNode(
      2,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(2, {
        runners: { slots: 2, busy: 2 },
        sync: { rolledBack: true },
      })
    );
    h.clock.advance(10);
    const summary = (await h.admin('GET', '/v1/summary')).body;
    expect(summary.total).toBe(4);
    expect(summary.byStatus).toMatchObject({
      online: 2,
      pending: 2,
      offline: 0,
    });
    expect(summary.byRole.ci).toEqual({ total: 2, online: 2 });
    expect(summary.byRole.devbox).toEqual({ total: 0, online: 0 });
    expect(summary.unassigned).toEqual({ total: 0, online: 0 });
    await h.admin('POST', `/v1/nodes/${nodeIdOf(3)}/approve`);
    expect((await h.admin('GET', '/v1/summary')).body.unassigned).toEqual({
      total: 1,
      online: 0,
    });
    expect(summary.runnerSlots).toEqual({ total: 6, busy: 3 });
    expect(summary.withFailedUnits).toBe(1);
    expect(summary.rolledBack).toBe(1);
    expect(summary.revisions[0]).toEqual({
      revision: '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283',
      count: 2,
    });
  });
});

describeController('GET /metrics', (ctx) => {
  test('is Prometheus text and needs admin credentials', async () => {
    const { h } = ctx();
    expect((await h.call('GET', '/metrics')).status).toBe(401);
    const reply = await h.admin('GET', '/metrics');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8'
    );
    expect(reply.text.endsWith('\n')).toBe(true);
  });

  test('reports every series the protocol names', async () => {
    const { h } = ctx();
    h.clock.set(T0);
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.register(2);
    await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, { runners: { slots: 4, busy: 1 } })
    );
    h.clock.advance(20);
    const lines = (await h.admin('GET', '/metrics')).text.split('\n');
    const host = `ci-${nodeIdOf(1).slice(0, 4)}`;
    expect(lines).toContain('fleet_nodes{status="online",role="ci"} 1');
    expect(lines).toContain('fleet_nodes{status="pending",role="ci"} 0');
    expect(lines).toContain(
      'fleet_nodes{status="pending",role="unassigned"} 1'
    );
    expect(lines).toContain('fleet_nodes{status="offline",role="web"} 0');
    expect(lines).toContain(`fleet_node_up{node="${host}",role="ci"} 1`);
    // Never reported a reconcile phase, so not converged.
    expect(lines).toContain(`fleet_node_converged{node="${host}",role="ci"} 0`);
    expect(lines).toContain(`fleet_node_last_seen_seconds{node="${host}"} 20`);
    expect(lines).toContain('fleet_runner_slots{state="total"} 4');
    expect(lines).toContain('fleet_runner_slots{state="busy"} 1');
    expect(lines.filter((l) => l.startsWith('fleet_node_up{'))).toHaveLength(1);
  });

  test('a node that falls silent goes down', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));
    h.clock.advance(1000);
    const lines = (await h.admin('GET', '/metrics')).text.split('\n');
    expect(lines).toContain(
      `fleet_node_up{node="ci-${nodeIdOf(1).slice(0, 4)}",role="ci"} 0`
    );
    expect(lines).toContain('fleet_nodes{status="offline",role="ci"} 1');
  });

  test('every line is a comment or a valid sample', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));
    const lines = (await h.admin('GET', '/metrics')).text.trimEnd().split('\n');
    for (const line of lines) {
      expect(line).toMatch(
        /^(# (HELP|TYPE) fleet_\w+ .+|fleet_\w+(\{[a-z_]+="[^"\n]*"(,[a-z_]+="[^"\n]*")*\})? -?\d+(\.\d+)?)$/
      );
    }
    const types = lines.filter((l) => l.startsWith('# TYPE'));
    expect(types.map((l) => l.split(' ')[2])).toEqual([
      'fleet_nodes',
      'fleet_node_up',
      'fleet_node_converged',
      'fleet_node_last_seen_seconds',
      'fleet_runner_slots',
      'fleet_node_telemetry_fresh',
      'fleet_node_ready',
      'fleet_node_memory_bytes',
      'fleet_node_runner_slots',
      'fleet_node_cpu_usage_percent',
      'fleet_node_filesystem_bytes',
      'fleet_node_temperature_celsius',
      'fleet_node_power_watts',
      'fleet_node_network_bytes_per_second',
      'fleet_node_network_received_bytes',
      'fleet_node_network_transmitted_bytes',
      'fleet_node_swap_bytes',
    ]);
  });

  test('retired and rejected nodes have no per-node series', async () => {
    const { h } = ctx();
    await h.register(1, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.register(2, { enrollmentToken: CI_ENROLLMENT_TOKEN });
    await h.asNode(1, 'POST', '/v1/heartbeat', heartbeatBody(1));
    await h.asNode(2, 'POST', '/v1/heartbeat', heartbeatBody(2));
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/retire`);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(2)}/reject`);
    const text = (await h.admin('GET', '/metrics')).text;
    expect(text).not.toContain('fleet_node_up{');
    expect(text).not.toContain('fleet_node_last_seen_seconds{');
  });
});

describe('renderMetrics', () => {
  test('escapes label values', () => {
    const view = {
      id: nodeIdOf(1),
      hostname: 'a"b\\c\nd',
      role: 'ci',
      approval: 'approved',
      status: 'online',
      ageSeconds: 3,
      facts: {},
    } as unknown as NodeView;
    const text = renderMetrics([view]);
    expect(text).toContain('fleet_node_up{node="a\\"b\\\\c\\nd",role="ci"} 1');
  });

  test('an empty fleet still reports zeroes', () => {
    const text = renderMetrics([]);
    expect(text).toContain('fleet_nodes{status="online",role="ci"} 0');
    expect(text).toContain('fleet_runner_slots{state="total"} 0');
    expect(text).not.toContain('fleet_node_up{');
  });
});

describeController(
  'everything under /v1 answers JSON, including for the unknown',
  (ctx) => {
    test('unknown paths and methods are 404 JSON', async () => {
      const { h } = ctx();
      for (const [method, path] of [
        ['GET', '/v1/nope'],
        ['DELETE', '/v1/heartbeat'],
        ['GET', '/v1/heartbeat'],
        ['POST', '/v1/summary'],
        ['PATCH', '/v1/settings/fleet'],
      ] as const) {
        const reply = await h.admin(method, path);
        expect(reply.status).toBe(404);
        expect(reply.body).toEqual({
          error: 'not_found',
          message: 'No such endpoint.',
        });
      }
    });

    test('responses under /v1 are never cached', async () => {
      const { h } = ctx();
      for (const reply of [
        await h.admin('GET', '/v1/nodes'),
        await h.call('GET', '/v1/nope'),
        await h.register(1),
      ]) {
        expect(reply.headers.get('cache-control')).toBe('no-store');
      }
    });
  }
);
