import { expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * Runs the offline self-test of the container drills (scripts/check-container.py):
 * helper logic, command construction and every scenario against a simulated
 * cluster. It does not start Docker; the real drills run in the Container job.
 */
const python = Bun.which('python3');

test.skipIf(!python)(
  'container drills: offline orchestration self-test',
  async () => {
    const child = Bun.spawn(
      [
        python as string,
        '-I',
        join(import.meta.dirname, 'check-container-selftest.py'),
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const output =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    expect({ code: await child.exited, output }).toMatchObject({ code: 0 });
  },
  60_000
);
