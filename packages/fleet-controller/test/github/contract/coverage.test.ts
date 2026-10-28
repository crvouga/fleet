import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { github } from './openapi';
import {
  ALLOWED_OUTSIDE_DESCRIPTION,
  EXERCISED,
  OPERATIONS,
} from './selection';
import {
  fragmentInDescription,
  githubLooking,
  methodsNamed,
  pathFragments,
} from './static-scan';

const CONTROLLER = join(import.meta.dir, '../../..');
const SRC = join(CONTROLLER, 'src');
const RUNNER_CONTROL = join(CONTROLLER, '../fleet/scripts/runner_control.py');

/** The files that build requests for GitHub's API. A new one has to be reviewed here. */
const REQUEST_BUILDERS = [
  'src/github/client.ts',
  'src/github/token-cache.ts',
  'src/github/types.ts',
  'src/github/transport.ts',
  'src/issues/github-issues.ts',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => relative(CONTROLLER, path);
const templates = github.templates();

function unknownFragments(source: string, onlyGithub = false): string[] {
  return pathFragments(source)
    .filter((f) => !onlyGithub || githubLooking(f, templates))
    .filter((f) => !fragmentInDescription(f, templates))
    .map((f) => f.raw)
    .filter((raw) => ALLOWED_OUTSIDE_DESCRIPTION[raw] === undefined);
}

describe('the scan itself', () => {
  const fragment = (text: string) => {
    const [found] = pathFragments(`const x = \`${text}\`;`);
    if (found === undefined) throw new Error(`no fragment in ${text}`);
    return found;
  };

  test('recognises endpoints the description defines', () => {
    for (const text of [
      '/repos/${repository}/actions/runs?status=${status}&per_page=${n}',
      '${targetPath(target)}/registration-token',
      '${targetPath(target)}/${runnerId}/labels/${encodeURIComponent(label)}',
      '/${root}/${target.name}/actions/runners',
      '/app/installations/${id}/access_tokens',
      '/installation/repositories',
      '${repoPath(client)}/issues/${number}/comments',
    ])
      expect(fragmentInDescription(fragment(text), templates)).toBe(true);
  });

  test('flags endpoints it does not define', () => {
    for (const text of [
      '/repos/${repository}/hooks',
      '${targetPath(target)}/evil',
      '/user/repos',
      '/search/issues?q=x',
      '/repos/${r}/actions/runs/${id}/cancel',
      '${repoPath(client)}/pulls',
    ])
      expect(fragmentInDescription(fragment(text), templates)).toBe(false);
  });

  test('ignores strings that are not paths', () => {
    expect(
      pathFragments(
        `const a = 'application/json'; const b = "https://api.github.com";`
      )
    ).toEqual([]);
  });

  test('a method the description has no operation for is noticed', () => {
    expect([...methodsNamed(`send('PUT', x); "GET"; 'DELETE'`)].sort()).toEqual(
      ['DELETE', 'GET', 'PUT']
    );
  });
});

describe('new GitHub calls must be added to the contract', () => {
  test('the scan finds the calls it is supposed to guard', () => {
    const found = REQUEST_BUILDERS.flatMap((file) =>
      pathFragments(read(join(CONTROLLER, file)))
    );
    expect(found.length).toBeGreaterThanOrEqual(12);
  });

  test('every API path in the request-building files is in the vendored description', () => {
    for (const file of REQUEST_BUILDERS)
      expect({
        file,
        unknown: unknownFragments(read(join(CONTROLLER, file))),
      }).toEqual({ file, unknown: [] });
  });

  test('every HTTP method the client names has an operation in the description', () => {
    const known = new Set(
      Object.values(OPERATIONS).flatMap((methods) =>
        methods.map((m) => m.toUpperCase())
      )
    );
    for (const file of REQUEST_BUILDERS)
      for (const method of methodsNamed(read(join(CONTROLLER, file))))
        expect({ file, method, known: known.has(method) }).toEqual({
          file,
          method,
          known: true,
        });
  });

  test('only the reviewed files talk to GitHub (no new HTTP call site slips past the scan)', () => {
    const files = sourceFiles(SRC).filter((file) => {
      const text = read(file);
      return (
        text.includes('X-GitHub-Api-Version') ||
        text.includes('application/vnd.github') ||
        (text.includes('api.github.com') && /\bfetch\(/.test(text))
      );
    });
    expect(files.map(rel).sort()).toEqual([
      'src/github/transport.ts',
      'src/issues/github-issues.ts',
    ]);
    const senders = sourceFiles(join(SRC, 'github'))
      .filter(
        (file) => /\bsend\(/.test(read(file)) && !file.endsWith('transport.ts')
      )
      .map(rel)
      .sort();
    expect(senders).toEqual([
      'src/github/client.ts',
      'src/github/token-cache.ts',
    ]);
  });

  test('the node-side runner-control script calls only endpoints in the description', () => {
    const source = read(RUNNER_CONTROL);
    expect(
      pathFragments(source).filter((f) => githubLooking(f, templates)).length
    ).toBeGreaterThanOrEqual(5);
    expect(unknownFragments(source, true)).toEqual([]);
    expect(
      [...methodsNamed(source)].filter(
        (m) => !['GET', 'POST', 'DELETE'].includes(m)
      )
    ).toEqual([]);
  });

  test('every allow-listed exception has a reason and is still needed', () => {
    const all = [
      ...REQUEST_BUILDERS.map((f) => join(CONTROLLER, f)),
      RUNNER_CONTROL,
    ]
      .flatMap((file) => pathFragments(read(file)))
      .map((f) => f.raw);
    for (const [raw, reason] of Object.entries(ALLOWED_OUTSIDE_DESCRIPTION)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(all).toContain(raw);
    }
  });
});

describe('every operation in the description is run by a contract test', () => {
  test('the exercised lists cover exactly the selected operations', () => {
    const exercised = new Set(
      [...EXERCISED.githubClient, ...EXERCISED.issuesClient].map((key) => {
        const [method, template] = key.split(' ');
        return `${method} ${template}`;
      })
    );
    expect([...exercised].sort()).toEqual(github.operations().sort());
  });
});
