import { describe, expect, test } from 'bun:test';

import { nodesHref, parseNodesQuery } from '../../src/ui/lib/nodes-query';
import { html, seedFleet, setup } from './helpers';

async function nodesPage(query = '') {
  const { app, deps } = setup();
  seedFleet(deps);
  return html(app, `/nodes${query}`);
}

function order(page: string, hostnames: readonly string[]): string[] {
  return hostnames
    .map((name) => ({ name, at: page.indexOf(`>${name}<`) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((item) => item.name);
}

const WEB = ['web-3e4f', 'web-2c3d'];

describe('nodes list', () => {
  test('default view hides retired and rejected, and counts every tab', async () => {
    const page = await nodesPage();
    expect(page).toContain('Build 1');
    expect(page).toContain('ci-c7d2');
    expect(page).not.toContain('devbox-dead');
    expect(page).not.toContain('devbox-ba11');
    expect(page).toMatch(/Online\s*<span[^>]*>5</);
    expect(page).toMatch(/Retired\s*<span[^>]*>1</);
    expect(page).toMatch(/Rejected\s*<span[^>]*>1</);
  });

  test('status shows as text next to the dot, never color alone', async () => {
    const page = await nodesPage();
    for (const text of ['Online', 'Stale', 'Offline', 'Pending']) {
      expect(page).toMatch(new RegExp(`</span>${text}</span>`));
    }
  });

  test('status filter', async () => {
    const offline = await nodesPage('?status=offline');
    expect(offline).toContain('ci-c7d2');
    expect(offline).not.toContain('Build 1');
    const retired = await nodesPage('?status=retired');
    expect(retired).toContain('devbox-dead');
    expect(retired).not.toContain('ci-c7d2');
    const pending = await nodesPage('?status=pending');
    expect(pending).toContain('netboot-f001');
    expect(pending).not.toContain('web-3e4f');
  });

  test('role filter', async () => {
    const page = await nodesPage('?role=web');
    expect(page).toContain('web-3e4f');
    expect(page).toContain('web-2c3d');
    expect(page).not.toContain('cache-7f10');
    expect(page).toContain('<option value="web" selected');
  });

  test('free-text search matches name, hostname, labels, revision and address', async () => {
    expect(await nodesPage('?q=build')).toContain('Build 1');
    expect(await nodesPage('?q=CI-C7D2')).toContain('ci-c7d2');
    expect(await nodesPage('?q=rack-2')).toContain('Build 1');
    expect(await nodesPage('?q=rack-2')).not.toContain('ci-c7d2');
    expect(await nodesPage('?q=7a1b3c4')).toContain('ci-c7d2');
    expect(await nodesPage('?q=192.168.1.20')).toContain('cache-7f10');
    const none = await nodesPage('?q=zzzzzz');
    expect(none).toContain('No nodes match these filters');
    expect(none).toContain('Nothing found for &quot;zzzzzz&quot;.');
    expect(none).toContain('Clear filters');
  });

  test('sort by name both ways, marked with aria-sort', async () => {
    const asc = await nodesPage('?role=web&sort=name&dir=asc');
    expect(order(asc, WEB)).toEqual(['web-2c3d', 'web-3e4f']);
    expect(asc).toContain('aria-sort="ascending"');
    const desc = await nodesPage('?role=web&sort=name&dir=desc');
    expect(order(desc, WEB)).toEqual(['web-3e4f', 'web-2c3d']);
    expect(desc).toContain('aria-sort="descending"');
  });

  test('default sort puts what needs attention first', async () => {
    const page = await nodesPage();
    expect(order(page, ['ci-c7d2', 'netboot-f001', 'web-3e4f'])[0]).toBe(
      'ci-c7d2'
    );
    expect(page).toContain('aria-sort="ascending"');
  });

  test('sort by disk descending shows the fullest first', async () => {
    const page = await nodesPage('?role=web&sort=disk');
    expect(order(page, WEB)).toEqual(['web-2c3d', 'web-3e4f']);
  });

  test('missing values sort last whichever way', async () => {
    const down = await nodesPage('?sort=slots&dir=desc');
    const up = await nodesPage('?sort=slots&dir=asc');
    for (const page of [down, up]) {
      expect(order(page, ['ci-b21c', 'web-3e4f'])).toEqual([
        'ci-b21c',
        'web-3e4f',
      ]);
    }
  });

  test('header links toggle direction and keep filters', async () => {
    const page = await nodesPage('?role=ci&sort=name&dir=asc');
    expect(page).toContain('href="/nodes?role=ci&amp;sort=name&amp;dir=desc"');
    expect(page).toContain('href="/nodes?role=ci&amp;sort=seen&amp;dir=desc"');
  });

  test('behind marker, runner slots and copy buttons', async () => {
    const page = await nodesPage();
    expect(page).toContain('>behind<');
    expect(page).toMatch(/4<span[^>]*> \/ 6<\/span>/);
    expect(page).toContain('data-copy="ci-c7d2"');
    expect(page).toContain('>high-mem<');
  });

  test('garbage query values fall back to defaults', async () => {
    const page = await nodesPage('?status=nope&role=nope&sort=nope&dir=nope');
    expect(page).toContain('Build 1');
  });
});

describe('query helpers', () => {
  test('parse and rebuild round trip', () => {
    const query = parseNodesQuery({
      status: 'stale',
      role: 'ci',
      q: '  x ',
      sort: 'mem',
    });
    expect(query).toEqual({
      status: 'stale',
      role: 'ci',
      q: 'x',
      sort: 'mem',
      dir: 'desc',
    });
    expect(nodesHref(query)).toBe(
      '/nodes?status=stale&role=ci&q=x&sort=mem&dir=desc'
    );
    expect(nodesHref(parseNodesQuery({}))).toBe('/nodes');
    expect(nodesHref(query, { status: null, q: '' })).toBe(
      '/nodes?role=ci&sort=mem&dir=desc'
    );
  });

  test('search is capped', () => {
    expect(parseNodesQuery({ q: 'a'.repeat(500) }).q).toHaveLength(100);
  });
});
