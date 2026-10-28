/**
 * Seeded generators of every secret shape the redactor must remove. Shared by
 * the redaction property tests and the end-to-end canary. Deterministic: the
 * same seed always produces the same secrets.
 */
export type Rnd = () => number;

export function seeded(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const URLSAFE = `${ALNUM}-_`;
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function pick(rnd: Rnd, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1)
    out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

export function between(rnd: Rnd, low: number, high: number): number {
  return low + Math.floor(rnd() * (high - low + 1));
}

export interface Secret {
  readonly name: string;
  /** What is planted in the text. */
  readonly text: string;
  /** The part that must never appear in any output. */
  readonly core: string;
}

const same = (name: string, value: string): Secret => ({
  name,
  text: value,
  core: value,
});

function jwt(rnd: Rnd): Secret {
  const part = (n: number) => pick(rnd, URLSAFE, n);
  const value = `eyJ${part(between(rnd, 12, 30))}.eyJ${part(between(rnd, 20, 60))}.${part(43)}`;
  return same('jwt', value);
}

function pem(rnd: Rnd): Secret {
  const kinds = [
    'RSA PRIVATE KEY',
    'PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'EC PRIVATE KEY',
  ];
  const kind = kinds[between(rnd, 0, kinds.length - 1)]!;
  const body = Array.from({ length: between(rnd, 2, 6) }, () =>
    pick(rnd, `${ALNUM}+/`, 64)
  );
  return {
    name: 'pem',
    text: `-----BEGIN ${kind}-----\n${body.join('\n')}\n-----END ${kind}-----`,
    core: body[0]!,
  };
}

/** One generator per secret class; every call draws fresh random material. */
export const SECRET_SHAPES: readonly ((rnd: Rnd) => Secret)[] = [
  (r) => same('ghp', `ghp_${pick(r, ALNUM, 36)}`),
  (r) => same('gho', `gho_${pick(r, ALNUM, 36)}`),
  (r) => same('ghs', `ghs_${pick(r, ALNUM, 36)}`),
  (r) => same('ghu', `ghu_${pick(r, ALNUM, 36)}`),
  (r) =>
    same(
      'github_pat',
      `github_pat_${pick(r, ALNUM, 22)}_${pick(r, ALNUM, 59)}`
    ),
  jwt,
  (r) => same('age', `AGE-SECRET-KEY-1${pick(r, UPPER, 58)}`),
  (r) => same('hex64', pick(r, HEX, 64)),
  (r) => same('hex-longer', pick(r, HEX, between(r, 65, 128))),
  pem,
  (r) => same('vault', `hvs.${pick(r, URLSAFE, 24)}`),
  (r) => same('aws', `AKIA${pick(r, UPPER, 16)}`),
  (r) =>
    same('slack', `xoxb-${pick(r, '0123456789', 11)}-${pick(r, ALNUM, 24)}`),
  (r) =>
    same(
      'sops',
      `ENC[AES256_GCM,data:${pick(r, `${ALNUM}+/=`, 30)},iv:${pick(r, ALNUM, 16)},tag:${pick(r, ALNUM, 16)},type:str]`
    ),
];

/** An opaque value with no recognisable shape: safe only when its KEY gives it away. */
export function opaque(rnd: Rnd): string {
  return pick(rnd, `${ALNUM}-_.+/=`, between(rnd, 8, 40));
}

export const SECRET_KEYS = [
  'password',
  'PASSWORD',
  'db_password',
  'passwd',
  'passphrase',
  'secret',
  'client_secret',
  'FLEET_ADMIN_TOKEN',
  'FLEET_ADMIN_TOKEN_NEXT',
  'FLEET_GITHUB_WEBHOOK_SECRET',
  'FLEET_ISSUES_GITHUB_TOKEN',
  'access_token',
  'refreshToken',
  'apiKey',
  'api_key',
  'privateKey',
  'secretHash',
  'tokenHash',
  'psk',
  'wifi_psk',
  'wpa_passphrase',
  'credential',
  'SOPS_AGE_KEY',
  'enrollmentToken',
  'nodeSecret',
] as const;

/** Ways a secret ends up inside text; each returns the planted text. */
export const CONTEXTS: readonly ((secret: string) => string)[] = [
  (s) => `agent: request failed with ${s}`,
  (s) => `{"error":"denied","detail":"${s}"}`,
  (s) => `curl -H "X-Debug: ${s}" https://example.test/x`,
  (s) => `line one\nline two ${s} trailing\nline four`,
  (s) => `  - ${s}`,
  (s) => `https://example.test/hook?x=1#${s}`,
  (s) => `[${s}]`,
  (s) => `(${s})`,
];
