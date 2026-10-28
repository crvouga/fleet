/**
 * Redaction for issue reports. Pure: text and JSON in, text and JSON plus a
 * count per redacted class out. A report is posted to GitHub, possibly a public
 * repository, so this runs over the structured snapshot (by key name and by
 * value shape) and again over the rendered Markdown. Over-redacting is the
 * safe failure; the preview shows what was removed. Limits: docs/issue-reporting.md.
 */
import type { RedactionHit } from './types';

export interface RedactOptions {
  /** Exact secret values the process knows (admin token, webhook secret, ...). */
  readonly literals?: readonly string[];
  /** Exact public replacements, e.g. a full node id for its short form. Not counted. */
  readonly aliases?: ReadonlyMap<string, string>;
  /** Replace email addresses. Default true: an issue never carries an actor's email. */
  readonly emails?: boolean;
}

export interface Redactor {
  text(input: string): string;
  /** A JSON-safe copy with every string redacted and secret-named keys blanked. */
  deep(value: unknown): unknown;
  summary(): RedactionHit[];
}

export const REDACTED = '[redacted]';
const MIN_LITERAL = 6;
const MAX_DEPTH = 10;
const MAX_ENTRIES = 400;

const SECRET_KEY =
  /(token|secret|password|passwd|passphrase|psk|credentials?|apikey|authorization|cookie|signature|(?:private|secret|access|api|auth|age|ssh|deploy|signing|encryption|master|session)key)(s|hash|next|value|data|id)?$/;

/** `adminTokenNext`, `FLEET_ADMIN_TOKEN`, `client-secret` and `secretHash` look secret; `FLEET_SECRETS_RECIPIENT_MISSING` does not. */
export function looksSecret(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

type Counter = (name: string) => void;
type Replace = (count: Counter, ...match: string[]) => string;

interface Rule {
  readonly name: string;
  readonly re: RegExp;
  readonly replace: Replace;
}

const fixed =
  (name: string): Replace =>
  (count) => {
    count(name);
    return REDACTED;
  };

/** Keeps the matched prefix (group 1) and blanks the rest. */
const keepPrefix =
  (name: string): Replace =>
  (count, _all, prefix) => {
    count(name);
    return `${prefix ?? ''}${REDACTED}`;
  };

const PEM =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|ENCRYPTED FILE|PGP PRIVATE KEY BLOCK)[A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g;

const RULES: readonly Rule[] = [
  { name: 'private-key', re: PEM, replace: fixed('private-key') },
  {
    name: 'age-key',
    re: /AGE-(?:SECRET-KEY|PLUGIN-[A-Z0-9]+)-[A-Za-z0-9]+/gi,
    replace: fixed('age-key'),
  },
  {
    name: 'sops',
    re: /ENC\[[A-Za-z0-9_]+,[^\]]*\]/g,
    replace: fixed('sops-ciphertext'),
  },
  {
    name: 'github-token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g,
    replace: fixed('github-token'),
  },
  {
    name: 'service-token',
    re: /\b(?:hv[sbr]\.[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{20,})/g,
    replace: fixed('service-token'),
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g,
    replace: fixed('jwt'),
  },
  {
    name: 'cookie',
    re: /((?:set-)?cookie["']?\s*[:=]\s*)(?!\[redacted)[^\r\n]+/gi,
    replace: keepPrefix('cookie'),
  },
  {
    name: 'authorization',
    re: /(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"',;}]+/gi,
    replace: keepPrefix('authorization'),
  },
  {
    name: 'bearer',
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g,
    replace: (count, _all, scheme) => {
      count('bearer');
      return `${scheme ?? 'Bearer'} ${REDACTED}`;
    },
  },
  {
    name: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi,
    replace: (count, _all, scheme) => {
      count('url-credentials');
      return `${scheme ?? ''}${REDACTED}@`;
    },
  },
  {
    name: 'url-parameter',
    re: /([?&;](?:access_token|refresh_token|id_token|token|key|secret|password|pass|pwd|sig|signature|code|apikey|api_key|auth|jwt|client_secret|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s#"'<>]+/gi,
    replace: keepPrefix('url-parameter'),
  },
  {
    name: 'enrollment',
    re: /((?:fleet\.enroll=|FLEET_ENROLL_TOKEN=))\S+/gi,
    replace: keepPrefix('enrollment-token'),
  },
  {
    name: 'flag',
    re: /((?<![\w-])--?[a-z-]*(?:token|secret|password|passphrase|psk|credential)[a-z-]*(?:=|\s+))(?!-)[^\s"']+/gi,
    replace: keepPrefix('secret-flag'),
  },
];

/** The match and its capture groups: everything before the numeric offset, unmatched groups as ''. */
function matchGroups(args: readonly unknown[]): string[] {
  const end = args.findIndex((arg) => typeof arg === 'number');
  return args
    .slice(0, end < 0 ? args.length : end)
    .map((arg) => (typeof arg === 'string' ? arg : ''));
}

const KEY_VALUE =
  /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1(\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;}\]"']+)/g;

/**
 * Blanks the value of every `key=value` / `"key": "value"` whose key looks
 * secret. A value of an ordinary key is scanned again, so `?x=1#password=abc`
 * cannot hide the password behind `x`.
 */
function blankKeyValues(input: string, count: Counter): string {
  const re = new RegExp(KEY_VALUE.source, 'g');
  let out = '';
  let copied = 0;
  for (let hit = re.exec(input); hit !== null; hit = re.exec(input)) {
    const [all, quote = '', key = '', sep = '', value = ''] = hit;
    if (!looksSecret(key) || value.startsWith('[redacted')) {
      re.lastIndex = hit.index + all.length - value.length;
      continue;
    }
    count('secret-field');
    const q = value.startsWith('"') || value.startsWith("'") ? value[0]! : '';
    out += `${input.slice(copied, hit.index)}${quote}${key}${quote}${sep}${q}${REDACTED}${q}`;
    copied = hit.index + all.length;
  }
  return out + input.slice(copied);
}

const HEX = /(?<![0-9a-fA-F])[0-9a-fA-F]{56,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function variants(literal: string): string[] {
  const forms = new Set([
    literal,
    encodeURIComponent(literal),
    JSON.stringify(literal).slice(1, -1),
    Buffer.from(literal).toString('base64'),
  ]);
  return [...forms].filter((form) => form.length >= MIN_LITERAL);
}

function literalPattern(literals: readonly string[]): RegExp | null {
  const forms = literals
    .filter((value) => value.length >= MIN_LITERAL)
    .flatMap(variants)
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return forms.length === 0 ? null : new RegExp(forms.join('|'), 'g');
}

function aliasPattern(aliases: ReadonlyMap<string, string>): RegExp | null {
  const keys = [...aliases.keys()].filter((key) => key.length > 0);
  return keys.length === 0
    ? null
    : new RegExp(
        keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
        'g'
      );
}

class Redaction implements Redactor {
  private readonly counts = new Map<string, number>();
  private readonly literals: RegExp | null;
  private readonly aliasRe: RegExp | null;
  private readonly aliases: ReadonlyMap<string, string>;
  private readonly emails: boolean;

  constructor(options: RedactOptions) {
    this.literals = literalPattern(options.literals ?? []);
    this.aliases = options.aliases ?? new Map();
    this.aliasRe = aliasPattern(this.aliases);
    this.emails = options.emails ?? true;
  }

  private readonly count: Counter = (name) => {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  };

  text(input: string): string {
    let out = input;
    if (this.aliasRe !== null)
      out = out.replace(this.aliasRe, (hit) => this.aliases.get(hit) ?? hit);
    if (this.literals !== null)
      out = out.replace(this.literals, () => {
        this.count('configured-secret');
        return REDACTED;
      });
    for (const rule of RULES)
      out = out.replace(rule.re, (...args: unknown[]) =>
        rule.replace(this.count, ...matchGroups(args))
      );
    out = blankKeyValues(out, this.count);
    out = out.replace(HEX, () => {
      this.count('hex-secret');
      return REDACTED;
    });
    if (this.emails)
      out = out.replace(EMAIL, () => {
        this.count('email');
        return '[redacted:email]';
      });
    return out;
  }

  deep(value: unknown): unknown {
    return this.walk(value, false, 0);
  }

  private walk(value: unknown, secret: boolean, depth: number): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'object')
      return this.walkContainer(value, secret, depth);
    return this.walkScalar(value, secret);
  }

  private walkScalar(value: unknown, secret: boolean): unknown {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string')
      return secret && value !== '' ? this.blank() : this.text(value);
    if (typeof value === 'number' || typeof value === 'bigint') {
      if (secret) return this.blank();
      return typeof value === 'bigint' ? String(value) : value;
    }
    return undefined;
  }

  private walkContainer(
    value: object,
    secret: boolean,
    depth: number
  ): unknown {
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_DEPTH) return '[truncated: too deep]';
    if (value instanceof Error)
      return this.walkObject(
        { name: value.name, message: value.message },
        depth
      );
    if (Array.isArray(value))
      return value
        .slice(0, MAX_ENTRIES)
        .map((item) => this.walk(item, secret, depth + 1));
    return this.walkObject(value, depth);
  }

  private walkObject(value: object, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
      if (item === undefined || typeof item === 'function') continue;
      out[this.text(key)] = this.walk(item, looksSecret(key), depth + 1);
    }
    return out;
  }

  private blank(): string {
    this.count('secret-field');
    return REDACTED;
  }

  summary(): RedactionHit[] {
    return [...this.counts.entries()]
      .map(([name, count]) => ({ class: name, count }))
      .sort((a, b) => a.class.localeCompare(b.class));
  }
}

export function createRedactor(options: RedactOptions = {}): Redactor {
  return new Redaction(options);
}

/** Convenience for one-off redaction of a single string. */
export function redactText(input: string, options: RedactOptions = {}): string {
  return createRedactor(options).text(input);
}
