import { expect, test } from 'bun:test';

import type { NodeEventInput, RecoveryFacts } from '../../src/types';
import { CI_ROLE_TOKEN } from '../support/api';
import { describeApi } from '../support/describe-api';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

const RECOVERY: RecoveryFacts = {
  boot: { previousClean: false, previousEndedAt: null, uncleanOfLast: [1, 2] },
  quarantine: null,
  gate: { closed: true, reasons: ['low-disk'] },
  outbox: 1,
};

// nested is not a flat scalar: the server must drop it, so the type is bypassed on purpose.
const INTERRUPTED = {
  kind: 'job-interrupted',
  severity: 'warn',
  message: 'A CI job on slot-1 was interrupted by a reset or power loss.',
  key: 'job:owner-repo:1234:1:build',
  at: '2026-10-26T11:00:00Z',
  data: {
    slot: 'slot-1',
    runId: '1234',
    url: 'https://github.com/owner/repo/actions/runs/1234',
    nested: { no: 1 },
  },
} as unknown as NodeEventInput;

describeApi('recovery reports', (ctx) => {
  test('a resent outbox event is stored once, with its key, time and evidence', async () => {
    const { h } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    await h.admin('POST', `/v1/nodes/${nodeIdOf(1)}/approve`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The node did not see the answer, so it sends the same event again.
      const reply = await h.asNode(
        1,
        'POST',
        '/v1/heartbeat',
        heartbeatBody(1, { events: [INTERRUPTED], recovery: RECOVERY })
      );
      expect(reply.status).toBe(200);
    }
    const events = (
      await h.admin('GET', '/v1/events?limit=200')
    ).body.events.filter(
      (event: { kind: string }) => event.kind === 'job-interrupted'
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      key: INTERRUPTED.key,
      occurredAt: INTERRUPTED.at,
      runId: '1234',
      url: 'https://github.com/owner/repo/actions/runs/1234',
    });
    expect(events[0].data.nested).toBeUndefined();
  });

  test('recovery facts are kept with the report; a malformed key is refused', async () => {
    const { h, store } = ctx();
    await h.register(1, { roleToken: CI_ROLE_TOKEN });
    const ok = await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, { recovery: RECOVERY })
    );
    expect(ok.status).toBe(200);
    expect(
      (await store.findNode(nodeIdOf(1)))?.facts['recovery']
    ).toMatchObject({
      gate: { closed: true, reasons: ['low-disk'] },
    });
    const bad = await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1, { events: [{ ...INTERRUPTED, key: 'has space' }] })
    );
    expect(bad.status).toBe(400);
  });
});
