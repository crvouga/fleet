import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export type FlashKind = 'success' | 'error';
export interface Flash {
  readonly kind: FlashKind;
  readonly text: string;
}

const COOKIE = 'fleet_flash';
const MAX_TEXT = 300;

/** Remember a message for the next page view (no JavaScript needed). */
export function setFlash(c: Context, flash: Flash): void {
  const payload = JSON.stringify({
    kind: flash.kind,
    text: flash.text.slice(0, MAX_TEXT),
  });
  setCookie(c, COOKIE, encodeURIComponent(payload), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 60,
  });
}

/** The pending message, if any. Clears it so it shows once. */
export function takeFlash(c: Context): Flash | null {
  const raw = getCookie(c, COOKIE);
  if (raw === undefined) return null;
  deleteCookie(c, COOKIE, { path: '/' });
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { kind, text } = parsed as { kind?: unknown; text?: unknown };
    if (typeof text !== 'string' || (kind !== 'success' && kind !== 'error'))
      return null;
    return { kind, text };
  } catch {
    return null;
  }
}
