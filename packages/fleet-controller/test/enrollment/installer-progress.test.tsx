/** @jsxImportSource react */
import { describe, expect, test } from 'bun:test';
import { MantineProvider } from '@mantine/core';
import { renderToStaticMarkup } from 'react-dom/server';

import { InstallerProgressPanel } from '../../src/console/installer-progress';
import type { ConsoleState } from '../../src/console/model';
import { installerProgress } from '../../src/enrollment/installer-progress';
import { loadFleet } from '../../src/ui/lib/fleet-data';
import { nodeRow } from '../../src/testing/fixtures';
import { setup } from '../ui/helpers';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

function view(
  issue: string | null,
  options: { phase?: 'blocked' | 'progressing'; seen?: Date | null } = {}
) {
  return {
    approval: 'approved' as const,
    lastSeenAt: options.seen === undefined ? minutesAgo(1) : options.seen,
    reconcile:
      issue === null
        ? null
        : { phase: options.phase ?? 'progressing', issues: [issue] },
    reconcileIssues: issue === null ? [] : [issue],
  };
}

describe('installer progress from the node report', () => {
  test('reads the phase, the message and where it is in the six steps', () => {
    const progress = installerProgress(
      view('FLEET_INSTALLING: phase=install nixos-install of /nix/store/x'),
      NOW
    );
    expect(progress).toMatchObject({
      code: 'FLEET_INSTALLING',
      phase: 'install',
      step: 6,
      failed: false,
      stale: false,
      nothingErased: false,
      nextStep: null,
      message: 'nixos-install of /nix/store/x',
    });
  });

  test('nothing is erased before the erase step', () => {
    for (const phase of ['network', 'approval', 'checks', 'disk'])
      expect(
        installerProgress(view(`FLEET_INSTALLING: phase=${phase} x`), NOW)
          ?.nothingErased
      ).toBe(true);
    expect(
      installerProgress(view('FLEET_INSTALLING: phase=erase x'), NOW)
        ?.nothingErased
    ).toBe(false);
  });

  test('a failure carries an actionable next step per code', () => {
    const cases: readonly [string, RegExp][] = [
      ['FLEET_API_UNAVAILABLE', /cannot reach this controller/],
      ['FLEET_ENROLLMENT_EXPIRED', /new installer binding/],
      ['FLEET_ENROLLMENT_REVOKED', /new installer binding/],
      ['FLEET_ENROLLMENT_REJECTED', /enrollment token/],
      ['FLEET_APPROVAL_REQUIRED', /Pending/],
      ['FLEET_HARDWARE_UNSUPPORTED', /not supported and nothing was erased/],
      ['FLEET_CACHE_UNAVAILABLE', /update cache/],
      ['FLEET_PLATFORM_NOT_READY', /administrator/],
      ['FLEET_INSTALL_FAILED', /fleet-status/],
      ['FLEET_SOMETHING_NEW', /Report it/],
    ];
    for (const [code, step] of cases) {
      const progress = installerProgress(
        view(`${code}: phase=checks it broke`, { phase: 'blocked' }),
        NOW
      );
      expect([code, progress?.failed]).toEqual([code, true]);
      expect([code, progress?.nextStep]).toEqual([
        code,
        expect.stringMatching(step),
      ]);
    }
  });

  test('silence is flagged, but a failure is not also called stale', () => {
    const quiet = installerProgress(
      view('FLEET_INSTALLING: phase=disk x', { seen: minutesAgo(11) }),
      NOW
    );
    expect(quiet).toMatchObject({ stale: true, minutesSilent: 11 });
    expect(quiet?.nextStep).toContain('No report for 11 minutes');
    expect(
      installerProgress(
        view('FLEET_INSTALLING: phase=disk x', { seen: minutesAgo(9) }),
        NOW
      )?.stale
    ).toBe(false);
    expect(
      installerProgress(
        view('FLEET_INSTALLING: phase=disk x', { seen: minutesAgo(9) }),
        NOW,
        5
      )?.stale
    ).toBe(true);
    const failed = installerProgress(
      view('FLEET_INSTALL_FAILED: phase=erase x', {
        phase: 'blocked',
        seen: minutesAgo(60),
      }),
      NOW
    );
    expect(failed).toMatchObject({ failed: true, stale: false });
  });

  test('an installed node and untagged reports are never installer progress', () => {
    expect(
      installerProgress(
        view('FLEET_SECRETS_RECIPIENT_MISSING: age1x is not a recipient'),
        NOW
      )
    ).toBeNull();
    expect(installerProgress(view(null), NOW)).toBeNull();
    expect(
      installerProgress(
        {
          ...view('FLEET_INSTALLING: phase=install x'),
          approval: 'rejected',
        },
        NOW
      )
    ).toBeNull();
  });

  test('an unknown phase still shows, without a step number', () => {
    expect(
      installerProgress(view('FLEET_INSTALLING: phase=zzz x'), NOW)
    ).toMatchObject({ phase: 'unknown', step: null });
  });
});

describe('the panel on the Pending page', () => {
  async function panel(rows: Parameters<typeof nodeRow>[0][]) {
    const { deps } = setup({ now: () => NOW });
    for (const row of rows) deps.store.seedNode(nodeRow(row));
    const fleet = await loadFleet(deps);
    const state = { fleet } as unknown as ConsoleState;
    return renderToStaticMarkup(
      <MantineProvider>
        <InstallerProgressPanel state={state} />
      </MantineProvider>
    );
  }

  test('lists a failed install with its error, next step and an issue link', async () => {
    const html = await panel([
      {
        short: 'aa11',
        role: null,
        observedRole: 'base',
        lastSeenAt: minutesAgo(2),
        body: {
          reconcile: {
            phase: 'blocked',
            issues: [
              'FLEET_API_UNAVAILABLE: phase=checks Fleet could not be reached.',
            ],
          },
        },
      },
    ]);
    expect(html).toContain('Installations in progress (1)');
    expect(html).toContain('Failed');
    expect(html).toContain('Step 3 of 6');
    expect(html).toContain('Nothing has been erased yet.');
    expect(html).toContain('cannot reach this controller');
    expect(html).toContain(
      `/report-issue?kind=installer&amp;node=${'aa11'.padEnd(64, '0')}`
    );
  });

  test('flags a silent installer and omits ordinary nodes', async () => {
    const html = await panel([
      {
        short: 'bb22',
        role: null,
        observedRole: 'base',
        lastSeenAt: minutesAgo(30),
        body: {
          reconcile: {
            phase: 'progressing',
            issues: ['FLEET_INSTALLING: phase=install copying'],
          },
        },
      },
      { short: 'cc33', lastSeenAt: minutesAgo(1) },
    ]);
    expect(html).toContain('No recent report');
    expect(html).toContain('No report for 30 minutes');
    expect(html).not.toContain('cc33');
  });

  test('renders nothing when no installation has reported', async () => {
    const html = await panel([{ short: 'dd44', lastSeenAt: minutesAgo(1) }]);
    expect(html).not.toContain('Installations in progress');
    expect(html).not.toContain('data-installer-progress');
  });
});
