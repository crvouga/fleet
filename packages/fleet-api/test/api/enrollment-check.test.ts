import { expect, test } from 'bun:test';
import { CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';

describeApi('read-only enrollment readiness', (ctx) => {
  test('proves the role credential without creating a node or leaking it', async () => {
    const { h, store } = ctx();
    const reply = await h.call('POST', '/v1/enrollment/check', {
      json: { role: 'ci', roleToken: CI_ROLE_TOKEN },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, role: 'ci' });
    expect(reply.text).not.toContain(CI_ROLE_TOKEN);
    expect(await store.listNodes()).toEqual([]);
  });
  test('rejects missing, wrong, and cross-role credentials without mutation', async () => {
    const { h, store } = ctx();
    for (const body of [
      { role: 'ci', roleToken: 'wrong' },
      { role: 'devbox', roleToken: CI_ROLE_TOKEN },
    ]) {
      const reply = await h.call('POST', '/v1/enrollment/check', {
        json: body,
      });
      expect(reply.status).toBe(401);
      expect(reply.text).not.toContain(CI_ROLE_TOKEN);
    }
    expect(await store.listNodes()).toEqual([]);
  });
  test('a retired role cannot pass the enrollment check', async () => {
    const { h, store } = ctx();
    const reply = await h.call('POST', '/v1/enrollment/check', {
      json: { role: 'web', roleToken: CI_ROLE_TOKEN },
    });
    expect(reply.status).toBe(400);
    expect(await store.listNodes()).toEqual([]);
  });
});
