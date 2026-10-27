import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startWizard } from './wizard';

const run = promisify(execFile);

async function controls(directory: string): Promise<void> {
  const script = `#!/usr/bin/env python3
import json, sys
from pathlib import Path
root = Path(__file__).parent
kind = Path(__file__).name
args = sys.argv[1:]
assert kind in ('kexec', 'runner-control', 'fleet-resume')
assert kind == 'fleet-resume' or args[0] in ('--load', '-e', 'withdraw', 'hold')
with (root / 'events.jsonl').open('a') as stream:
    stream.write(json.dumps({'kind': kind, 'args': args, 'draining': (root / 'busy/draining').exists()}) + '\\n')
if kind == 'kexec' and '-e' in args and (root / 'fail-boot').exists():
    sys.exit(7)
if kind == 'fleet-resume':
    (root / 'busy/draining').unlink(missing_ok=True)
`;
  for (const name of ['kexec', 'runner-control', 'fleet-resume'])
    await writeFile(join(directory, name), script, { mode: 0o700 });
}

async function configure(
  directory: string,
  role: string,
  busy: boolean
): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(directory, 'state'));
  await mkdir(join(directory, 'busy', 'slot-1'), { recursive: true });
  await writeFile(
    join(directory, 'state/installed'),
    `role=${role}\nstatus=installed\n`
  );
  await writeFile(join(directory, 'node.conf'), `role=${role}\n`);
  await writeFile(
    join(directory, 'runner.conf'),
    'scope=repository\napp_id=123\ninstallation_id=456\ntarget=example/private\n'
  );
  await writeFile(join(directory, 'credential'), 'bdd-only-not-a-key', {
    mode: 0o600,
  });
  await writeFile(
    join(directory, 'disks.json'),
    JSON.stringify([
      {
        path: '/dev/nvme0n1',
        tran: 'nvme',
        rm: false,
        hotplug: false,
        usb: false,
        internal: true,
        mounted: true,
        whole: true,
        size: 500e9,
        model: 'BDD Internal SSD',
        serial: 'BDD-INTERNAL',
      },
    ])
  );
  if (busy) await writeFile(join(directory, 'busy/slot-1/busy'), 'running\n');
  await controls(directory);
  return {
    FLEET_NODE_CONF: join(directory, 'node.conf'),
    FLEET_RUNNER_CONF: join(directory, 'runner.conf'),
    FLEET_CREDENTIAL: join(directory, 'credential'),
    FLEET_RUNNER_CONTROL: join(directory, 'runner-control'),
    FLEET_RESUME: join(directory, 'fleet-resume'),
    FLEET_BUSY_DIR: join(directory, 'busy'),
    FLEET_HOSTNAME: 'ci-bdd0',
    FLEET_KEXEC: join(directory, 'kexec'),
    FLEET_EUID: '0',
    FLEET_EFI_DIR: directory,
    FLEET_ISO_FS: 'ext4',
    FLEET_NO_ENROLL: '1',
    FLEET_ENROLL_TOKEN: '',
    FLEET_ENROLL_TOKEN_FILE: '',
  };
}

export async function startMachine(role = 'ci', busy = false) {
  const result = await run(process.env['PYTHON'] ?? 'python3', [
    '-c',
    'import sys,base64; sys.path.insert(0,"tests"); import iso_fixture; print(base64.b64encode(iso_fixture.build(iso_fixture.installer_tree())).decode())',
  ]);
  return startWizard(true, {
    image: Buffer.from(result.stdout.trim(), 'base64'),
    os: 'Linux',
    prepare: (directory) => configure(directory, role, busy),
  });
}

export interface Operation {
  kind: string;
  args: string[];
  draining: boolean;
}

export async function operations(directory: string): Promise<Operation[]> {
  const text = await readFile(join(directory, 'events.jsonl'), 'utf8').catch(
    (error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return '';
      throw error;
    }
  );
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row) => JSON.parse(row) as Operation);
}

export async function runNode(env: NodeJS.ProcessEnv, args: string[]) {
  try {
    const result = await run('bash', ['scripts/fleet-node.sh', ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { code: 0, text: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, text: result.stdout + result.stderr };
  }
}
