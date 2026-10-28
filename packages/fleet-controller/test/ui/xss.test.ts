import { describe, expect, test } from 'bun:test';

import { nodeId, nodeRow } from '../../src/testing/fixtures';
import { FIXED_NOW } from '../../src/testing/test-deps';
import {
  COOKIE,
  cookiesFrom,
  get,
  html,
  parseHtml,
  post,
  setup,
} from './helpers';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(2)>',
  "'><svg onload=alert(3)>",
  '</textarea><script>alert(4)</script>',
  '</title><script>alert(5)</script>',
];
const ID = nodeId('bad1');
const payload = (index: number): string => PAYLOADS[index] ?? '';

function hostile() {
  const harness = setup();
  harness.deps.store.seedNode(
    nodeRow({
      short: 'bad1',
      hostname: payload(3),
      displayName: payload(0),
      note: payload(1),
      labels: [payload(2)],
      lastSeenAt: new Date(FIXED_NOW.getTime() - 5000),
      body: {
        failedUnits: [payload(4)],
        sync: { rolledBack: true, healthFailure: payload(1) },
        kernel: payload(2),
        addresses: [payload(3)],
        capabilities: [payload(0)],
        cpu: { model: payload(4) },
      },
    })
  );
  return harness;
}

const DANGEROUS = [
  '<script>alert',
  '<img src=x',
  '<svg onload',
  '</textarea><script',
  '</title><script',
];

async function assertSafe(page: string): Promise<void> {
  for (const bad of DANGEROUS) expect(page).not.toContain(bad);
  const parsed = await parseHtml(page);
  // Only the two locally built entry points may become executable elements.
  const sources = [...page.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map(
    (match) => match[1]
  );
  expect(sources).toEqual(
    page.includes('src="/assets/console.js"')
      ? ['/assets/theme-init.js', '/assets/console.js']
      : []
  );
  expect(parsed.tags.filter((tag) => tag === 'script')).toHaveLength(
    sources.length
  );
  expect(parsed.tags).not.toContain('img');
  expect(parsed.attributes.filter((name) => name.startsWith('on'))).toEqual([]);
}

describe('user supplied text is escaped everywhere', () => {
  test('every page that shows nodes', async () => {
    const { app, deps } = hostile();
    await deps.store.addEvent({
      nodeId: ID,
      nodeLabel: payload(0),
      kind: payload(1),
      severity: 'error',
      message: payload(2),
    });
    for (const path of [
      '/',
      '/nodes',
      '/nodes?status=all',
      `/nodes/${ID}`,
      '/events',
      `/events?node=${ID}`,
      '/ui/fleet',
      '/ui/fleet?view=nodes',
    ]) {
      const page = await html(app, path);
      await assertSafe(page);
      expect(page.length).toBeGreaterThan(100);
    }
    const detail = await html(app, `/nodes/${ID}`);
    expect(detail).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(detail).toContain('&lt;/textarea&gt;&lt;script&gt;');
  });

  test('pending page and its rejected list', async () => {
    const { app, deps } = hostile();
    await deps.store.setApproval(ID, 'pending', 'x');
    await assertSafe(await html(app, '/pending'));
    await deps.store.setApproval(ID, 'rejected', 'x');
    await assertSafe(await html(app, '/pending'));
  });

  test('search text is escaped in the box and the empty state', async () => {
    const { app } = hostile();
    const q = encodeURIComponent('"><script>alert(9)</script>');
    const page = await html(app, `/nodes?q=${q}`);
    await assertSafe(page);
    expect(page).toContain('&lt;script&gt;alert(9)');
    const events = await html(app, `/events?node=${q}&severity=${q}`);
    await assertSafe(events);
  });

  test('flash messages escape the node name', async () => {
    const { app } = hostile();
    const res = await post(app, `/nodes/${ID}/edit`, {
      labels: payload(1),
    });
    const page = await html(app, `/nodes/${ID}`, cookiesFrom(res));
    await assertSafe(page);
    expect(page).toContain('role="alert"');
  });

  test('settings pages escape what was typed back into fields', async () => {
    const { app } = hostile();
    const res = await post(app, '/settings/fleet', {
      mode: 'form',
      'runners.repositories': payload(3),
      'alerts.webhookUrl': payload(1),
      'heartbeat.intervalSeconds': payload(0),
    });
    expect(res.status).toBe(422);
    await assertSafe(await res.text());
    const raw = await post(app, '/settings/fleet', {
      mode: 'raw',
      raw: `{"x":"${payload(0)}`,
    });
    expect(raw.status).toBe(422);
    await assertSafe(await raw.text());
    expect(
      await (await get(app, '/settings/role:ci', COOKIE)).text()
    ).toBeTruthy();
  });

  test('a hostile next on the login form is not reflected as markup', async () => {
    const { app } = hostile();
    const page = await html(
      app,
      `/login?next=${encodeURIComponent('/"><script>alert(1)</script>')}`,
      null
    );
    await assertSafe(page);
  });
});
