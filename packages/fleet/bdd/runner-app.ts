import { execFile } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

export async function runnerConfig() {
  const config = JSON.parse(await readFile('settings/github.json', 'utf8')) as {
    appId: string;
    installationId: string;
    repositories: string[];
  };
  if (!/^\d+$/.test(config.appId) || !/^\d+$/.test(config.installationId)) {
    throw new Error(
      'Finish the GitHub runner App setup before running its live scenario'
    );
  }
  return config;
}

async function privateKey(): Promise<string> {
  let ageKey = process.env['SOPS_AGE_KEY'];
  if (!ageKey) {
    const inputs = JSON.parse(
      await readFile(
        '../infra/tofu/vault/fleet-age-keys.auto.tfvars.json',
        'utf8'
      )
    ) as {
      fleet_age_keys: { ci: string };
    };
    ageKey = inputs.fleet_age_keys.ci;
  }
  try {
    const result = await promisify(execFile)(
      'sops',
      ['--decrypt', '--output-type', 'json', 'secrets/fleet.yaml'],
      {
        env: { ...process.env, SOPS_AGE_KEY: ageKey },
      }
    );
    return (JSON.parse(result.stdout) as Record<string, string>)[
      'github-app-key'
    ]!;
  } catch {
    throw new Error(
      'Could not decrypt the configured runner App key; no credentials were recorded'
    );
  }
}

export async function github(path: string, token: string, method = 'GET') {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fleet-bdd',
    },
    signal: AbortSignal.timeout(30_000),
  });
}

export async function installationToken(): Promise<string> {
  const config = await runnerConfig();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: config.appId })}`;
  const signature = createSign('RSA-SHA256')
    .update(payload)
    .sign(await privateKey(), 'base64url');
  const response = await github(
    `/app/installations/${config.installationId}/access_tokens`,
    `${payload}.${signature}`,
    'POST'
  );
  if (response.status !== 201)
    throw new Error(
      `GitHub App authentication returned HTTP ${response.status}`
    );
  return ((await response.json()) as { token: string }).token;
}
