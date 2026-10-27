import { expect, test } from 'bun:test';
import { CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';
import { telemetry } from '../support/telemetry';
import { compactTelemetry } from '../../src/domain/heartbeat-history';
describeApi('telemetry ingestion and authorized visibility', (ctx) => {
  test('authenticated reports reach node details and history without becoming public', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const sample = telemetry();
    expect(
      (
        await h.asNode(
          1,
          'POST',
          '/v1/heartbeat',
          heartbeatBody(1, { telemetry: sample })
        )
      ).status
    ).toBe(200);
    expect((await h.call('GET', `/v1/nodes/${nodeIdOf(1)}`)).status).toBe(401);
    const detail = await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`);
    expect(detail.body.node.facts.telemetry).toEqual(sample);
    expect(detail.body.heartbeats[0].telemetry).toEqual(
      compactTelemetry(sample)
    );
    expect(
      (await h.admin('GET', '/metrics')).headers.get('cache-control')
    ).toBe('no-store');
  });
  test('invalid telemetry is refused atomically and cannot replace a valid report', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const sample = telemetry();
    await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, { telemetry: sample })
    );
    const invalid = {
      ...heartbeatBody(1),
      telemetry: { ...sample, cpuUsagePercent: 200 },
    };
    expect((await h.asNode(1, 'POST', '/v1/heartbeat', invalid)).status).toBe(
      400
    );
    expect(
      (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body.node.facts
        .telemetry
    ).toEqual(sample);
  });
});
