import { expect } from '@playwright/test';
import { Given, When, Then, required } from '../fixtures';
import { startServer } from '../process';

Given(
  'I open the real runner App setup form without reverse DNS',
  async ({ page, world }) => {
    const server = await startServer([
      process.env['PYTHON'] ?? 'python3',
      '-u',
      'bdd/setup-server.py',
    ]);
    world.cleanup.push(server.stop);
    world.setupUrl = server.url;
    await page.goto(server.url);
    world.setupManifest = JSON.parse(
      await page.locator('input[name="manifest"]').inputValue()
    );
  }
);

When('I start creating the runner App in GitHub', async ({ page, world }) => {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Create runner GitHub App' }).click();
  world.github = await popup;
  await expect(
    world.github.getByRole('heading', { name: 'Confirm access' })
  ).toBeVisible();
});

When(
  'GitHub requires me to confirm access and loses the manifest',
  async ({ world }) => {
    const github = required(world.github);
    await github
      .getByRole('button', { name: 'Confirm access', exact: true })
      .click();
    await expect(github.getByRole('heading')).toHaveText(
      "We didn't find an App Manifest for your request."
    );
  }
);

Then('the original setup form is still available', async ({ page, world }) => {
  expect(page.isClosed()).toBe(false);
  await expect(page).toHaveURL(required(world.setupUrl));
  await expect(
    page.getByRole('button', { name: 'Create runner GitHub App' })
  ).toBeVisible();
});

When('I submit the setup form again', async ({ page, world }) => {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Create runner GitHub App' }).click();
  world.github = await popup;
});

Then(
  'GitHub receives the same private runner App manifest',
  async ({ world }) => {
    const github = required(world.github);
    await expect(github.getByRole('heading')).toHaveText('Create GitHub App');
    const document = JSON.parse(
      await github.locator('#manifest').innerText()
    ) as {
      public: boolean;
      default_permissions: Record<string, string>;
      redirect_url: string;
    };
    expect(document).toEqual(required(world.setupManifest));
    expect(document.public).toBe(false);
    expect(document.default_permissions).toEqual({
      administration: 'write',
      metadata: 'read',
    });
    expect(document.redirect_url).toBe(
      new URL('/created', required(world.setupUrl)).href
    );
  }
);

When('I approve the runner App', async ({ world }) => {
  await required(world.github)
    .getByRole('button', { name: 'Create GitHub App', exact: true })
    .click();
});

Then(
  'the real setup callback confirms that the App was created',
  async ({ world }) => {
    const github = required(world.github);
    await expect(github.getByText(/The runner app was created/)).toBeVisible();
    await expect(github).toHaveURL(
      /\/created\?code=bdd-only-code&state=bdd-state$/
    );
  }
);
