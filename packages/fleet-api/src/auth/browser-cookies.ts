import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { sha256Hex } from './hash';

export function browserCookies(origin: string) {
  const prefix = `fleet_${sha256Hex(origin).slice(0, 16)}`;
  const attributes = `Path=/; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`;
  const session = `${prefix}_session`;
  const binding = (state: string) =>
    `${prefix}_login_${sha256Hex(state).slice(0, 16)}`;
  return {
    read: (c: Context) => getCookie(c, session),
    readBinding: (c: Context, state: string) => getCookie(c, binding(state)),
    set(c: Context, value: string) {
      c.header(
        'Set-Cookie',
        `${session}=${value}; ${attributes}; Max-Age=43200`,
        { append: true }
      );
    },
    clear(c: Context) {
      c.header('Set-Cookie', `${session}=; ${attributes}; Max-Age=0`, {
        append: true,
      });
    },
    bind(c: Context, state: string, value: string) {
      c.header(
        'Set-Cookie',
        `${binding(state)}=${value}; ${attributes}; Max-Age=600`,
        { append: true }
      );
    },
    unbind(c: Context, state: string) {
      c.header('Set-Cookie', `${binding(state)}=; ${attributes}; Max-Age=0`, {
        append: true,
      });
    },
  };
}
