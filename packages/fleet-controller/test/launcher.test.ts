import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fake = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const command = process.argv[2];
appendFileSync(process.env.FLEET_TEST_INVOCATIONS, command + '\\n');
if (command === 'version') { console.log(process.env.FLEET_TEST_VERSION ?? '0.5.17'); process.exit(0); }
if (command === 'replicate' && process.argv.includes('-once')) process.exit(Number(process.env.FLEET_TEST_WRITE_EXIT ?? 0));
if (command === 'restore' && process.env.FLEET_TEST_HANG_RESTORE) {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (command === 'restore') process.exit(Number(process.env.FLEET_TEST_RESTORE_EXIT ?? 0));
process.exit(Number(process.env.FLEET_TEST_WORKER_EXIT ?? 27));
`;

async function launch(
  overrides: Record<string, string>,
  entry = 'src/start.ts',
  extraArgs: string[] = []
) {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-launcher-'));
  const binary = join(directory, 'litestream');
  writeFileSync(binary, fake, { mode: 0o700 });
  const calls = join(directory, 'calls');
  const path = join(directory, 'fleet.db');
  const child = Bun.spawn([process.execPath, entry, ...extraArgs], {
    cwd: join(import.meta.dir, '..'),
    env: {
      PATH: process.env['PATH'] ?? '',
      FLEET_ADMIN_TOKEN: 'a'.repeat(32),
      AWS_ACCESS_KEY_ID: 'private-key-id',
      AWS_SECRET_ACCESS_KEY: 'private-secret',
      FLEET_S3_BUCKET: 'test-bucket',
      FLEET_DATABASE_PATH: path,
      FLEET_LITESTREAM_BIN: binary,
      FLEET_TEST_INVOCATIONS: calls,
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const code = await child.exited;
    const output =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    expect(output).not.toContain('private-secret');
    expect(output).not.toContain('private-key-id');
    return {
      code,
      output,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      databaseCreated: existsSync(path),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('restore failure aborts startup before opening a database or starting replication', async () => {
  const result = await launch({ FLEET_TEST_RESTORE_EXIT: '1' });
  expect(result).toMatchObject({
    code: 1,
    calls: 'version\nrestore\n',
    databaseCreated: false,
  });
  expect(result.output).toContain('Litestream restore failed');
  expect(result.output).toContain('List/Get permissions');
});

test('a failed replication process fails the deployment instead of falling back to an unreplicated controller', async () => {
  expect(await launch({})).toMatchObject({
    code: 27,
    calls: 'version\nrestore\nreplicate\nreplicate\n',
    databaseCreated: true,
  });
});

test('missing default credentials are requested before invoking Litestream', async () => {
  const result = await launch({ AWS_SECRET_ACCESS_KEY: '' });
  expect(result).toMatchObject({ code: 1, calls: '', databaseCreated: false });
  expect(result.output).toContain('AWS_SECRET_ACCESS_KEY is required');
});

test('the controller worker entry point refuses default mode rather than running without replication', async () => {
  const result = await launch({}, 'src/controller.ts');
  expect(result).toMatchObject({ code: 1, calls: '', databaseCreated: false });
  expect(result.output).toContain('use bun run start');
});

test('unsupported Litestream version fails before restore', async () => {
  const result = await launch({ FLEET_TEST_VERSION: '0.3.13' });
  expect(result).toMatchObject({
    code: 1,
    calls: 'version\n',
    databaseCreated: false,
  });
  expect(result.output).toContain('Install the supported version 0.5.17');
});

test('missing executable identifies the setting to fix', async () => {
  const result = await launch({ FLEET_LITESTREAM_BIN: '/does/not/exist' });
  expect(result.code).toBe(1);
  expect(result.output).toContain('FLEET_LITESTREAM_BIN');
  expect(result.output).toContain('Litestream is missing or not executable');
});

test('unwritable database path fails with a filesystem remedy before restore', async () => {
  const result = await launch({ FLEET_DATABASE_PATH: '/dev/null/fleet.db' });
  expect(result).toMatchObject({ code: 1, calls: '', databaseCreated: false });
  expect(result.output).toContain('ownership for the service user');
});

test('failed initial S3 write refuses HTTP startup, retains the database and explains bucket permissions', async () => {
  const result = await launch({ FLEET_TEST_WRITE_EXIT: '1' });
  expect(result).toMatchObject({
    code: 1,
    calls: 'version\nrestore\nreplicate\n',
    databaseCreated: true,
  });
  expect(result.output).toContain('List/Get/Put/Delete permissions');
  expect(result.output).toContain(
    'The Fleet controller did not start listening'
  );
});

test('check:config validates local prerequisites without restoring, syncing or creating a database', async () => {
  const result = await launch({}, 'src/start.ts', ['--check']);
  expect(result).toMatchObject({
    code: 0,
    calls: 'version\n',
    databaseCreated: false,
  });
  expect(result.output).toContain('S3 access is verified during startup');
});

test('a stalled restore is bounded and cannot become a false success on shutdown', async () => {
  const result = await launch({
    FLEET_TEST_HANG_RESTORE: '1',
    FLEET_STARTUP_TIMEOUT_SECONDS: '1',
  });
  expect(result).toMatchObject({
    code: 1,
    calls: 'version\nrestore\n',
    databaseCreated: false,
  });
  expect(result.output).toContain('FLEET_STARTUP_TIMEOUT_SECONDS');
  expect(result.output).toContain(
    'The Fleet controller did not start listening'
  );
});

test('an unexpected clean worker exit is a deployment failure with a remedy', async () => {
  const result = await launch({ FLEET_TEST_WORKER_EXIT: '0' });
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    'Fleet controller or Litestream exited unsuccessfully'
  );
  expect(result.output).toContain('before restarting');
});
