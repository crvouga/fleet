const mode = process.env['FLEET_DEV_MODE'] ?? 'emulated';
if (!['managed', 'fixtures', 'emulated'].includes(mode))
  throw new Error('FLEET_DEV_MODE must be emulated, managed or fixtures');
const args =
  mode === 'fixtures'
    ? ['bun', '--watch', 'scripts/demo.ts']
    : mode === 'managed'
      ? ['bun', 'src/start.ts']
      : ['bun', 'src/local/cli.ts', 'run'];
process.stdout.write(
  mode === 'fixtures'
    ? 'Fleet development: synthetic fixtures on loopback.\n'
    : mode === 'managed'
      ? 'Fleet development: caller-provided database and OIDC configuration.\n'
      : 'Fleet development: real SQLite and Mockingbird dependency emulators.\n'
);
const child = Bun.spawn(args, {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGINT');
  });
const code = await child.exited;
process.exitCode = stopping ? 0 : code;
export {};
