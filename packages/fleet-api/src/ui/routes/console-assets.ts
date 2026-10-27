import type { Hono } from 'hono';
const assets = ['console.js', 'console.css', 'theme-init.js'] as const;
export function registerConsoleAssets(app: Hono) {
  for (const name of assets)
    app.get(`/assets/${name}`, (c) => {
      c.header('Cache-Control', 'no-cache');
      return new Response(
        Bun.file(new URL(`../../../dist/${name}`, import.meta.url)),
        {
          headers: {
            'Content-Type': name.endsWith('.css')
              ? 'text/css'
              : 'text/javascript',
            'Cache-Control': 'no-cache',
          },
        }
      );
    });
}
