import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { APP_JS } from './app-js';

const PACKAGE_ROOT = new URL('../../', import.meta.url);
const CSS_FILE = new URL('dist/app.css', PACKAGE_ROOT);

export interface Asset {
  readonly body: string;
  readonly etag: string;
}

function asset(body: string): Asset {
  return {
    body,
    etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
  };
}

let css: Asset | null = null;
let building: Promise<void> | null = null;

async function buildCss(): Promise<void> {
  const child = Bun.spawn([process.execPath, 'run', 'build:css'], {
    cwd: fileURLToPath(PACKAGE_ROOT),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await child.exited;
}

/** dist/app.css, built on first request in development when it is missing. */
export async function stylesheet(): Promise<Asset | null> {
  if (css !== null) return css;
  if (!existsSync(CSS_FILE)) {
    building ??= buildCss().finally(() => {
      building = null;
    });
    await building;
  }
  if (!existsSync(CSS_FILE)) return null;
  css = asset(await readFile(CSS_FILE, 'utf8'));
  return css;
}

export const script: Asset = asset(APP_JS);
