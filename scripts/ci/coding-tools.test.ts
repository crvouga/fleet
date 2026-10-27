import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const jobs = parse(
  readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8'
  )
).jobs;
const step = (job: string, name: string) =>
  jobs[job].steps.find((item: { name?: string }) => item.name === name);
const exporter = step(
  'coding_tools',
  'Export the complete coding runtime closure'
);
const importer = step('nix', 'Import and verify the exact coding runtime');

test('one required toolchain build feeds every bounded check lane through this workflow artifact', () => {
  expect(jobs.coding_tools.needs).toBe('changes');
  expect(jobs.coding_tools.if).toBe(jobs.nix.if);
  expect(jobs.nix.needs).toEqual(['changes', 'coding_tools']);
  expect(jobs.nix['timeout-minutes']).toBe(20);
  expect(step('nix', 'Test all Nix checks').run).toContain('timeout 12m');
  const upload = step(
    'coding_tools',
    'Upload the coding runtime for this workflow'
  );
  const download = step('nix', "Download this workflow's coding runtime");
  expect(upload.with.name).toBe(download.with.name);
  expect(upload.with['if-no-files-found']).toBe('error');
  expect(download.if).toBeUndefined();
  expect(download.with['run-id']).toBeUndefined();
  expect(download.with.repository).toBeUndefined();
  expect(jobs.nix.steps.indexOf(importer)).toBeLessThan(
    jobs.nix.steps.indexOf(step('nix', 'Test all Nix checks'))
  );
  expect(importer['continue-on-error']).toBeUndefined();
  expect(importer.run).not.toContain('--no-check-sigs');
});

function transfer(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'coding-closure-test-'));
  const file = (name: string) => join(directory, name);
  const bin = file('bin');
  mkdirSync(bin);
  mkdirSync(file('fleet-coding-tools'));
  const executable = (name: string, source: string) =>
    writeFileSync(join(bin, name), '#!/bin/sh\n' + source, { mode: 0o755 });
  executable(
    'nix-store',
    `
case "$1" in
  --query)
    [ "$FIXTURE_MODE" != query-fail ] || exit 41
    printf '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dependency\\n/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-tools\\n'
    ;;
  --export)
    shift
    printf '%s\\n' "$@" > "$FIXTURE_ROOT/exported-paths"
    printf 'serialized closure'
    [ "$FIXTURE_MODE" != export-fail ] || exit 42
    ;;
  --import)
    cat > "$FIXTURE_ROOT/imported"
    [ "$FIXTURE_MODE" != import-fail ] || exit 43
    ;;
  *) exit 44 ;;
esac
`
  );
  executable(
    'nix',
    `
printf '%s\\n' "$@" > "$FIXTURE_ROOT/build-args"
[ "$FIXTURE_MODE" != missing-runtime ] || exit 45
`
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    FIXTURE_ROOT: directory,
    FIXTURE_MODE: mode,
  };
  const run = (source: string) =>
    Bun.spawnSync(['bash', '-c', source], { cwd: directory, env });
  try {
    const exported = run(exporter.run);
    if (exported.exitCode !== 0)
      return {
        exportCode: exported.exitCode,
        importCode: null,
        imported: '',
        build: '',
        paths: [],
      };
    const archive = file('fleet-coding-tools/fleet-coding-tools.nar.zst');
    writeFileSync(
      archive,
      mode === 'corrupt'
        ? 'not a NAR archive'
        : readFileSync(file('fleet-coding-tools.nar.zst'))
    );
    const imported = run(importer.run);
    const read = (name: string) => {
      try {
        return readFileSync(file(name), 'utf8');
      } catch {
        return '';
      }
    };
    return {
      exportCode: exported.exitCode,
      importCode: imported.exitCode,
      imported: read('imported'),
      build: read('build-args'),
      paths: read('exported-paths').trim().split('\n'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the complete compressed closure transfers before the exact runtime is required without compilation', () => {
  const result = transfer('success');
  expect(result.exportCode).toBe(0);
  expect(result.importCode).toBe(0);
  expect(result.imported).toBe('serialized closure');
  expect(result.paths).toEqual([
    '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dependency',
    '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-tools',
  ]);
  expect(result.build.split('\n')).toContain('.#coding-tools');
  expect(result.build).toContain('--max-jobs\n0\n');
  expect(result.build).toContain('--no-write-lock-file');
});

for (const mode of ['query-fail', 'export-fail']) {
  test(`${mode} cannot become a successful exported artifact`, () => {
    expect(transfer(mode).exportCode).not.toBe(0);
  });
}

for (const mode of ['import-fail', 'corrupt']) {
  test(`${mode} blocks checks before materializing the runtime`, () => {
    const result = transfer(mode);
    expect(result.importCode).not.toBe(0);
    expect(result.build).toBe('');
  });
}

test('an import that does not satisfy the evaluated runtime still fails', () => {
  expect(transfer('missing-runtime').importCode).not.toBe(0);
});
