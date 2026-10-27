import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(
    join(import.meta.dirname, '../../.github/workflows/ci.yml'),
    'utf8'
  )
);
const jobs = workflow.jobs;
const successful = {
  check: { result: 'success', outputs: { fleet: 'true' } },
  nix: { result: 'success' },
  installer: { result: 'success' },
};

function releaseSelected(
  needs = successful,
  event = 'push',
  ref = 'refs/heads/main',
  cancelled = false,
  ancestorResults = ['success', 'skipped']
) {
  // This condition uses only JS-compatible comparisons and logical operators.
  // Model GitHub's implicit success() check, including skipped ancestors.
  const condition: string = jobs.release.if.replace("vars.FLEET_PUBLISH_RELEASES == 'enabled' && (", "(");
  if (
    !/\b(always|cancelled|failure|success)\s*\(/.test(condition) &&
    !ancestorResults.every((result) => result === 'success')
  )
    return false;
  return Boolean(
    new Function('needs', 'github', 'cancelled', `return (${condition});`)(
      needs,
      { event_name: event, ref },
      () => cancelled
    )
  );
}

test('release runs after successful direct dependencies even when optional ancestors skipped', () => {
  expect(new Set(jobs.release.needs)).toEqual(new Set(Object.keys(successful)));
  expect(releaseSelected()).toBe(true);
  expect(releaseSelected(successful, 'workflow_dispatch')).toBe(true);
  expect(
    releaseSelected(
      successful,
      'merge_group',
      'refs/heads/gh-readonly-queue/main/pr-1'
    )
  ).toBe(true);
});

test('release still rejects unsuccessful checks, builds, cancellation and untrusted refs', () => {
  for (const job of Object.keys(successful)) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      expect(
        releaseSelected({
          ...successful,
          [job]: { ...successful[job as keyof typeof successful], result },
        })
      ).toBe(false);
    }
  }
  for (const fleet of ['false', ''])
    expect(
      releaseSelected({
        ...successful,
        check: { result: 'success', outputs: { fleet } },
      })
    ).toBe(false);
  expect(releaseSelected(successful, 'push', 'refs/heads/main', true)).toBe(
    false
  );
  expect(releaseSelected(successful, 'pull_request')).toBe(false);
  expect(releaseSelected(successful, 'push', 'refs/heads/feature')).toBe(false);
  expect(
    releaseSelected(successful, 'workflow_dispatch', 'refs/heads/feature')
  ).toBe(false);
});
