import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readyFile, root, runtimeFile, stateDir } from './paths';
import { control } from './control';
import { availablePort, Processes } from './processes';
import { localLitestream } from './litestream';
import type { emulators as createEmulators } from './emulators';

export async function command(args: string[], cwd = root) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const code = await child.exited;
    if (code) throw new Error(`${args.join(' ')} exited with ${code}`);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function lock() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await mkdir(`${stateDir}/lock`);
  } catch {
    throw new Error(
      'A local run owns this checkout. Use bun run local:status or local:stop. If its process crashed, remove .fleet-local/lock after verifying it is stopped.'
    );
  }
}

/** One foreground supervisor owns the lock, control endpoint, and child processes. */
export async function serve(watch: boolean) {
  await lock();
  const children = new Processes();
  let session: ReturnType<typeof control> | undefined;
  let dependencies: Awaited<ReturnType<typeof createEmulators>> | undefined;
  try {
    session = control();
    process.on('SIGINT', session.stop);
    process.on('SIGTERM', session.stop);
    await rm(readyFile, { force: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        controlUrl: `http://127.0.0.1:${session.server.port}`,
        token: session.token,
      }),
      { mode: 0o600 }
    );
    const port = await availablePort();
    const binary = await localLitestream();
    dependencies = await (await import('./emulators')).emulators(port);
    await writeFile(
      readyFile,
      JSON.stringify({ url: null, dependencies: dependencies.endpoints }),
      { mode: 0o600 }
    );
    await Promise.race([
      session.stopped,
      children.launch(['src/local/start.ts'], {
        ...dependencies.env,
        FLEET_LITESTREAM_BIN: binary,
        FLEET_LOCAL_WATCH: watch ? '1' : '0',
        FLEET_LOCAL_READY_FILE: readyFile,
      }),
      ...(watch
        ? [
            children.launch(['run', 'build:css', '--watch']),
            children.launch(['run', 'build:console', '--watch']),
          ]
        : []),
    ]);
  } finally {
    try {
      await children.stop();
      await dependencies?.stop();
    } finally {
      if (session) {
        await session.server.stop(true);
        process.off('SIGINT', session.stop);
        process.off('SIGTERM', session.stop);
      }
      await rm(runtimeFile, { force: true });
      await rm(readyFile, { force: true });
      await rm(`${stateDir}/lock`, { recursive: true, force: true });
    }
  }
}
