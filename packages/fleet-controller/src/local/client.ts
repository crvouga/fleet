import { readFile } from 'node:fs/promises';
import { loopback, runtimeFile, type Runtime } from './paths';

export async function runtime(): Promise<Runtime | null> {
  try {
    const value = JSON.parse(await readFile(runtimeFile, 'utf8')) as Runtime;
    loopback(value.controlUrl);
    if (!/^[a-f0-9]{64}$/.test(value.token))
      throw new Error('Invalid local runtime token');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForStop(token: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if ((await runtime())?.token !== token) return;
    await Bun.sleep(100);
  }
  throw new Error('Local cleanup did not finish within 25 seconds');
}

export async function request(action: 'status' | 'stop') {
  const current = await runtime();
  if (!current) return { running: false };
  const response = await fetch(
    new URL(`/__fleet_local/${action}`, current.controlUrl),
    {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${current.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    }
  );
  if (!response.ok)
    throw new Error(`Local runtime refused ${action}: ${response.status}`);
  const result = (await response.json()) as {
    running: boolean;
    url?: string | null;
    mode?: string;
  };
  if (action === 'stop') await waitForStop(current.token);
  return result;
}
