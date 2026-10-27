import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, Then } from '../fixtures';
import { startWizard } from '../wizard';

const internal = {
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
};

Given(
  'I open the wizard on {string} with {string} hardware',
  async ({ page, world }, os: string, arch: string) => {
    world.wizard = await startWizard(true, {
      os,
      arch,
      prepare: async (directory) => {
        await writeFile(
          join(directory, 'disks.json'),
          JSON.stringify([internal])
        );
        return { FLEET_KEXEC: process.env['PYTHON'] ?? 'python3' };
      },
    });
    world.cleanup.push(world.wizard.stop);
    await page.goto(world.wizard.url);
  }
);

Given('I open the wizard with two internal disks', async ({ page, world }) => {
  world.wizard = await startWizard(true, {
    os: 'Linux',
    prepare: async (directory) => {
      await writeFile(
        join(directory, 'disks.json'),
        JSON.stringify([
          internal,
          { ...internal, path: '/dev/nvme1n1', serial: 'SECOND' },
        ])
      );
      return { FLEET_KEXEC: process.env['PYTHON'] ?? 'python3' };
    },
  });
  world.cleanup.push(world.wizard.stop);
  await page.goto(world.wizard.url);
});

Then(
  'in-place installation is {string}',
  async ({ page }, availability: string) => {
    const button = page.getByRole('button', { name: /Turn THIS computer/ });
    if (availability === 'available') await expect(button).toBeEnabled();
    else {
      await expect(button).toBeDisabled();
      await expect(page.getByText(/Not possible from here/)).toBeVisible();
    }
  }
);

Then('making installation media remains available', async ({ page }) => {
  await expect(
    page.getByRole('button', { name: /Make an install USB/ })
  ).toBeEnabled();
});
