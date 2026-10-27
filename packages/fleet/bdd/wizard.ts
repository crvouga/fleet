import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from './process';

export interface WizardOptions {
  image?: Buffer;
  os?: string;
  arch?: string;
  prepare?: (directory: string) => Promise<NodeJS.ProcessEnv>;
}

async function usbDisks(directory: string) {
  // Windows device leases use global named mutexes. Separate fixture files
  // represent separate devices, even when scenarios run on the same host.
  const identity = createHash('sha256').update(directory).digest('hex');
  await writeFile(
    join(directory, 'disks.json'),
    JSON.stringify([
      {
        path: `/dev/fleet-bdd-${identity}`,
        tran: 'usb',
        rm: true,
        hotplug: true,
        usb: true,
        internal: false,
        mounted: false,
        whole: true,
        size: 8e9,
        model: 'BDD Test USB',
        serial: `BDD-${identity}`,
      },
    ])
  );
}

export async function startWizard(
  available: boolean,
  options: WizardOptions = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-bdd-'));
  const image = options.image ?? Buffer.alloc(96 * 1024, 7);
  if (!options.image) image.write('CD001', 32769, 'latin1');
  await mkdir(join(directory, 'release'));
  const iso = join(directory, 'release/image.iso');
  await writeFile(iso, image);
  await writeFile(
    `${iso}.sha256`,
    createHash('sha256').update(image).digest('hex') + '  image.iso\n'
  );
  const disk = join(directory, 'usb.img');
  const original = Buffer.alloc(image.length + 4096, 0xee);
  await writeFile(disk, original);
  await usbDisks(directory);
  const extra = await options.prepare?.(directory);
  const env: NodeJS.ProcessEnv = {
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    FLEET_STATE: join(directory, 'state'),
    FLEET_CACHE: join(directory, 'cache'),
    FLEET_ELEVATE: 'none',
    FLEET_ARCH: options.arch ?? 'x86_64',
    ...(options.os ? { FLEET_OS: options.os } : {}),
    FLEET_INSTALLER_URL: pathToFileURL(
      available ? iso : join(directory, 'missing.iso')
    ).href,
    FLEET_INSTALLER_SHA256_URL: pathToFileURL(`${iso}.sha256`).href,
    FLEET_DISKS_FILE: join(directory, 'disks.json'),
    FLEET_WRITE_TARGET: disk,
    FLEET_NODE_CONF: join(directory, 'none.conf'),
    PYTHONIOENCODING: 'utf-8',
    ...extra,
  };
  const server = await startServer(
    process.env['FLEET_BDD_WIZARD']
      ? [process.env['FLEET_BDD_WIZARD'], '--no-browser']
      : [
          process.env['PYTHON'] ?? 'python3',
          '-u',
          'wizard/main.py',
          '--no-browser',
        ],
    env
  );
  return {
    ...server,
    directory,
    env,
    image,
    disk,
    original,
    stop: async () => {
      await server.stop();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    },
  };
}

export type Wizard = Awaited<ReturnType<typeof startWizard>>;
