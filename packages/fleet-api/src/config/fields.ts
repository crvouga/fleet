/**
 * Fleet configuration: data, never code. Each node receives the merge of the
 * documents that apply to it and applies the keys it understands to its own
 * behavior. A key a node does not set keeps the value built into its image.
 * The meaning of each key on the node is in packages/fleet/docs/dynamic-config.md.
 */
export interface FleetConfig {
  heartbeat?: { intervalSeconds?: number };
  /**
   * retryBootAfter: a Unix time. A kernel this node quarantined before then may
   * be tried again (the node page's "Retry the update" sets it to now).
   */
  sync?: { paused?: boolean; retryBootAfter?: number };
  reboot?: { enabled?: boolean; delayMaxSeconds?: number };
  disk?: { alertPercent?: number };
  capacity?: {
    reserveGiB?: number;
    perRunnerGiB?: number;
    perRunnerCores?: number;
    slotMax?: number;
    highMemGiB?: number;
  };
  runners?: {
    enabled?: boolean;
    cordoned?: boolean;
    /**
     * A Unix time. A manual drain recorded before then is lifted (the node
     * page's "Reopen runner admission" sets it to now).
     */
    reopenAfter?: number;
    repositories?: string[];
    extraLabels?: string[];
  };
  /** Server side only. Never sent to a node. */
  alerts?: { offlineAfterSeconds?: number; webhookUrl?: string | null };
}

export type Section = keyof FleetConfig;

export interface IntRule {
  readonly kind: 'int';
  readonly min: number;
  readonly max: number;
}
export interface BoolRule {
  readonly kind: 'bool';
}
export interface ListRule {
  readonly kind: 'list';
  readonly max: number;
  readonly pattern: RegExp;
  readonly forbidden?: readonly string[];
}
export interface UrlRule {
  readonly kind: 'url-or-null';
}
export type Rule = IntRule | BoolRule | ListRule | UrlRule;

/** Labels the image already sets, so a person cannot shadow them. */
export const RESERVED_LABELS = [
  'self-hosted',
  'linux',
  'x64',
  'arm64',
  'nixos',
  'ci',
  'gpu',
  'high-mem',
] as const;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,50}$/;
const MAX_REPOSITORIES = 64;
const MAX_LABELS = 16;
export const MAX_URL_LENGTH = 500;

export const RULES: Readonly<Record<Section, Readonly<Record<string, Rule>>>> =
  {
    heartbeat: { intervalSeconds: { kind: 'int', min: 15, max: 3600 } },
    sync: {
      paused: { kind: 'bool' },
      retryBootAfter: { kind: 'int', min: 0, max: 4102444800 },
    },
    reboot: {
      enabled: { kind: 'bool' },
      delayMaxSeconds: { kind: 'int', min: 0, max: 86400 },
    },
    disk: { alertPercent: { kind: 'int', min: 50, max: 99 } },
    capacity: {
      reserveGiB: { kind: 'int', min: 0, max: 256 },
      perRunnerGiB: { kind: 'int', min: 1, max: 256 },
      perRunnerCores: { kind: 'int', min: 1, max: 128 },
      slotMax: { kind: 'int', min: 1, max: 64 },
      highMemGiB: { kind: 'int', min: 1, max: 4096 },
    },
    runners: {
      enabled: { kind: 'bool' },
      cordoned: { kind: 'bool' },
      reopenAfter: { kind: 'int', min: 0, max: 4102444800 },
      repositories: {
        kind: 'list',
        max: MAX_REPOSITORIES,
        pattern: REPO_PATTERN,
      },
      extraLabels: {
        kind: 'list',
        max: MAX_LABELS,
        pattern: LABEL_PATTERN,
        forbidden: RESERVED_LABELS,
      },
    },
    alerts: {
      offlineAfterSeconds: { kind: 'int', min: 60, max: 86400 },
      webhookUrl: { kind: 'url-or-null' },
    },
  };

export const SECTIONS = Object.keys(RULES) as Section[];
