import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from './client';
import { root } from './paths';
import { command, serve } from './runner';
import { localLitestream } from './litestream';

function doctor() {
  if (Bun.version !== '1.4.4')
    throw new Error(`Use Bun 1.4.4; found ${Bun.version}`);
  const python = Bun.spawnSync(['python3', '--version']);
  if (python.exitCode !== 0)
    throw new Error('Python 3 is required for Fleet checks');
  process.stdout.write(
    `Bun ${Bun.version}; ${python.stdout.toString().trim()}; checkout ${root}\n`
  );
}

async function main() {
  const action = process.argv[2] ?? 'run';
  if (action === 'status' || action === 'stop') {
    process.stdout.write(`${JSON.stringify(await request(action))}\n`);
    return;
  }
  if (action === 'doctor' || action === 'setup') {
    doctor();
    if (action === 'doctor') return;
    await command(['install', '--frozen-lockfile']);
    await localLitestream();
    await command(['run', 'build']);
    return;
  }
  if (action !== 'run')
    throw new Error('Use setup, run [--no-watch], status, stop, or doctor');
  if (!existsSync(join(root, 'node_modules')))
    throw new Error('Run bun run local:setup first');
  await command(['run', 'build']);
  await serve(!process.argv.includes('--no-watch'));
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Fleet local: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
