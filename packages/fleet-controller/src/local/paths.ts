import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../../../', import.meta.url));
export const controller = join(root, 'packages/fleet-controller');
export const stateDir = resolve(
  process.env['FLEET_LOCAL_STATE_DIR'] ?? join(root, '.fleet-local')
);
export const runtimeFile = join(stateDir, 'runtime.json');
export const readyFile = join(stateDir, 'dashboard.json');
export interface Runtime {
  controlUrl: string;
  token: string;
}

export function loopback(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password
  )
    throw new Error('Local runtime URLs must use http://127.0.0.1');
  return url;
}
