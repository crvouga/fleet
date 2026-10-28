import { expect, test } from 'bun:test';
import { describeController } from '../support/describe-controller';
import { nodeIdOf } from '../support/fixtures';

describeController('direct Fleet enrollment status', (ctx) => {
  test('a node polls its own approval using its private credential without re-registering', async () => {
    const { h } = ctx();
    await h.register(1);
    const pending = await h.asNode(1, 'GET', '/v1/enrollment/status');
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({
      nodeId: nodeIdOf(1),
      role: 'ci',
      status: 'pending',
    });
    expect(
      (await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`)).status
    ).toBe(200);
    const approved = await h.asNode(1, 'GET', '/v1/enrollment/status');
    expect(approved.body.status).toBe('approved');
    expect((await h.asNode(2, 'GET', '/v1/enrollment/status')).status).toBe(
      401
    );
    expect((await h.call('GET', '/v1/enrollment/status')).status).toBe(401);
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/reject`);
    expect((await h.asNode(1, 'GET', '/v1/enrollment/status')).status).toBe(
      403
    );
  });
});
