import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const workflow = parse(
  readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
);
const assets = [
  'fleet-installer.iso.parts.json',
  'fleet-installer.iso.sha256',
  'fleet-installer.readiness.json',
  'fleet-installer.iso.part-000',
  'fleet-node.sh',
  'fleet-installer-windows-x64.exe',
  'fleet-installer-macos-arm64.zip',
  'fleet-installer-macos-x64.zip',
  'fleet-installer-linux-arm64.tar.gz',
  'fleet-installer-linux-x64.tar.gz',
];

function releaseMissing(names: readonly string[], exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-release-'));
  const output = join(directory, 'output');
  const step = workflow.jobs.changes.steps.find(
    (candidate: { id?: string }) => candidate.id === 'release'
  );
  try {
    writeFileSync(
      join(directory, 'gh'),
      '#!/bin/sh\nprintf "%s\\n" "$FLEET_TEST_ASSETS"\nexit "$FLEET_TEST_EXIT"\n',
      { mode: 0o700 }
    );
    const result = Bun.spawnSync(['bash', '-c', step.run], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FLEET_TEST_ASSETS: names.join('\n'),
        FLEET_TEST_EXIT: String(exitCode),
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.exitCode).toBe(0);
    return readFileSync(output, 'utf8').trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a missing release requests a full fleet rebuild on main pushes', () => {
  expect(releaseMissing([], 1)).toBe('missing=true');
  const recovery = workflow.jobs.changes.steps.find(
    (step: { id?: string }) => step.id === 'release'
  );
  expect(recovery.if).toBe("github.event_name == 'push'");
  expect(workflow.jobs.changes.outputs.fleet).toBe(
    '${{ steps.fleet_impact.outputs.fleet }}'
  );
  expect(
    workflow.jobs.changes.steps.find((step: any) => step.id === 'fleet_impact')
      .env.FLEET_AFFECTED
  ).toBe(
    "${{ steps.filter.outputs.fleet == 'true' || steps.release.outputs.missing == 'true' || github.event_name == 'workflow_dispatch' }}"
  );
  expect(workflow.jobs.release.needs).toEqual(['check', 'nix', 'installer']);
});

for (const asset of assets) {
  test(`an incomplete release retries publication when ${asset} is absent`, () => {
    expect(releaseMissing(assets.filter((name) => name !== asset))).toBe(
      'missing=true'
    );
  });
}

test('a complete release preserves the normal path filter', () => {
  expect(releaseMissing(assets)).toBe('missing=false');
});

test('all scheduler groups run concurrently before publishing the ISO', () => {
  const job = workflow.jobs.nix;
  expect(job.needs).toEqual(['changes', 'coding_tools']);
  expect(job.strategy.matrix.group).toEqual([
    'roles',
    'runtime',
    'lifecycle',
    'image',
  ]);
  expect(
    job.steps.find((step: { run?: string }) =>
      step.run?.includes('timeout 12m python3 scripts/ci-checks.py')
    ).run
  ).toContain('ci-checks.py "${check_args[@]}"');
  expect(workflow.jobs.fleet.needs).toContain('nix');
  expect(workflow.jobs.release.needs).toContain('nix');
  const upload = job.steps.find(
    (step: { uses?: string }) => step.uses === 'actions/upload-artifact@v4'
  );
  expect(upload.if).toBe(
    "matrix.group == 'image' && github.event_name != 'pull_request'"
  );
  expect(upload.with['compression-level']).toBe(0);
});

for (const event of [
  'pull_request',
  'merge_group',
  'push',
  'workflow_dispatch',
]) {
  test(`${event} gate refuses failed, cancelled, or skipped check groups`, () => {
    const step = workflow.jobs.fleet.steps[0];
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      const gate = Bun.spawnSync(['bash', '-c', step.run], {
        env: {
          ...process.env,
          RELEASE_REQUIRED: String(event !== 'pull_request'),
          FLEET: 'true',
          NIX_REQUIRED: 'true',
          INSTALLER_REQUIRED: 'true',
          RESULTS: JSON.stringify({
            check: { result: 'success' },
            nix: { result },
            installer: { result: 'success' },
            release: { result: 'success' },
          }),
        },
      });
      expect(gate.exitCode).toBe(result === 'success' ? 0 : 1);
    }
  });
}

test('the Fleet gate rejects every failed required stage and permits an unaffected change', () => {
  const run = (results: Record<string, { result: string }>, affected = true) =>
    Bun.spawnSync(['bash', '-c', workflow.jobs.fleet.steps[0].run], {
      env: {
        ...process.env,
        RESULTS: JSON.stringify(results),
        FLEET: String(affected),
        NIX_REQUIRED: String(affected),
        INSTALLER_REQUIRED: String(affected),
        RELEASE_REQUIRED: 'true',
      },
    }).exitCode;
  for (const name of ['check', 'nix', 'installer', 'release'])
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const results = Object.fromEntries(
        ['check', 'nix', 'installer', 'release'].map((key) => [
          key,
          { result: key === name ? result : 'success' },
        ])
      );
      expect(run(results)).toBe(1);
    }
  expect(
    run(
      {
        check: { result: 'success' },
        nix: { result: 'skipped' },
        installer: { result: 'skipped' },
        release: { result: 'skipped' },
      },
      false
    )
  ).toBe(0);
});

test('PR Fleet fast paths only permit explicitly unaffected build lanes to skip', () => {
  const run = (
    nix: string,
    installer: string,
    nixRequired: string,
    installerRequired: string,
    release = 'false'
  ) =>
    Bun.spawnSync(['bash', '-c', workflow.jobs.fleet.steps[0].run], {
      env: {
        ...process.env,
        FLEET: 'true',
        NIX_REQUIRED: nixRequired,
        INSTALLER_REQUIRED: installerRequired,
        RELEASE_REQUIRED: release,
        RESULTS: JSON.stringify({
          check: { result: 'success' },
          nix: { result: nix },
          installer: { result: installer },
          release: { result: 'success' },
        }),
      },
    }).exitCode;
  expect(run('skipped', 'skipped', 'false', 'false')).toBe(0);
  expect(run('success', 'skipped', 'true', 'false')).toBe(0);
  expect(run('skipped', 'success', 'true', 'true')).not.toBe(0);
  for (const result of ['failure', 'cancelled']) {
    expect(run(result, 'skipped', 'false', 'false')).not.toBe(0);
    expect(run('success', result, 'true', 'false')).not.toBe(0);
  }
  expect(run('skipped', 'skipped', '', '')).not.toBe(0);
  expect(run('success', 'success', 'false', 'false', 'true')).not.toBe(0);
});
