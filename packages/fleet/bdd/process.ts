import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    if (process.platform === 'win32' && child.pid) {
      // A one-file PyInstaller executable has a bootloader parent and Python
      // child. Both must release their DLLs before its private temp is removed.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else child.kill('SIGTERM');
  });
}

export async function startServer(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<RunningServer> {
  const child = spawn(args[0]!, args.slice(1), {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(
        () => reject(new Error(`Test server did not start: ${stderr}`)),
        20_000
      );
      const finish = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.once('error', finish);
      child.once('exit', (code) =>
        finish(new Error(`Test server exited (${code}): ${stderr}`))
      );
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-4096);
        // Read complete lines: pipe chunks need not align with the printed URL.
        const match = stdout.match(
          /http:\/\/127\.0\.0\.1:\d+\/(?:\?t=\S+)?(?=\r?\n)/
        );
        if (match?.[0]) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
    });
    return { url, stop: () => stop(child) };
  } catch (error) {
    await stop(child);
    throw error;
  }
}
