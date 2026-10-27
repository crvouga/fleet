import {
  RULES,
  SECTIONS,
  validateConfig,
  type FleetConfig,
} from '../../config/schema';
import { maskUrl } from './format';

/** Loosely typed on purpose: it holds what a person typed, valid or not. */
export type Draft = Record<string, Record<string, unknown>>;

export type FormBody = Readonly<
  Record<string, string | File | (string | File)[]>
>;

type Rule = (typeof RULES)[keyof typeof RULES][string];

export const WEBHOOK_PATH = 'alerts.webhookUrl';

function text(body: FormBody, name: string): string {
  const value = body[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

function lines(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function readInt(raw: string): unknown {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? raw.trim() : value;
}

function readBool(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function readUrl(body: FormBody, name: string, current: unknown): unknown {
  if (text(body, `${name}.__clear`) !== '') return undefined;
  const raw = text(body, name).trim();
  return raw === '' ? current : raw;
}

function readField(
  rule: Rule,
  body: FormBody,
  path: string,
  current: unknown
): unknown {
  const raw = text(body, path);
  switch (rule.kind) {
    case 'int':
      return readInt(raw);
    case 'bool':
      return readBool(raw);
    case 'list': {
      const items = lines(raw);
      return items.length === 0 ? undefined : items;
    }
    case 'url-or-null':
      return readUrl(body, path, current);
  }
}

function currentValue(
  current: FleetConfig,
  section: string,
  key: string
): unknown {
  return (current as Record<string, Record<string, unknown> | undefined>)[
    section
  ]?.[key];
}

/** The document a submitted form describes. Empty fields are left out (inherit). */
export function draftFromForm(body: FormBody, current: FleetConfig): Draft {
  const draft: Draft = {};
  for (const section of SECTIONS) {
    for (const [key, rule] of Object.entries(RULES[section])) {
      const value = readField(
        rule,
        body,
        `${section}.${key}`,
        currentValue(current, section, key)
      );
      if (value === undefined) continue;
      draft[section] = { ...draft[section], [key]: value };
    }
  }
  return draft;
}

/** Pretty JSON for the advanced view, with the webhook reduced to its host. */
export function rawJson(config: FleetConfig): string {
  const copy: Draft = JSON.parse(JSON.stringify(config)) as Draft;
  const alerts = copy['alerts'];
  if (alerts !== undefined && typeof alerts['webhookUrl'] === 'string') {
    alerts['webhookUrl'] = maskUrl(alerts['webhookUrl']);
  }
  return JSON.stringify(copy, null, 2);
}

export type RawResult =
  | { readonly ok: true; readonly draft: Draft }
  | { readonly ok: false; readonly error: string };

/** Parses the advanced view; a masked webhook means "unchanged". */
export function draftFromRaw(source: string, current: FleetConfig): RawResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Settings must be a JSON object.' };
  }
  const draft = parsed as Draft;
  const url = currentValue(current, 'alerts', 'webhookUrl');
  const alerts = draft['alerts'];
  if (
    typeof url === 'string' &&
    alerts !== undefined &&
    alerts['webhookUrl'] === maskUrl(url)
  ) {
    alerts['webhookUrl'] = url;
  }
  return { ok: true, draft };
}

export interface SplitErrors {
  readonly byField: ReadonlyMap<string, string>;
  readonly general: readonly string[];
}

/** Errors start with the setting path, so each can sit next to its field. */
export function splitErrors(errors: readonly string[]): SplitErrors {
  const byField = new Map<string, string>();
  const general: string[] = [];
  const known = new Set(
    SECTIONS.flatMap((s) => Object.keys(RULES[s]).map((k) => `${s}.${k}`))
  );
  for (const message of errors) {
    const path = message.split(' ')[0] ?? '';
    if (known.has(path) && !byField.has(path)) byField.set(path, message);
    else general.push(message);
  }
  return { byField, general };
}

export function check(
  draft: Draft
): { ok: true; value: FleetConfig } | { ok: false; errors: readonly string[] } {
  return validateConfig(draft);
}
