/**
 * Regenerates test/github/contract/openapi.subset.json (and SOURCE.md) from
 * GitHub's published REST API description.
 *
 *   bun run scripts/refresh-github-openapi.ts <commit-sha> [--file <local.json>] [--date YYYY-MM-DD]
 *
 * `<commit-sha>` is a full 40-hex commit of github/rest-api-description. The
 * description is downloaded from raw.githubusercontent.com at that commit
 * (nothing else is contacted, no credentials are sent), unless `--file` points
 * at a local copy of the same file (offline use; the sha256 is still recorded).
 * The output depends only on the commit and the selection in
 * test/github/contract/selection.ts, so running it twice gives identical files.
 * It never runs from tests or CI: a maintainer bumps the pin on purpose, then
 * `bun test test/github/contract` shows what GitHub changed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { format, resolveConfig } from 'prettier';

import { UPSTREAM } from '../test/github/contract/selection';
import { buildSubset } from '../test/github/contract/subset';
import { sourceNote } from '../test/github/contract/source-note';

const CONTRACT = join(import.meta.dir, '../test/github/contract');
const SHA = /^[0-9a-f]{40}$/;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function download(commit: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${UPSTREAM.repository}/${commit}/${UPSTREAM.file}`;
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const commit = process.argv[2];
  if (commit === undefined || !SHA.test(commit)) {
    console.error(
      'usage: refresh-github-openapi.ts <40-hex commit sha> [--file local.json] [--date YYYY-MM-DD]'
    );
    process.exit(2);
  }
  const local = option('--file');
  const raw =
    local === undefined ? await download(commit) : readFileSync(local, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const source = { ...UPSTREAM, commit, sha256 };
  const subset = buildSubset(JSON.parse(raw), source);
  const date = option('--date') ?? new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(CONTRACT, 'openapi.subset.json'),
    `${JSON.stringify(subset)}\n`
  );
  const note = join(CONTRACT, 'SOURCE.md');
  const style = (await resolveConfig(note)) ?? {};
  const text = await format(sourceNote(source, date), {
    ...style,
    parser: 'markdown',
  });
  writeFileSync(note, text);
  console.log(`wrote openapi.subset.json from ${commit} (sha256 ${sha256})`);
}

await main();
