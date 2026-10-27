const mode = process.env['FLEET_DEV_MODE'] ?? 'managed';
if (!['managed', 'fixtures'].includes(mode))
  throw new Error('FLEET_DEV_MODE must be managed or fixtures');
const args = mode === 'fixtures'
  ? ['bun', '--watch', 'scripts/demo.ts']
  : ['bun', '--watch', 'src/server.ts'];
process.stdout.write(mode === 'fixtures'
  ? 'Fleet development: synthetic fixtures on loopback.\n'
  : 'Fleet development: caller-provided database and OIDC configuration.\n');
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
