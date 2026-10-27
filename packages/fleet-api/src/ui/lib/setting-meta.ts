import { RULES, SECTIONS } from '../../config/fields';

export interface SettingMeta {
  readonly label: string;
  /** What changing it does on a node, in plain words. */
  readonly help: string;
  readonly unit?: string;
}

export interface SectionMeta {
  readonly title: string;
  readonly blurb: string;
}

export const SECTION_META: Readonly<
  Record<(typeof SECTIONS)[number], SectionMeta>
> = {
  heartbeat: {
    title: 'Check-ins',
    blurb: 'How often nodes report to this server.',
  },
  sync: {
    title: 'Updates',
    blurb: 'Whether nodes follow the main branch.',
  },
  reboot: {
    title: 'Reboots',
    blurb: 'When a node may restart itself after an update.',
  },
  disk: {
    title: 'Disk',
    blurb: 'When a full disk raises an alert.',
  },
  capacity: {
    title: 'Runner capacity',
    blurb:
      'How many CI jobs a machine runs at once: slots = min(slotMax, (memory - reserve) / perRunnerGiB, cores / perRunnerCores).',
  },
  runners: {
    title: 'CI runners',
    blurb: 'Which repositories a CI node serves and how it is labelled.',
  },
  alerts: {
    title: 'Alerts',
    blurb: 'Handled by this server only; nodes never receive these values.',
  },
};

export const SETTING_META: Readonly<Record<string, SettingMeta>> = {
  'heartbeat.intervalSeconds': {
    label: 'Heartbeat interval',
    unit: 'seconds',
    help: 'How often a node sends a report. Shorter shows problems sooner but adds traffic; longer is quieter. A node that cannot reach the server keeps working.',
  },
  'sync.paused': {
    label: 'Pause updates',
    help: 'When on, nodes stay on the system they run now and ignore new commits on main. Use it to freeze a machine during an incident. Reports continue.',
  },
  'sync.retryBootAfter': {
    label: 'Retry a quarantined kernel',
    unit: 'Unix time',
    help: 'Set by the node page’s Retry the update button. A kernel the node fell back from before this time is tried again: the node drains, reboots into it, and quarantines it again if it still does not come up healthy.',
  },
  'reboot.enabled': {
    label: 'Allow automatic reboots',
    help: 'When on, a node may reboot itself to finish an update that needs it. When off it applies what it can and waits for you.',
  },
  'reboot.delayMaxSeconds': {
    label: 'Reboot window',
    unit: 'seconds',
    help: 'A node waits a random time up to this long before rebooting, so a role does not go down all at once. 0 reboots immediately.',
  },
  'disk.alertPercent': {
    label: 'Disk alert threshold',
    unit: '% used',
    help: 'A node whose Nix store or boot disk is at least this full shows up under Needs attention.',
  },
  'capacity.reserveGiB': {
    label: 'Memory reserved for the system',
    unit: 'GiB',
    help: 'Memory kept free for the operating system before runner slots are counted. Raise it if builds push a machine into swap.',
  },
  'capacity.perRunnerGiB': {
    label: 'Memory per runner',
    unit: 'GiB',
    help: 'Each CI slot is assumed to need this much memory. Fewer GiB means more slots on the same machine.',
  },
  'capacity.perRunnerCores': {
    label: 'CPU cores per runner',
    unit: 'cores',
    help: 'Each CI slot is assumed to need this many cores. Fewer cores per runner means more slots.',
  },
  'capacity.slotMax': {
    label: 'Maximum slots',
    unit: 'slots',
    help: 'Hard ceiling on concurrent CI jobs for one machine, whatever its memory and cores allow.',
  },
  'capacity.highMemGiB': {
    label: 'High-memory threshold',
    unit: 'GiB',
    help: 'Machines with at least this much memory get the high-mem runner label, so heavy jobs can ask for them.',
  },
  'runners.enabled': {
    label: 'Runners enabled',
    help: 'When off, the node registers no GitHub runners at all. Existing runners stop taking jobs once their current job ends.',
  },
  'runners.cordoned': {
    label: 'Cordoned',
    help: 'When on, the node finishes the jobs it has but accepts no new ones. Use it to drain a machine before maintenance.',
  },
  'runners.reopenAfter': {
    label: 'Reopen admission after a manual drain',
    unit: 'Unix time',
    help: 'Set by the node page’s Reopen runner admission button. A manual drain started before this time is lifted. Low disk space and an update in progress still keep admission closed.',
  },
  'runners.repositories': {
    label: 'Repositories',
    unit: 'owner/name',
    help: 'GitHub repositories this node serves. One per line. Leave empty to inherit from the fleet or role.',
  },
  'runners.extraLabels': {
    label: 'Extra runner labels',
    help: 'Labels added to every runner on the node so workflows can target it. One per line. Labels the image already sets cannot be repeated.',
  },
  'alerts.offlineAfterSeconds': {
    label: 'Offline threshold',
    unit: 'seconds',
    help: 'How long a node may stay silent before it counts as offline and a notice is sent. Only the fleet value is used.',
  },
  'alerts.webhookUrl': {
    label: 'Alert webhook',
    unit: 'https URL',
    help: 'Receives a POST when a node goes offline or recovers. The address is treated as a secret and only its host is shown here after saving.',
  },
};

export function settingMeta(section: string, key: string): SettingMeta {
  return SETTING_META[`${section}.${key}`] ?? { label: key, help: '' };
}

/** Every `section.key` the rules define, in display order. */
export function allSettingPaths(): string[] {
  return SECTIONS.flatMap((section) =>
    Object.keys(RULES[section]).map((key) => `${section}.${key}`)
  );
}
