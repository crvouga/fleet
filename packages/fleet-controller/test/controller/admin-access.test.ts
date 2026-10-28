import { expect, test } from 'bun:test';

import { SqliteAccessStore } from '../../src/db/access-store';
import { describeController } from '../support/describe-controller';

describeController('/v1/access', (ctx) => {
  const harness = () =>
    ctx().harness({ access: new SqliteAccessStore(ctx().db.sql) });

  test('the admin token authorizes the first owner without browser login configured', async () => {
    const h = harness();
    expect((await h.admin('GET', '/v1/access')).body).toEqual({ emails: [] });
    const put = await h.admin('PUT', '/v1/access/%20Owner@Example.ORG%20');
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ email: 'owner@example.org', allowed: true });
    expect((await h.admin('PUT', '/v1/access/owner@example.org')).status).toBe(
      200
    );
    expect((await h.admin('GET', '/v1/access')).body).toEqual({
      emails: ['owner@example.org'],
    });
    const audit = await ctx().db
      .sql`select email, actor, action from access_audit`;
    expect([...audit]).toEqual([
      { email: 'owner@example.org', actor: 'admin-token', action: 'allow' },
    ]);
  });

  test('refuses callers without the admin token, before touching the list', async () => {
    const h = harness();
    expect((await h.call('PUT', '/v1/access/owner@example.org')).status).toBe(
      401
    );
    expect(
      (
        await h.call('PUT', '/v1/access/owner@example.org', {
          headers: { Authorization: 'Bearer wrong-token' },
        })
      ).status
    ).toBe(401);
    expect((await h.call('GET', '/v1/access')).status).toBe(401);
    expect((await h.admin('GET', '/v1/access')).body).toEqual({ emails: [] });
  });

  test('rejects malformed addresses', async () => {
    const h = harness();
    for (const path of ['/v1/access/not-an-email', '/v1/access/a%40b%40c'])
      expect((await h.admin('PUT', path)).status).toBe(400);
  });

  test('keeps the final allowed account', async () => {
    const h = harness();
    await h.admin('PUT', '/v1/access/one@example.org');
    await h.admin('PUT', '/v1/access/two@example.org');
    expect(
      (await h.admin('DELETE', '/v1/access/one@example.org')).body
    ).toEqual({ email: 'one@example.org', allowed: false });
    const last = await h.admin('DELETE', '/v1/access/two@example.org');
    expect(last.status).toBe(409);
    expect(last.body.error).toBe('cannot_revoke');
  });

  test('reports when no access list is wired', async () => {
    const reply = await ctx().h.admin('GET', '/v1/access');
    expect(reply.status).toBe(404);
    expect(reply.body.error).toBe('access_unavailable');
  });
});
