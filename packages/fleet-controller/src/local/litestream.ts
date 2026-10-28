import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './paths';
import { LITESTREAM_VERSION } from '../preflight';

const artifacts: Record<string, { platform: string; sha256: string }> = {
  'darwin-arm64': {
    platform: 'darwin-arm64',
    sha256: 'e211f68ff7658d19f193f2914417afdf8f89a053ff8f263e5d6b3b1d3bbc7b08',
  },
  'darwin-x64': {
    platform: 'darwin-x86_64',
    sha256: '891875af09db152e93a4b31a8a79f538ce7ce702c132803cfe0a831e7cb1b7db',
  },
  'linux-arm64': {
    platform: 'linux-arm64',
    sha256: 'f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5',
  },
  'linux-x64': {
    platform: 'linux-x86_64',
    sha256: 'cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d',
  },
};

async function download(directory: string, platform: string, checksum: string) {
  const response = await fetch(
    `https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-${platform}.tar.gz`,
    { signal: AbortSignal.timeout(60_000) }
  );
  if (!response.ok)
    throw new Error(`Litestream download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksum)
    throw new Error('Litestream archive checksum mismatch');
  const archive = join(directory, 'litestream.tar.gz');
  await Bun.write(archive, bytes);
  const extract = Bun.spawn(
    ['tar', '-xzf', archive, '-C', directory, 'litestream'],
    { stdout: 'ignore', stderr: 'inherit' }
  );
  if (await extract.exited) throw new Error('Unable to extract Litestream');
  await chmod(join(directory, 'litestream'), 0o700);
}

/** A pinned, checksum-verified development tool, cached only inside this checkout. */
export async function localLitestream() {
  if (process.env['FLEET_LITESTREAM_BIN'])
    return process.env['FLEET_LITESTREAM_BIN'];
  const installed = Bun.which('litestream');
  if (installed) return installed;
  const artifact = artifacts[`${process.platform}-${process.arch}`];
  if (!artifact)
    throw new Error(
      'Install Litestream 0.5.17 and set FLEET_LITESTREAM_BIN for this platform'
    );
  const directory = join(root, '.fleet-local', 'tools', LITESTREAM_VERSION);
  const binary = join(directory, 'litestream');
  if (await Bun.file(binary).exists()) return binary;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, 'download-'));
  try {
    process.stdout.write(
      `Downloading verified Litestream ${LITESTREAM_VERSION} for local replication.\n`
    );
    await download(temporary, artifact.platform, artifact.sha256);
    await rename(join(temporary, 'litestream'), binary);
    return binary;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
