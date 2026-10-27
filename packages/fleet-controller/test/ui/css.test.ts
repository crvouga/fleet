import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'bun:test';

import { classLiterals, classTokens, selectorFor } from './class-literals';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UI = join(ROOT, 'src/ui');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

let css = '';

beforeAll(async () => {
  const build = Bun.spawn([process.execPath, 'run', 'build:css'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await build.exited;
  if (code !== 0)
    throw new Error(
      `build:css failed: ${await new Response(build.stderr).text()}`
    );
  css = readFileSync(join(ROOT, 'dist/app.css'), 'utf8');
}, 120_000);

describe('stylesheet', () => {
  test('builds, is minified and defines both themes', () => {
    expect(css.length).toBeGreaterThan(5000);
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain('prefers-reduced-motion');
  });

  test('every Tailwind class written in src/ui exists in dist/app.css', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of sources(UI).filter(
      (f) =>
        f.endsWith('.tsx') ||
        f.endsWith('tw.ts') ||
        f.includes('/lib/') ||
        f.includes('/components/')
    )) {
      for (const token of classTokens(readFileSync(file, 'utf8'))) {
        checked += 1;
        if (!css.includes(selectorFor(token)))
          missing.push(`${file.replace(ROOT, '')}: ${token}`);
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(missing).toEqual([]);
  });

  test('the dashboard pages only use classes the stylesheet has', async () => {
    const { setup, seedFleet, html } = await import('./helpers');
    const { app, deps } = setup();
    seedFleet(deps);
    const unknown = new Set<string>();
    for (const path of [
      '/',
      '/nodes',
      `/nodes/${'a3f9'.padEnd(64, '0')}`,
      '/pending',
      '/events',
      '/settings',
      '/add',
    ]) {
      const page = await html(app, path);
      for (const match of page.matchAll(/\sclass="([^"]*)"/g)) {
        for (const token of (match[1] ?? '').split(/\s+/)) {
          if (
            token !== '' &&
            token !== 'group' &&
            token !== 'peer' &&
            !css.includes(selectorFor(token))
          ) {
            unknown.add(token);
          }
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });

  test('the class extractor understands attributes, expressions and tw()', () => {
    const source = `
      <a class="a b" />
      <b class={cx('c d', open ? "e" : 'f')} />
      <i class={\`g h\`} />
      const x = tw('i j');
      <u className="nope" />
    `;
    expect(classLiterals(source)).toEqual([
      'a b',
      'c d',
      'e',
      'f',
      'g h',
      'i j',
    ]);
    expect(selectorFor('md:grid-cols-2')).toBe('.md\\:grid-cols-2');
    expect(selectorFor('w-1/2')).toBe('.w-1\\/2');
  });
});
