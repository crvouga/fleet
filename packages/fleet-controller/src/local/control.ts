import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readyFile } from './paths';

function authorized(request: Request, token: string) {
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function dashboard() {
  try {
    return JSON.parse(await readFile(readyFile, 'utf8')) as { url: string };
  } catch {
    return { url: null };
  }
}

export function control() {
  const token = randomBytes(32).toString('hex');
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => finish();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!authorized(request, token))
        return new Response('Forbidden', { status: 403 });
      const path = new URL(request.url).pathname;
      if (path === '/__fleet_local/status' && request.method === 'GET')
        return Response.json({
          running: true,
          mode: 'emulated',
          ...(await dashboard()),
        });
      if (path === '/__fleet_local/stop' && request.method === 'POST') {
        stop();
        return Response.json({ running: false });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  return { token, server, stopped, stop };
}
