import { join } from 'node:path';
import { start } from '../start';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const worker = [
  process.execPath,
  ...(process.env['FLEET_LOCAL_WATCH'] === '1' ? ['--watch'] : []),
  join(import.meta.dir, 'worker.ts'),
];
await start(false, worker.map(quote).join(' '));
