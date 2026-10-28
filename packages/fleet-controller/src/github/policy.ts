import { validateConfig } from '../config/schema';

import type { GithubPolicy, GithubScope, IntegrationInput } from './types';

export const DEFAULT_POLICY: GithubPolicy = {
  extraLabels: [],
  maxNodesPerRepository: 0,
  repositoryRequirements: {},
  orphanAutoRemoval: false,
  orphanGraceSeconds: 1800,
  syncIntervalSeconds: 60,
};

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type Json = Record<string, unknown>;
const ID = /^[0-9]{1,20}$/;
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const RUNNER_GROUP = /^[A-Za-z0-9 _.-]{1,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CAPABILITY = /^[A-Za-z0-9_.:-]{1,50}$/;
const MAX_REQUIREMENT_REPOSITORIES = 64;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null;
}

function bounded(
  value: unknown,
  name: string,
  range: readonly [number, number],
  errors: string[]
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= range[0] &&
    value <= range[1]
  ) {
    return value;
  }
  errors.push(
    `policy.${name} must be a whole number from ${range[0]} to ${range[1]}`
  );
  return undefined;
}

function requirementsOf(
  value: unknown,
  errors: string[]
): Record<string, string[]> {
  if (value === undefined) return {};
  const source = record(value);
  if (source === null) {
    errors.push('policy.repositoryRequirements must be an object');
    return {};
  }
  const out: Record<string, string[]> = {};
  const entries = Object.entries(source);
  if (entries.length > MAX_REQUIREMENT_REPOSITORIES) {
    errors.push('policy.repositoryRequirements has too many repositories');
    return {};
  }
  for (const [repository, needs] of entries) {
    const list = strings(needs);
    const good =
      REPOSITORY.test(repository) &&
      list !== null &&
      list.length <= 8 &&
      list.every((n) => CAPABILITY.test(n));
    if (good) out[repository] = list;
    else errors.push(`policy.repositoryRequirements.${repository} is invalid`);
  }
  return out;
}

function labelsOf(value: unknown, errors: string[]): string[] {
  if (value === undefined) return [];
  const checked = validateConfig({ runners: { extraLabels: value } });
  if (!checked.ok) {
    errors.push(...checked.errors.map((e) => e.replace('runners.', 'policy.')));
    return [];
  }
  return [...((checked.value.runners?.extraLabels as string[]) ?? [])];
}

function numbers(source: Json, errors: string[]) {
  return {
    maxNodesPerRepository:
      bounded(
        source['maxNodesPerRepository'],
        'maxNodesPerRepository',
        [0, 1000],
        errors
      ) ?? DEFAULT_POLICY.maxNodesPerRepository,
    orphanGraceSeconds:
      bounded(
        source['orphanGraceSeconds'],
        'orphanGraceSeconds',
        [60, 30 * 86400],
        errors
      ) ?? DEFAULT_POLICY.orphanGraceSeconds,
    syncIntervalSeconds:
      bounded(
        source['syncIntervalSeconds'],
        'syncIntervalSeconds',
        [15, 3600],
        errors
      ) ?? DEFAULT_POLICY.syncIntervalSeconds,
  };
}

function unknownKeys(source: Json, errors: string[]): void {
  const known = new Set(Object.keys(DEFAULT_POLICY));
  for (const key of Object.keys(source)) {
    if (!known.has(key)) errors.push(`policy.${key} is not a policy setting`);
  }
  const auto = source['orphanAutoRemoval'];
  if (auto !== undefined && typeof auto !== 'boolean') {
    errors.push('policy.orphanAutoRemoval must be true or false');
  }
}

/** Strict: an unknown key is an error, so a typo cannot silently do nothing. */
export function parsePolicy(input: unknown): Parsed<GithubPolicy> {
  const source = input === undefined ? {} : record(input);
  if (source === null)
    return { ok: false, errors: ['policy must be an object'] };
  const errors: string[] = [];
  unknownKeys(source, errors);
  const policy: GithubPolicy = {
    ...numbers(source, errors),
    extraLabels: labelsOf(source['extraLabels'], errors),
    repositoryRequirements: requirementsOf(
      source['repositoryRequirements'],
      errors
    ),
    orphanAutoRemoval: source['orphanAutoRemoval'] === true,
  };
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: policy };
}

/** A stored policy, leniently: anything invalid falls back to the default. */
export function readPolicy(stored: unknown): GithubPolicy {
  const parsed = parsePolicy(stored);
  return parsed.ok ? parsed.value : DEFAULT_POLICY;
}

function textField(
  value: unknown,
  name: string,
  pattern: RegExp,
  errors: string[]
): string {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string' && pattern.test(value)) return value;
  errors.push(`${name} is invalid`);
  return '';
}

function repositoriesOf(value: unknown, errors: string[]): string[] {
  if (value === undefined) return [];
  const checked = validateConfig({ runners: { repositories: value } });
  if (!checked.ok) {
    errors.push(...checked.errors.map((e) => e.replace('runners.', '')));
    return [];
  }
  return [...((checked.value.runners?.repositories as string[]) ?? [])];
}

function scopeOf(value: unknown, errors: string[]): GithubScope {
  if (value === 'repository' || value === 'organization') return value;
  errors.push('scope must be repository or organization');
  return 'repository';
}

function groupOf(value: unknown, errors: string[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && RUNNER_GROUP.test(value)) return value;
  errors.push('runnerGroup is invalid');
  return null;
}

/** The operator's connection settings. The private key is never part of it. */
export function parseIntegration(input: unknown): Parsed<IntegrationInput> {
  const source = record(input);
  if (source === null)
    return { ok: false, errors: ['the body must be an object'] };
  const errors: string[] = [];
  const known = [
    'scope',
    'organization',
    'repositories',
    'runnerGroup',
    'appId',
    'installationId',
    'policy',
  ];
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) errors.push(`${key} is not a setting`);
  }
  const policy = parsePolicy(source['policy']);
  if (!policy.ok) errors.push(...policy.errors);
  const value: IntegrationInput = {
    scope: scopeOf(source['scope'], errors),
    organization: textField(
      source['organization'],
      'organization',
      ORGANIZATION,
      errors
    ),
    repositories: repositoriesOf(source['repositories'], errors),
    runnerGroup: groupOf(source['runnerGroup'], errors),
    appId: textField(source['appId'], 'appId', ID, errors),
    installationId: textField(
      source['installationId'],
      'installationId',
      ID,
      errors
    ),
    policy: policy.ok ? policy.value : DEFAULT_POLICY,
  };
  if (
    value.scope === 'organization' &&
    value.organization === '' &&
    errors.length === 0
  ) {
    errors.push('organization is required when the scope is organization');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export const EMPTY_INTEGRATION: IntegrationInput = {
  scope: 'repository',
  organization: '',
  repositories: [],
  runnerGroup: null,
  appId: '',
  installationId: '',
  policy: DEFAULT_POLICY,
};

/** The repositories and organization the controller works against; null when not set up. */
export function isConfigured(integration: IntegrationInput): boolean {
  if (integration.appId === '' || integration.installationId === '')
    return false;
  return integration.scope === 'organization'
    ? integration.organization !== ''
    : integration.repositories.length > 0;
}
