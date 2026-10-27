import { describe, expect, test } from 'bun:test';

import { describeStore } from '../support/describe-store';
import {
  T0,
  at,
  heartbeatBody,
  nodeIdOf,
  registerInput,
  sha256,
  secretOf,
} from '../support/fixtures';

describeStore('PgStore nodes', (ctx) => {
  test('health resolves against a live database', async () => {
    await expect(ctx().store.health()).resolves.toBeUndefined();
  });

  describe('registerNode', () => {
    test('creates a pending node from a hello', async () => {
      const { node, created } = await ctx().store.registerNode(
        registerInput(1)
      );
      expect(created).toBe(true);
      expect(node).toMatchObject({
        id: nodeIdOf(1),
        role: 'ci',
        approval: 'pending',
        enrolledVia: 'hello',
        approvedAt: null,
        approvedBy: null,
        retiredAt: null,
        lastSeenAt: null,
        offlineNotifiedAt: null,
        labels: [],
        facts: {},
        heartbeatIntervalSeconds: 60,
        remoteAddr: '203.0.113.7',
      });
      expect(node.firstSeenAt).toBeInstanceOf(Date);
    });

    test('a role token approves immediately and records who approved', async () => {
      const { node } = await ctx().store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      expect(node.approval).toBe('approved');
      expect(node.enrolledVia).toBe('role-token');
      expect(node.approvedBy).toBe('role-token');
      expect(node.approvedAt).toBeInstanceOf(Date);
    });

    test('is idempotent and replaces the secret', async () => {
      const { store } = ctx();
      const first = await store.registerNode(registerInput(1));
      const replacement = sha256('a-brand-new-secret');
      const again = await store.registerNode(
        registerInput(1, { secretHash: replacement })
      );
      expect(again.created).toBe(false);
      expect(again.node.firstSeenAt).toEqual(first.node.firstSeenAt);
      expect(
        await store.authenticateNode(nodeIdOf(1), registerInput(1).secretHash)
      ).toBeNull();
      expect((await store.authenticateNode(nodeIdOf(1), replacement))?.id).toBe(
        nodeIdOf(1)
      );
      expect(await store.listNodes()).toHaveLength(1);
    });

    test('registering again updates role, hostname and address', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      const { node } = await store.registerNode(
        registerInput(1, {
          role: 'web',
          hostname: 'web-9999',
          remoteAddr: null,
        })
      );
      expect(node).toMatchObject({
        role: 'web',
        hostname: 'web-9999',
        remoteAddr: null,
      });
    });

    test('an approved node that registers without the role token waits for a person again', async () => {
      const { store } = ctx();
      await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      const { node } = await store.registerNode(registerInput(1));
      expect(node.approval).toBe('pending');
      expect(node.approvedAt).toBeNull();
      expect(node.approvedBy).toBeNull();
    });

    test('an approved node that registers with the role token keeps its approval time', async () => {
      const { store } = ctx();
      const first = await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      const again = await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      expect(again.node.approvedAt).toEqual(first.node.approvedAt);
    });

    test('a rejected node stays rejected, even with a role token', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.setApproval(nodeIdOf(1), 'rejected', 'chris');
      const { node } = await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      expect(node.approval).toBe('rejected');
      expect(node.enrolledVia).toBe('hello');
    });

    test('a retired node becomes pending, or approved with the role token', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.setApproval(nodeIdOf(1), 'retired', 'node');
      const pending = await store.registerNode(registerInput(1));
      expect(pending.node.approval).toBe('pending');
      expect(pending.node.retiredAt).toBeNull();
      await store.setApproval(nodeIdOf(1), 'retired', 'node');
      const approved = await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      expect(approved.node.approval).toBe('approved');
      expect(approved.node.retiredAt).toBeNull();
    });

    test('records registered, reregistered and approved events', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      await store.registerNode(registerInput(1));
      const kinds = (await store.listEvents({ limit: 20 })).map((e) => [
        e.kind,
        e.severity,
      ]);
      expect(kinds).toEqual([
        ['reregistered', 'warn'],
        ['approved', 'info'],
        ['reregistered', 'info'],
        ['registered', 'info'],
      ]);
    });

    test('concurrent first registrations of one id produce one node', async () => {
      const { store } = ctx();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          store.registerNode(registerInput(1, { secretHash: sha256(`s${i}`) }))
        )
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await store.listNodes()).toHaveLength(1);
    });

    test('rejects values the schema forbids rather than storing them', async () => {
      const { store } = ctx();
      await expect(
        store.registerNode(registerInput(1, { id: 'not-hex' }))
      ).rejects.toThrow();
      expect(await store.listNodes()).toHaveLength(0);
    });
  });

  describe('findNode and authenticateNode', () => {
    test('find returns the row or null', async () => {
      const { store } = ctx();
      expect(await store.findNode(nodeIdOf(1))).toBeNull();
      await store.registerNode(registerInput(1));
      expect((await store.findNode(nodeIdOf(1)))?.hostname).toBe(
        `ci-${nodeIdOf(1).slice(0, 4)}`
      );
    });

    test('the node row never carries the secret hash', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      const node = await store.findNode(nodeIdOf(1));
      expect(JSON.stringify(node)).not.toContain(registerInput(1).secretHash);
    });

    test('accepts the right secret for pending and approved nodes', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      expect(
        (await store.authenticateNode(nodeIdOf(1), registerInput(1).secretHash))
          ?.approval
      ).toBe('pending');
      await store.setApproval(nodeIdOf(1), 'approved', 'chris');
      expect(
        (await store.authenticateNode(nodeIdOf(1), registerInput(1).secretHash))
          ?.approval
      ).toBe('approved');
    });

    test('refuses a wrong secret, an unknown id and a malformed hash', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      expect(
        await store.authenticateNode(nodeIdOf(1), sha256('wrong'))
      ).toBeNull();
      expect(await store.authenticateNode(nodeIdOf(1), 'short')).toBeNull();
      expect(
        await store.authenticateNode(nodeIdOf(2), registerInput(1).secretHash)
      ).toBeNull();
    });

    test('refuses rejected and retired nodes, but verifyNodeSecret still sees them', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.registerNode(registerInput(2));
      await store.setApproval(nodeIdOf(1), 'rejected', 'chris');
      await store.setApproval(nodeIdOf(2), 'retired', 'chris');
      for (const n of [1, 2]) {
        expect(
          await store.authenticateNode(nodeIdOf(n), registerInput(n).secretHash)
        ).toBeNull();
        expect(
          await store.verifyNodeSecret?.(
            nodeIdOf(n),
            registerInput(n).secretHash
          )
        ).not.toBeNull();
        expect(
          await store.verifyNodeSecret?.(nodeIdOf(n), sha256('wrong'))
        ).toBeNull();
      }
    });
  });

  describe('setApproval', () => {
    test('approves, records the approver and clears an offline notice', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.setOfflineNotified(nodeIdOf(1), T0);
      const node = await store.setApproval(nodeIdOf(1), 'approved', 'chris');
      expect(node).toMatchObject({
        approval: 'approved',
        approvedBy: 'chris',
        offlineNotifiedAt: null,
      });
      expect(node?.approvedAt).toBeInstanceOf(Date);
    });

    test('retiring stamps retiredAt and approving again clears it', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      const retired = await store.setApproval(nodeIdOf(1), 'retired', 'chris');
      expect(retired?.retiredAt).toBeInstanceOf(Date);
      const back = await store.setApproval(nodeIdOf(1), 'approved', 'chris');
      expect(back?.retiredAt).toBeNull();
    });

    test('is a no-op, and records nothing, when the state already holds', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.setApproval(nodeIdOf(1), 'approved', 'chris');
      const before = (await store.listEvents({ limit: 50 })).length;
      const again = await store.setApproval(
        nodeIdOf(1),
        'approved',
        'someone-else'
      );
      expect(again?.approvedBy).toBe('chris');
      expect((await store.listEvents({ limit: 50 })).length).toBe(before);
    });

    test('returns null for an unknown node', async () => {
      expect(
        await ctx().store.setApproval(nodeIdOf(9), 'approved', 'chris')
      ).toBeNull();
    });

    test('names the actor in the event', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.setApproval(nodeIdOf(1), 'rejected', 'chris');
      const [event] = await store.listEvents({ limit: 1 });
      expect(event).toMatchObject({
        kind: 'rejected',
        severity: 'warn',
        nodeId: nodeIdOf(1),
      });
      expect(event?.message).toContain('chris');
    });
  });

  describe('patchNode', () => {
    test('changes only what is given', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.patchNode(
        nodeIdOf(1),
        { displayName: 'Rack 1', note: 'top shelf', labels: ['a', 'b'] },
        'chris'
      );
      const node = await store.patchNode(
        nodeIdOf(1),
        { note: 'moved' },
        'chris'
      );
      expect(node).toMatchObject({
        displayName: 'Rack 1',
        note: 'moved',
        labels: ['a', 'b'],
      });
    });

    test('null clears a text field and an empty list clears labels', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.patchNode(
        nodeIdOf(1),
        { displayName: 'x', note: 'y', labels: ['z'] },
        'chris'
      );
      const node = await store.patchNode(
        nodeIdOf(1),
        { displayName: null, note: null, labels: [] },
        'chris'
      );
      expect(node).toMatchObject({ displayName: null, note: null, labels: [] });
    });

    test('labels survive commas, quotes, braces and backslashes', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      const awkward = [
        'a,b',
        'say "hi"',
        '{curly}',
        'back\\slash',
        "o'neil",
        'NULL',
        ' spaced ',
      ];
      const node = await store.patchNode(
        nodeIdOf(1),
        { labels: awkward },
        'chris'
      );
      expect(node?.labels).toEqual(awkward);
      expect((await store.findNode(nodeIdOf(1)))?.labels).toEqual(awkward);
    });

    test('display name is used as the label of later events', async () => {
      const { store } = ctx();
      await store.registerNode(registerInput(1));
      await store.patchNode(nodeIdOf(1), { displayName: 'Rack 1' }, 'chris');
      await store.setApproval(nodeIdOf(1), 'approved', 'chris');
      const [event] = await store.listEvents({ limit: 1 });
      expect(event?.nodeLabel).toBe('Rack 1');
    });

    test('returns null for an unknown node and writes no event', async () => {
      const { store } = ctx();
      expect(
        await store.patchNode(nodeIdOf(9), { note: 'x' }, 'chris')
      ).toBeNull();
      expect(await store.listEvents({ limit: 5 })).toHaveLength(0);
    });
  });

  describe('deleteNode', () => {
    test('forgets the node, cascades its history and keeps its events by label', async () => {
      const { store, db } = ctx();
      await store.registerNode(registerInput(1));
      await store.registerNode(registerInput(2));
      await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, T0);
      await store.putSettings(
        `node:${nodeIdOf(1)}`,
        { sync: { paused: true } },
        'chris'
      );
      await store.putSettings('fleet', { sync: { paused: false } }, 'chris');
      expect(await store.deleteNode(nodeIdOf(1), 'chris')).toBe(true);
      expect(await store.findNode(nodeIdOf(1))).toBeNull();
      expect(await store.findNode(nodeIdOf(2))).not.toBeNull();
      expect(await store.listHeartbeats(nodeIdOf(1), at(-3600))).toHaveLength(
        0
      );
      expect(await store.getSettings(`node:${nodeIdOf(1)}`)).toBeNull();
      expect(await store.getSettings('fleet')).not.toBeNull();
      const kept =
        await db.sql`select node_id, node_label, kind from fleet.events where node_label = ${`ci-${nodeIdOf(1).slice(0, 4)}`} order by id`;
      expect(kept.length).toBeGreaterThanOrEqual(2);
      expect(
        kept.every((row: { node_id: string | null }) => row.node_id === null)
      ).toBe(true);
      expect(kept.at(-1)?.kind).toBe('node_deleted');
    });

    test('returns false for an unknown node', async () => {
      expect(await ctx().store.deleteNode(nodeIdOf(9), 'chris')).toBe(false);
    });
  });

  describe('listNodes', () => {
    test('newest report first, silent nodes last', async () => {
      const { store } = ctx();
      for (const n of [1, 2, 3]) {
        await store.registerNode(
          registerInput(n, { approval: 'approved', enrolledVia: 'role-token' })
        );
      }
      await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, at(10));
      await store.recordHeartbeat(nodeIdOf(3), heartbeatBody(3), null, at(20));
      const order = (await store.listNodes()).map((node) => node.id);
      expect(order.slice(0, 2)).toEqual([nodeIdOf(3), nodeIdOf(1)]);
      expect(order[2]).toBe(nodeIdOf(2));
    });
  });

  describe('nodesDueOfflineNotice and setOfflineNotified', () => {
    test('is due strictly after the threshold, never at it', async () => {
      const { store } = ctx();
      await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, T0);
      expect(await store.nodesDueOfflineNotice(at(300), 300)).toHaveLength(0);
      expect(await store.nodesDueOfflineNotice(at(301), 300)).toHaveLength(1);
    });

    test('only approved nodes that have not been announced', async () => {
      const { store } = ctx();
      for (const n of [1, 2, 3, 4]) {
        await store.registerNode(
          registerInput(n, { approval: 'approved', enrolledVia: 'role-token' })
        );
        await store.recordHeartbeat(nodeIdOf(n), heartbeatBody(n), null, T0);
      }
      await store.setApproval(nodeIdOf(2), 'retired', 'x');
      await store.setApproval(nodeIdOf(3), 'rejected', 'x');
      await store.setOfflineNotified(nodeIdOf(4), at(100));
      const due = await store.nodesDueOfflineNotice(at(1000), 300);
      expect(due.map((n) => n.id)).toEqual([nodeIdOf(1)]);
    });

    test('a node that never reported counts from its approval', async () => {
      const { store, db } = ctx();
      await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      const row = await db.sql`select approved_at from fleet.nodes`;
      const approvedAt = row[0].approved_at as Date;
      expect(
        await store.nodesDueOfflineNotice(
          new Date(approvedAt.getTime() + 299_000),
          300
        )
      ).toHaveLength(0);
      expect(
        await store.nodesDueOfflineNotice(
          new Date(approvedAt.getTime() + 301_000),
          300
        )
      ).toHaveLength(1);
    });

    test('setOfflineNotified marks and clears, and a heartbeat clears it too', async () => {
      const { store } = ctx();
      await store.registerNode(
        registerInput(1, { approval: 'approved', enrolledVia: 'role-token' })
      );
      await store.setOfflineNotified(nodeIdOf(1), at(5));
      expect((await store.findNode(nodeIdOf(1)))?.offlineNotifiedAt).toEqual(
        at(5)
      );
      await store.setOfflineNotified(nodeIdOf(1), null);
      expect((await store.findNode(nodeIdOf(1)))?.offlineNotifiedAt).toBeNull();
      await store.setOfflineNotified(nodeIdOf(1), at(6));
      await store.recordHeartbeat(nodeIdOf(1), heartbeatBody(1), null, at(7));
      expect((await store.findNode(nodeIdOf(1)))?.offlineNotifiedAt).toBeNull();
    });
  });

  test('secret material never leaves the database', async () => {
    const { store } = ctx();
    await store.registerNode(registerInput(1));
    const everything = JSON.stringify([
      await store.listNodes(),
      await store.listEvents({ limit: 50 }),
      await store.findNode(nodeIdOf(1)),
    ]);
    expect(everything).not.toContain(registerInput(1).secretHash);
    expect(everything).not.toContain(secretOf(1));
  });
});
