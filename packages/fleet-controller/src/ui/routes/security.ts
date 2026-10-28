import type { Hono } from 'hono';
import { NONCE, secureHeaders } from 'hono/secure-headers';
export function registerUiSecurity(app: Hono) {
  app.use(
    '*',
    secureHeaders({
      referrerPolicy: 'same-origin',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", NONCE],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
    })
  );
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.get('content-type')?.includes('text/html')) return;
    const html = await c.res.text();
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(
      html.replace(
        '<head>',
        `<head><meta name="csp-nonce" content="${c.get('secureHeadersNonce') ?? ''}">`
      ),
      { status: c.res.status, headers }
    );
  });
}
