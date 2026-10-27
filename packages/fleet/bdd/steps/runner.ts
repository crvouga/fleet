import { expect } from '@playwright/test';
import { Given, When, Then, required } from '../fixtures';
import { github, installationToken, runnerConfig } from '../runner-app';

Given(
  'the configured runner App is installed on its private repository',
  async ({ world }) => {
    world.installationToken = await installationToken();
    const config = await runnerConfig();
    expect(config.repositories).toHaveLength(1);
    const response = await github(
      `/repos/${required(config.repositories[0])}`,
      world.installationToken
    );
    expect(response.status).toBe(200);
    const repository = (await response.json()) as { private: boolean };
    expect(repository.private).toBe(true);
  }
);

When('it requests a runner registration token', async ({ world }) => {
  const config = await runnerConfig();
  const response = await github(
    `/repos/${required(config.repositories[0])}/actions/runners/registration-token`,
    required(world.installationToken),
    'POST'
  );
  world.registrationStatus = response.status;
  // Never attach, trace or log either token, including assertion failure values.
  const body = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };
  expect(typeof body.token).toBe('string');
  expect(Date.parse(body.expires_at ?? '')).toBeGreaterThan(Date.now());
});

Then(
  'GitHub authorizes runner registration without exposing the token',
  async ({ world }) => {
    expect(world.registrationStatus).toBe(201);
    const config = await runnerConfig();
    await world.info.attach('runner-registration-proof', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          appId: config.appId,
          installationId: config.installationId,
          repositories: config.repositories,
          status: 201,
        },
        null,
        2
      ),
    });
  }
);
