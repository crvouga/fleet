import { controller } from './paths';

export class Processes {
  private readonly children: ReturnType<typeof Bun.spawn>[] = [];
  private stopping = false;

  launch(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: controller,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith('FLEET_') &&
              !key.startsWith('AWS_') &&
              key !== 'DATABASE_URL'
          )
        ),
        ...extra,
      },
    });
    this.children.push(child);
    return child.exited.then((code) => {
      if (!this.stopping)
        throw new Error(`${args.join(' ')} exited unexpectedly (${code})`);
    });
  }

  async stop() {
    this.stopping = true;
    for (const child of this.children) child.kill('SIGTERM');
    const force = setTimeout(() => {
      for (const child of this.children) child.kill('SIGKILL');
    }, 15000);
    await Promise.allSettled(this.children.map((child) => child.exited));
    clearTimeout(force);
  }
}

export async function availablePort() {
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  });
  const port = process.env['PORT'] ?? String(reservation.port);
  await reservation.stop(true);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('PORT must be between 1 and 65535');
  return port;
}
