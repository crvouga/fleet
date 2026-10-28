import { hmacHex, safeEqual, sha256Hex } from '../auth/hash';

/** The file name the wizard looks for next to itself and in Downloads. */
export const BINDING_FILE = 'fleet-bind.json';
export const BINDING_VERSION = 1;

/**
 * Ties one downloaded installer to the controller that issued it. The signature
 * is an HMAC-SHA256 under a secret only this controller holds, so another
 * controller (or an edited file) fails verification. It carries the grant token,
 * so the file is a credential until the grant is used, expires or is revoked.
 */
export interface Binding {
  readonly v: typeof BINDING_VERSION;
  /** The issuing controller's origin; the wizard talks to no other. */
  readonly origin: string;
  readonly grant: string;
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Names the controller secret that signed it; lets the secret be replaced later. */
  readonly keyId: string;
  readonly sig: string;
}

export interface BindingKey {
  readonly keyId: string;
  readonly secret: string;
}

export type BindingFields = Omit<Binding, 'sig' | 'keyId' | 'v'>;

export function keyIdOf(secret: string): string {
  return sha256Hex(`fleet-bind-key:${secret}`).slice(0, 12);
}

function canonical(b: Omit<Binding, 'sig'>): string {
  return [
    'fleet-bind',
    `v${b.v}`,
    b.origin,
    b.grantId,
    b.grant,
    b.issuedAt,
    b.expiresAt,
    b.keyId,
  ].join('\n');
}

export function signBinding(key: BindingKey, fields: BindingFields): Binding {
  const unsigned = {
    v: BINDING_VERSION,
    origin: fields.origin,
    grant: fields.grant,
    grantId: fields.grantId,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    keyId: key.keyId,
  } as const;
  return { ...unsigned, sig: hmacHex(key.secret, canonical(unsigned)) };
}

const FIELD = /^[\x21-\x7e]{1,600}$/;
const TEXT_FIELDS = [
  'origin',
  'grant',
  'grantId',
  'issuedAt',
  'expiresAt',
  'keyId',
  'sig',
] as const;

/** A well-formed binding from untrusted JSON, else null. Does not check the signature. */
export function parseBinding(value: unknown): Binding | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const input = value as Record<string, unknown>;
  if (input['v'] !== BINDING_VERSION) return null;
  const out: Record<string, string> = {};
  for (const key of TEXT_FIELDS) {
    const field = input[key];
    if (typeof field !== 'string' || !FIELD.test(field)) return null;
    out[key] = field;
  }
  if (!/^[0-9a-f]{64}$/.test(out['sig'] ?? '')) return null;
  return { v: BINDING_VERSION, ...out } as unknown as Binding;
}

/** True only for a binding this controller's key signed, byte for byte. */
export function verifyBinding(key: BindingKey, binding: Binding): boolean {
  if (binding.keyId !== key.keyId) return false;
  const { sig, ...unsigned } = binding;
  return safeEqual(sig, hmacHex(key.secret, canonical(unsigned)));
}

/** An https origin, or loopback http for local testing; no path, query or credentials. */
export function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
      url.origin === value &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}
