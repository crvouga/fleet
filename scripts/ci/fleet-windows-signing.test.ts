import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '../..');
const workflow = parse(
  readFileSync(join(root, '.github/workflows/fleet-windows-sign.yml'), 'utf8')
);
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
const job = workflow.jobs.sign;

test('only a successful trusted main CI can acquire the publisher identity', () => {
  expect(workflow.on).toEqual({
    workflow_run: { workflows: ['CI'], types: ['completed'] },
  });
  for (const guard of [
    "conclusion == 'success'",
    "head_branch == 'main'",
    'head_repository.full_name == github.repository',
    "event == 'push'",
    "event == 'workflow_dispatch'",
  ])
    expect(job.if).toContain(guard);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(job.permissions['id-token']).toBe('write');
  expect(job.steps[0].with.ref).toBe(
    '${{ github.event.workflow_run.head_sha }}'
  );
  expect(job.steps[0].with['persist-credentials']).toBe(false);
  const download = job.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/download-artifact@')
  );
  expect(download.with['run-id']).toBe('${{ github.event.workflow_run.id }}');
  expect(download.with.name).toBe('wizard-windows-latest');
});

test('unsigned normal releases cannot overwrite the Windows installer', () => {
  const publish = ci.jobs.release.steps.find(
    (step: { name?: string }) =>
      step.name === 'Publish the installer and the one-file node entry'
  ).run;
  expect(publish).toContain("! -name '*.exe'");
  expect(publish).not.toContain(
    'gh release upload fleet-installer wizard-artifacts/*'
  );
  const steps = job.steps.map((step: { name?: string }) => step.name);
  expect(steps.indexOf('Verify the actual signed download')).toBeLessThan(
    steps.indexOf('Publish only a current, verified signed Windows installer')
  );
  expect(job.steps.at(-1).run).toContain(
    '[long]$existing.runId -gt [long]$env:SOURCE_RUN'
  );
  expect(job.steps.at(-1).run).toContain('if ($LASTEXITCODE -ne 0)');
});

test('signing is pinned, timestamped and has no long-lived credential input', () => {
  const signing = job.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('azure/artifact-signing-action@')
  );
  expect(signing.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(signing.with['file-digest']).toBe('SHA256');
  expect(signing.with['timestamp-digest']).toBe('SHA256');
  expect(signing.with['timestamp-rfc3161']).toBe(
    'http://timestamp.acs.microsoft.com'
  );
  expect(signing.with.files).toEndWith('fleet-installer-windows-x64.exe');
  expect(JSON.stringify(workflow)).not.toContain('client-secret');
  const config = job.steps.find(
    (step: { id?: string }) => step.id === 'config'
  );
  expect(config.run).toContain('FLEET-SIGNING-NOT-CONFIGURED');
  expect(job.env.FLEET_WINDOWS_SIGNING).toBe(
    '${{ vars.FLEET_WINDOWS_SIGNING }}'
  );
  expect(config.run).toContain('$env:FLEET_WINDOWS_SIGNING | ConvertFrom-Json');
  expect(config.run).toContain('invalid multiline configuration');
});
