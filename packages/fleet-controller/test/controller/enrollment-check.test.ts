import { expect, test } from 'bun:test';
import {
  CI_ENROLLMENT_TOKEN,
  PLAIN_ENROLLMENT_TOKEN,
} from '../support/controller';
import { describeController } from '../support/describe-controller';

describeController('read-only enrollment readiness', (ctx) => {
  test('proves the enrollment token without creating a node or leaking it', async () => {
    const { h, store } = ctx();
    const reply = await h.call('POST', '/v1/enrollment/check', {
      json: { enrollmentToken: CI_ENROLLMENT_TOKEN },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, role: 'ci' });
    expect(reply.text).not.toContain(CI_ENROLLMENT_TOKEN);
    expect(await store.listNodes()).toEqual([]);
  });

  test('a token without a role answers role null', async () => {
    const reply = await ctx().h.call('POST', '/v1/enrollment/check', {
      json: { enrollmentToken: PLAIN_ENROLLMENT_TOKEN },
    });
    expect(reply.body).toEqual({ ok: true, role: null });
  });

  test('a claimed role is ignored, never compared', async () => {
    const reply = await ctx().h.call('POST', '/v1/enrollment/check', {
      json: { role: 'devbox', enrollmentToken: CI_ENROLLMENT_TOKEN },
    });
    expect(reply.body).toEqual({ ok: true, role: 'ci' });
  });

  test('rejects a wrong token with 401 and a malformed one with 400, without mutation', async () => {
    const { h, store } = ctx();
    const wrong = await h.call('POST', '/v1/enrollment/check', {
      json: { enrollmentToken: 'wrong-token-value' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('enrollment_not_ready');
    for (const body of [
      {},
      { roleToken: CI_ENROLLMENT_TOKEN },
      { enrollmentToken: 'short' },
      { enrollmentToken: 'has spaces in it' },
      { enrollmentToken: 'x'.repeat(513) },
    ]) {
      const reply = await h.call('POST', '/v1/enrollment/check', {
        json: body,
      });
      expect(reply.status).toBe(400);
      expect(reply.text).not.toContain(CI_ENROLLMENT_TOKEN);
    }
    expect(await store.listNodes()).toEqual([]);
  });
});
