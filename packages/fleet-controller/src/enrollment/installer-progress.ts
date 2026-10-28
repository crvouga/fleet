import type { NodeView } from '../types';

/** The live installer's steps, in order (scripts/fleet-install.sh `live_step`). */
export const INSTALLER_PHASES = [
  'network',
  'approval',
  'checks',
  'disk',
  'erase',
  'install',
] as const;
export type InstallerPhase = (typeof INSTALLER_PHASES)[number];

export const DEFAULT_STALE_MINUTES = 10;

export interface InstallerProgress {
  /** The public `FLEET_*` code the installer reported. */
  readonly code: string;
  readonly phase: InstallerPhase | 'unknown';
  /** 1-based position of the phase, for "step 3 of 6". */
  readonly step: number | null;
  readonly failed: boolean;
  /** No report for longer than the threshold while the install had not failed. */
  readonly stale: boolean;
  readonly minutesSilent: number | null;
  /** What the installer said, without the code and phase tag. */
  readonly message: string;
  /** What a person should do now; null while all is well. */
  readonly nextStep: string | null;
  /** True once nothing on the machine's disk has been touched yet. */
  readonly nothingErased: boolean;
}

const TAGGED = /^(FLEET_[A-Z_]+): phase=([a-z]+) ?(.*)$/s;

interface Advice {
  readonly pattern: RegExp;
  readonly step: string;
}

/** Code -> next step. Mirrors the installer screen (scripts/live_console.py ADVICE). First match wins. */
const ADVICE: readonly Advice[] = [
  {
    pattern: /^FLEET_HARDWARE_UNSUPPORTED$/,
    step: 'This hardware is not supported and nothing was erased. Use a supported x86-64 UEFI computer, or fix the problem the message names (for example plug in a supported Ethernet adapter). See docs/hardware.md.',
  },
  {
    pattern: /^FLEET_ENROLLMENT_(EXPIRED|REVOKED)$/,
    step: 'The installer grant is no longer valid. Create a new installer binding under Add node, or approve the computer under Pending. Nothing was erased.',
  },
  {
    pattern: /^FLEET_ENROLLMENT_/,
    step: 'Fleet did not accept the enrollment token. Remove it or create a new installer binding under Add node, then retry. Nothing was erased.',
  },
  {
    pattern: /^FLEET_APPROVAL_/,
    step: 'Approve this computer under Pending, then open the Fleet installer on it again.',
  },
  {
    pattern: /^FLEET_API_UNAVAILABLE$/,
    step: 'The installer cannot reach this controller. It retries by itself; check the machine’s network and that this app is reachable from it.',
  },
  {
    pattern: /^FLEET_CACHE_/,
    step: 'The update cache is not ready for this release. Wait a few minutes; if it keeps failing, report it because the release may be ahead of the cache.',
  },
  {
    pattern:
      /^FLEET_(PLATFORM_NOT_READY|METADATA_|LOCAL_CLOSURE|BOOTSTRAP_INVALID|API_UNCONFIGURED)/,
    step: 'The published installer is not ready; an administrator has to fix the deployment configuration and publish a new installer. Nothing on the machine needs to change.',
  },
  {
    pattern: /^FLEET_INSTALL_FAILED$/,
    step: 'The installer stopped. On the machine press Alt+F2 and run fleet-status, then report the problem. If it failed at or after “erase” the disk may have been changed; retry from the installer screen.',
  },
];

function adviceFor(code: string): string | null {
  return ADVICE.find((entry) => entry.pattern.test(code))?.step ?? null;
}

function phaseOf(tag: string): InstallerPhase | 'unknown' {
  return (INSTALLER_PHASES as readonly string[]).includes(tag)
    ? (tag as InstallerPhase)
    : 'unknown';
}

function minutesSince(at: Date | null, now: Date): number | null {
  return at === null
    ? null
    : Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
}

function nextStepFor(
  code: string,
  failed: boolean,
  stale: boolean,
  minutes: number | null
): string | null {
  if (failed)
    return (
      adviceFor(code) ??
      'The installer reported a problem. Report it, including the code above.'
    );
  return stale
    ? `No report for ${minutes} minutes. The installer may have stopped, lost power or lost its network. Look at the machine’s screen; if it shows an error press Alt+F2 and run fleet-status.`
    : null;
}

const BEFORE_ERASE: readonly string[] = [
  'network',
  'approval',
  'checks',
  'disk',
];

type Reportable = Pick<
  NodeView,
  'reconcile' | 'reconcileIssues' | 'lastSeenAt' | 'approval'
>;

/** The code, phase tag and text of the node's first issue, when the live installer wrote it. */
function taggedIssue(view: Reportable): RegExpExecArray | null {
  if (view.approval === 'rejected' || view.approval === 'retired') return null;
  const issue = view.reconcileIssues[0];
  return issue === undefined ? null : TAGGED.exec(issue);
}

/** Only the live installer writes `phase=`, so this never matches an installed node's own reports. */
export function installerProgress(
  view: Reportable,
  now: Date,
  staleMinutes = DEFAULT_STALE_MINUTES
): InstallerProgress | null {
  const match = taggedIssue(view);
  if (match === null) return null;
  const [, code = '', tag = '', rest = ''] = match;
  const phase = phaseOf(tag);
  const failed = view.reconcile?.phase === 'blocked';
  const minutesSilent = minutesSince(view.lastSeenAt, now);
  const stale =
    !failed && minutesSilent !== null && minutesSilent >= staleMinutes;
  return {
    code,
    phase,
    step: phase === 'unknown' ? null : INSTALLER_PHASES.indexOf(phase) + 1,
    failed,
    stale,
    minutesSilent,
    message: rest.trim().slice(0, 400),
    nextStep: nextStepFor(code, failed, stale, minutesSilent),
    nothingErased: BEFORE_ERASE.includes(phase),
  };
}
