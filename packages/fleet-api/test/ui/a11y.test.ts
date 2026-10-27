import { describe, expect, test } from 'bun:test';

import { IDS, html, seedFleet, setup } from './helpers';

interface Tag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly closing: boolean;
}

function tokenize(page: string): Tag[] {
  const tags: Tag[] = [];
  for (const match of page.matchAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s>/=]+(?:="[^"]*")?)*)\s*\/?>/g
  )) {
    const attrs: Record<string, string> = {};
    for (const attr of (match[3] ?? '').matchAll(
      /([^\s>/=]+)(?:="([^"]*)")?/g
    )) {
      attrs[attr[1] ?? ''] = attr[2] ?? '';
    }
    tags.push({
      name: (match[2] ?? '').toLowerCase(),
      attrs,
      closing: match[1] === '/',
    });
  }
  return tags;
}

const PAGES = (): [string, string][] => [
  ['/', 'overview'],
  ['/nodes', 'nodes'],
  [`/nodes/${IDS.online}`, 'detail'],
  [`/nodes/${IDS.pending}`, 'pending detail'],
  ['/pending', 'pending'],
  ['/events', 'events'],
  ['/settings', 'settings'],
  ['/settings/role:ci', 'role settings'],
  [`/settings/node:${IDS.online}`, 'node settings'],
  ['/add', 'add'],
  ['/login', 'login'],
];

async function render(path: string): Promise<string> {
  const { app, deps } = setup();
  seedFleet(deps);
  return html(app, path, path === '/login' ? null : undefined);
}

const HIDDEN_TYPES = new Set(['hidden', 'submit', 'button', 'reset']);

function isField(tag: Tag): boolean {
  return (
    ['input', 'select', 'textarea'].includes(tag.name) &&
    !tag.closing &&
    !HIDDEN_TYPES.has(tag.attrs['type'] ?? '')
  );
}

/** Names of fields with no label, aria-label or aria-labelledby. */
function unlabelled(page: string): string[] {
  const tags = tokenize(page);
  const forIds = new Set(
    tags
      .filter((t) => t.name === 'label' && t.attrs['for'])
      .map((t) => t.attrs['for'])
  );
  const missing: string[] = [];
  let insideLabel = 0;
  for (const tag of tags) {
    if (tag.name === 'label') insideLabel += tag.closing ? -1 : 1;
    if (!isField(tag)) continue;
    const named =
      insideLabel > 0 ||
      forIds.has(tag.attrs['id']) ||
      tag.attrs['aria-label'] !== undefined ||
      tag.attrs['aria-labelledby'] !== undefined;
    if (!named) missing.push(tag.attrs['name'] ?? tag.name);
  }
  return missing;
}

describe('accessibility lint', () => {
  test('every field has a label', async () => {
    for (const [path, name] of PAGES()) {
      expect({ name, unlabelled: unlabelled(await render(path)) }).toEqual({
        name,
        unlabelled: [],
      });
    }
  });

  test('no aria-hidden anywhere, images have alt', async () => {
    for (const [path] of PAGES()) {
      const page = await render(path);
      expect(page).not.toContain('aria-hidden');
      for (const tag of tokenize(page)) {
        if (tag.name === 'img' && !tag.closing)
          expect(tag.attrs['alt']).toBeDefined();
        if (tag.name === 'svg' && !tag.closing) {
          expect(
            tag.attrs['role'] === 'img'
              ? tag.attrs['aria-label']
              : tag.attrs['role']
          ).toBeTruthy();
        }
      }
    }
  });

  test('one h1 per page and heading levels never skip', async () => {
    for (const [path, name] of PAGES()) {
      const tags = tokenize(await render(path)).filter(
        (t) => /^h[1-6]$/.test(t.name) && !t.closing
      );
      const levels = tags.map((t) => Number(t.name.slice(1)));
      expect({ name, h1: levels.filter((l) => l === 1).length }).toEqual({
        name,
        h1: 1,
      });
      expect(levels[0]).toBe(1);
      levels.forEach((level, index) => {
        const previous = levels[index - 1] ?? 0;
        expect({ name, jump: level - previous <= 1 }).toEqual({
          name,
          jump: true,
        });
      });
    }
  });

  test('tables have captions and column headers with scope', async () => {
    const page = await render('/nodes');
    const tags = tokenize(page);
    expect(tags.some((t) => t.name === 'caption')).toBe(true);
    const headers = tags.filter((t) => t.name === 'th' && !t.closing);
    expect(headers.length).toBeGreaterThan(5);
    for (const th of headers) expect(th.attrs['scope']).toBeDefined();
  });

  test('document language, landmarks, skip link and viewport', async () => {
    const page = await render('/');
    const tags = tokenize(page);
    expect(tags.find((t) => t.name === 'html')?.attrs['lang']).toBe('en');
    for (const landmark of ['header', 'nav', 'main']) {
      expect(tags.some((t) => t.name === landmark)).toBe(true);
    }
    expect(page).toContain('width=device-width');
    expect(page).toContain('Skip to content');
  });

  test('buttons and links that hold only an icon have a name', async () => {
    const page = await render('/nodes');
    for (const tag of tokenize(page)) {
      if (tag.attrs['data-copy'] !== undefined) {
        expect(tag.attrs['aria-label']).toBeTruthy();
      }
    }
  });

  test('status is never color alone: dots are followed by words', async () => {
    const page = await render('/nodes');
    expect(page).not.toMatch(/size-2 rounded-full[^>]*><\/span><\/span>/);
  });
});
