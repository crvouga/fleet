/**
 * The hardware support matrix shown on Add node. It must equal HARDWARE_MATRIX in
 * packages/fleet/scripts/decide.py (the classification the installer enforces) and
 * the tables in packages/fleet/docs/installer.md and hardware.md; a test compares them.
 */
export type HardwareTier = 'supported' | 'partially automated' | 'unsupported';

export interface HardwareRow {
  readonly platform: string;
  /** When this computer becomes the node. */
  readonly asNode: HardwareTier;
  /** When this computer only writes install USB media for another one. */
  readonly asMediaMaker: HardwareTier;
}

export const HARDWARE_MATRIX: readonly HardwareRow[] = [
  row('Windows x64 (UEFI, GPT, Secure Boot off)', 'supported', 'supported'),
  row(
    'Windows x64 with Secure Boot on, unreadable Secure Boot, BitLocker, RAID/VMD or battery',
    'partially automated',
    'supported'
  ),
  row(
    'Windows with legacy BIOS, MBR, dynamic disk, no EFI partition or more than one internal disk',
    'unsupported',
    'supported'
  ),
  row(
    'Linux x64 (UEFI) with kexec or an installable kexec-tools',
    'supported',
    'supported'
  ),
  row(
    'Linux x64 with Wi-Fi as the only network',
    'partially automated',
    'supported'
  ),
  row(
    'Linux without kexec that cannot be prepared, or an unsupported staging filesystem',
    'unsupported',
    'supported'
  ),
  row('NixOS x64', 'supported', 'supported'),
  row('macOS (Intel or Apple silicon)', 'unsupported', 'supported'),
  row('Linux or NixOS ARM64, other ARM', 'unsupported', 'supported'),
  row(
    'Any machine with less RAM than the image plus 2 GiB',
    'unsupported',
    'supported'
  ),
];

function row(
  platform: string,
  asNode: HardwareTier,
  asMediaMaker: HardwareTier
): HardwareRow {
  return { platform, asNode, asMediaMaker };
}

export const TIER_MEANING: Record<HardwareTier, string> = {
  supported:
    'The installer checks and handles everything; you confirm the disk.',
  'partially automated':
    'It can proceed, but a limit remains (a firmware setting, a recovery key, an unverifiable driver). You must acknowledge the limit named on the review page.',
  unsupported:
    'In-place install is refused before anything changes. Make an install USB, or fix the problem the review names.',
};
