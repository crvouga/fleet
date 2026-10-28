import type { Harness, Json, Reply } from '../../support/controller';
import { CI_ENROLLMENT_TOKEN } from '../../support/controller';
import {
  heartbeatBody,
  nodeIdOf,
  type HeartbeatOverrides,
} from '../../support/fixtures';

/**
 * A node as the agent behaves: it reports the desired revision it last
 * accepted, and when a heartbeat answer carries a desired document it
 * persists it and reports that revision next time (PROTOCOL.md).
 */
export interface SimNode {
  readonly n: number;
  readonly id: string;
  /** The revision this node last accepted; null before it accepted any. */
  applied: string | null;
  /** One heartbeat as this node would send it. */
  beat(h: Harness, overrides?: HeartbeatOverrides): Promise<Reply>;
  /** Heartbeats until the answer carries no desired document. */
  settle(h: Harness, overrides?: HeartbeatOverrides): Promise<Reply>;
}

const MAX_SETTLE_ROUNDS = 5;

export function simNode(n: number): SimNode {
  const node: SimNode = {
    n,
    id: nodeIdOf(n),
    applied: null,
    async beat(h, overrides = {}) {
      const reply = await h.asNode(
        n,
        'POST',
        '/v1/heartbeat',
        heartbeatBody(n, {
          ...overrides,
          agent: { version: '2', desiredRevision: node.applied },
        })
      );
      const desired: Json = reply.body?.desired;
      if (reply.status === 200 && typeof desired?.revision === 'string')
        node.applied = desired.revision;
      return reply;
    },
    async settle(h, overrides = {}) {
      let reply = await node.beat(h, overrides);
      for (let i = 0; i < MAX_SETTLE_ROUNDS; i += 1) {
        if (reply.body?.desired === undefined) return reply;
        reply = await node.beat(h, overrides);
      }
      throw new Error('desired revision did not settle');
    },
  };
  return node;
}

/** Registers node n with the CI enrollment token: approved at once, role `ci`. */
export function enrollCi(h: Harness, n: number): Promise<Reply> {
  return h.register(n, { enrollmentToken: CI_ENROLLMENT_TOKEN });
}
