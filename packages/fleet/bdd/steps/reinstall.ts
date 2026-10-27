import { expect } from '@playwright/test';
import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, When, Then, required } from '../fixtures';
import { startMachine, operations, runNode } from '../machine';

Given(
  'I open an idle existing NixOS {string} node',
  async ({ page, world }, role: string) => {
    world.role = role;
    world.wizard = await startMachine(role);
    world.cleanup.push(world.wizard.stop);
    await page.goto(world.wizard.url);
    await expect(page.getByText(`already a`, { exact: false })).toBeVisible();
  }
);

Given('I open a NixOS CI node with an active job', async ({ page, world }) => {
  world.role = 'ci';
  world.wizard = await startMachine('ci', true);
  world.cleanup.push(world.wizard.stop);
  await page.goto(world.wizard.url);
});

When(
  'I review a hard reinstall of its current role',
  async ({ page, world }) => {
    await page.getByRole('button', { name: /Turn THIS computer/ }).click();
    await page
      .locator(`input[name="role"][value="${required(world.role)}"]`)
      .check();
    if (world.role === 'devbox') {
      const key = Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from('ssh-ed25519'),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, 7),
      ]).toString('base64');
      await page.locator('#ssh-key').fill('ssh-ed25519 ' + key);
    }
    await page.getByRole('checkbox', { name: /Hard reinstall/ }).check();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
  }
);

Then(
  'the review explicitly warns that the existing installation will be replaced',
  async ({ page }) => {
    await expect(
      page.getByText(/Hard reinstall: replace the existing installation/)
    ).toBeVisible();
    await expect(page.getByText(/BDD Internal SSD/).first()).toBeVisible();
  }
);

Then(
  'the verified installer is handed off for the same role',
  async ({ page, world }) => {
    await expect(
      page.getByRole('heading', {
        name: 'Restarting into the installer',
        exact: true,
      })
    ).toBeVisible();
    const calls = await operations(required(world.wizard).directory);
    const boot = calls.filter((call) => call.kind === 'kexec');
    expect(boot.at(-2)?.args[0]).toBe('--load');
    expect(boot.at(-2)?.args.join(' ')).toContain(
      `fleet.role=${required(world.role)}`
    );
    expect(boot.at(-1)?.args).toEqual(['-e']);
    expect(await readFile(boot.at(-2)!.args[1]!, 'utf8')).toBe(
      'kernel-bytes\n'
    );
  }
);

Then('active CI admission was closed before handing off', async ({ world }) => {
  const wizard = required(world.wizard);
  const calls = await operations(wizard.directory);
  if (world.role !== 'ci') {
    expect(calls.filter((call) => call.kind === 'runner-control')).toHaveLength(
      0
    );
    return;
  }
  expect(calls[0]?.kind).toBe('runner-control');
  expect(calls[0]?.args[0]).toBe('withdraw');
  expect(calls.find((call) => call.kind === 'kexec')?.draining).toBe(true);
  expect(await readFile(join(wizard.directory, 'busy/draining'), 'utf8')).toBe(
    'reinstall\n'
  );
});

When('I run the normal same-role install command', async ({ world }) => {
  world.command = await runNode(required(world.wizard).env, ['ci', '--yes']);
});
Then(
  'it reports the existing installation without a boot handoff',
  async ({ world }) => {
    expect(required(world.command).code).toBe(0);
    expect(required(world.command).text).toContain('already installed as ci');
    expect(await operations(required(world.wizard).directory)).toEqual([]);
  }
);

When(
  'I explicitly confirm a same-role CLI hard reinstall',
  async ({ world }) => {
    world.command = await runNode(required(world.wizard).env, [
      'ci',
      '--reinstall',
      '--yes',
    ]);
  }
);
Then('the CLI hands off to the verified installer', async ({ world }) => {
  expect(required(world.command).code).toBe(0);
  expect(required(world.command).text).toContain('Hard reinstall requested');
  const calls = await operations(required(world.wizard).directory);
  expect(calls.at(-1)?.args).toEqual(['-e']);
});

When('I preview a same-role CLI hard reinstall', async ({ world }) => {
  world.command = await runNode(required(world.wizard).env, [
    'ci',
    '--reinstall',
    '--plan',
  ]);
});
Then(
  'the plan names the disk and no boot handoff occurs',
  async ({ world }) => {
    expect(required(world.command).code).toBe(0);
    expect(required(world.command).text).toContain('BDD Internal SSD');
    expect(required(world.command).text).toContain('only the plan');
    expect(await operations(required(world.wizard).directory)).toEqual([]);
  }
);

Then('the review refuses to interrupt the running job', async ({ page }) => {
  await expect(page.getByText('this CI node is running a job')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Erase and install' })
  ).toHaveCount(0);
});
Then('no boot handoff or runner withdrawal occurred', async ({ world }) => {
  expect(await operations(required(world.wizard).directory)).toEqual([]);
});

When('the simulated internal disk changes identity', async ({ world }) => {
  const path = join(required(world.wizard).directory, 'disks.json');
  const disks = JSON.parse(await readFile(path, 'utf8')) as {
    serial: string;
  }[];
  disks[0]!.serial = 'ANOTHER-DISK';
  await writeFile(path, JSON.stringify(disks));
});
Then('the wizard refuses the changed internal disk', async ({ page }) => {
  await expect(
    page.getByRole('heading', { name: 'It did not finish' })
  ).toBeVisible();
  await expect(
    page.locator('p.fail').filter({ hasText: /not the one that was chosen/ })
  ).toBeVisible();
});

When('I arrange for the boot handoff to fail', async ({ world }) => {
  await writeFile(
    join(required(world.wizard).directory, 'fail-boot'),
    'fail\n'
  );
});
Then(
  'the failed handoff restores the CI node and exposes copyable diagnostics',
  async ({ page, world }) => {
    await expect(
      page.getByRole('heading', { name: 'It did not finish' })
    ).toBeVisible();
    await expect(
      access(join(required(world.wizard).directory, 'state/withdrawn'))
    ).rejects.toThrow();
    await expect(
      access(join(required(world.wizard).directory, 'busy/draining'))
    ).rejects.toThrow();
    await page
      .getByText('Error details for support or an LLM', { exact: true })
      .click();
    await expect(page.locator('#diagnostic-report')).toHaveValue(
      /Fleet installer diagnostic/
    );
    await expect(
      page.getByRole('button', { name: 'Copy diagnostic report', exact: true })
    ).toBeVisible();
    await expect(page.locator('#diagnostic-report')).toHaveValue(/## System/);
    await expect(
      page.getByRole('button', { name: 'Report on GitHub', exact: true })
    ).toBeVisible();
    await expect(page.getByText('What to do:')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  }
);
When(
  'I restore the boot handoff and retry the hard reinstall',
  async ({ page, world }) => {
    await unlink(join(required(world.wizard).directory, 'fail-boot'));
    // Try again reviews the same choices, so the hard reinstall is not re-entered.
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(/Hard reinstall: replace/)).toBeVisible();
    await page.locator('#ack').check();
    await page.getByRole('button', { name: 'Erase and install' }).click();
  }
);
Then(
  'the CI runner was withdrawn once per actual attempt',
  async ({ world }) => {
    expect(
      (await operations(required(world.wizard).directory)).filter(
        (call) => call.kind === 'runner-control'
      )
    ).toHaveLength(2);
  }
);
