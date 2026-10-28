import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Context, Hono } from 'hono';
import type { AppDeps } from '../../deps';
import { INSTALLERS } from '../lib/installers';

const binaryNames = new Set(INSTALLERS.map((item) => item.file as string));
export function installerAsset(name: string): boolean {
  return (
    binaryNames.has(name) ||
    /^fleet-installer\.iso(?:\.sha256|\.parts\.json|\.part-\d{3})?$/.test(
      name
    ) ||
    name === 'fleet-installer.readiness.json' ||
    (name.endsWith('.sha256') && binaryNames.has(name.slice(0, -7)))
  );
}

async function assetPath(
  directory: string,
  name: string
): Promise<string | null> {
  try {
    const base = await realpath(directory);
    const path = await realpath(join(base, name));
    if (!path.startsWith(base + sep) || !(await stat(path)).isFile())
      return null;
    return path;
  } catch {
    return null;
  }
}

function artifactFile(path: string) {
  return Bun.file(
    path,
    path.endsWith('.sha256') ? { type: 'text/plain; charset=utf-8' } : {}
  );
}

function fileResponse(c: Context, path: string) {
  const file = artifactFile(path);
  const range = c.req.header('range');
  if (!range)
    return new Response(file, { headers: { 'Accept-Ranges': 'bytes' } });
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = Number(match?.[1]);
  const end = match?.[2] ? Number(match[2]) : file.size - 1;
  if (!match || start > end || end >= file.size || !Number.isSafeInteger(end))
    return c.body(null, 416, { 'Content-Range': `bytes */${file.size}` });
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
    },
  });
}

/** Published images are public read-only artifacts, independent of browser sessions. */
export function registerInstallerAssets(app: Hono, deps: AppDeps) {
  app.on(['GET', 'HEAD'], '/installers/assets/:file', async (c) => {
    const name = c.req.param('file');
    if (name === 'fleet-node.sh')
      return new Response(
        Bun.file(
          new URL('../../../../fleet/scripts/fleet-node.sh', import.meta.url)
        )
      );
    if (!installerAsset(name)) return c.notFound();
    if (!deps.env.installerDir)
      return c.text(
        'No installer has been published for this Fleet app. Ask its administrator to publish the built image and checksums.',
        503
      );
    const path = await assetPath(deps.env.installerDir, name);
    if (!path) return c.notFound();
    c.header('Cache-Control', 'no-cache');
    return fileResponse(c, path);
  });
}
