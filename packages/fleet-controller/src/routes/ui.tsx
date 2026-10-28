import type { Context, Hono } from 'hono';

import type { AppDeps } from '../deps';
import { script, stylesheet, type Asset } from '../ui/assets';
import { registerUiSecurity } from '../ui/routes/security';
import { registerConsoleState } from '../ui/routes/console-state';
import { registerConsoleAssets } from '../ui/routes/console-assets';
import { registerBrowser } from '../ui/routes/browser';
import { registerAccess } from '../ui/routes/access';
import { registerActions } from '../ui/routes/actions';
import { registerPages } from '../ui/routes/pages';
import { registerSettings } from '../ui/routes/settings';

function serve(c: Context, asset: Asset, type: string): Response {
  if (c.req.header('if-none-match') === asset.etag) return c.body(null, 304);
  c.header('Content-Type', type);
  c.header('ETag', asset.etag);
  c.header('Cache-Control', 'public, no-cache');
  return c.body(asset.body);
}

/**
 * Mounts the dashboard: pages, forms, the stylesheet and the small script.
 * Every page needs a signed-in person; every form checks the request's origin.
 */
export function mountUi(app: Hono, deps: AppDeps): void {
  registerUiSecurity(app);
  app.get('/assets/app.css', async (c) => {
    const css = await stylesheet();
    return css === null
      ? c.text('The stylesheet is not built. Run: bun run build:css', 503)
      : serve(c, css, 'text/css; charset=utf-8');
  });
  app.get('/assets/app.js', (c) =>
    serve(c, script, 'text/javascript; charset=utf-8')
  );
  registerConsoleAssets(app);
  registerConsoleState(app, deps);
  registerBrowser(app, deps);
  registerAccess(app, deps);
  registerActions(app, deps);
  registerPages(app, deps);
  registerSettings(app, deps);
}
