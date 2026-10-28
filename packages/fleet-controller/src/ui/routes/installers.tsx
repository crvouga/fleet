/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { AppDeps } from '../../deps';
import { INSTALLERS } from '../lib/installers';
import { page } from './guard';
import { registerInstallerAssets } from './installer-assets';

/** Fleet owns installer distribution and guides; no repository is consulted. */
export function registerInstallers(app: Hono, deps: AppDeps): void {
  registerInstallerAssets(app, deps);
  app.get(
    '/installers/release',
    page(deps, async (c) =>
      c.html(
        <html lang="en">
          <head>
            <title>Fleet installers</title>
          </head>
          <body>
            <h1>Fleet installers</h1>
            <p>
              These files are published by this Fleet app. Verify the SHA-256
              checksum before opening an installer.
            </p>
            <ul>
              {INSTALLERS.map((item) => (
                <li key={item.id}>
                  <a href={`/installers/assets/${item.file}`}>{item.label}</a> ·{' '}
                  <a href={`/installers/assets/${item.file}.sha256`}>SHA-256</a>
                </li>
              ))}
            </ul>
            <p>
              <a href="/installers/assets/fleet-node.sh">
                Command-line installer
              </a>
            </p>
            <p>
              <a href="/add">Back to Add node</a>
            </p>
          </body>
        </html>
      )
    )
  );
  for (const path of ['/installers/windows-guide', '/installers/nixos-guide'])
    app.get(
      path,
      page(deps, async (c) =>
        c.text(
          await Bun.file(
            new URL('../../../../fleet/docs/installer.md', import.meta.url)
          ).text()
        )
      )
    );
  app.get(
    '/installers/download/:file',
    page(deps, async (c) => {
      const file = c.req.param('file');
      if (!INSTALLERS.some((installer) => installer.file === file))
        return c.notFound();
      return c.redirect(`/installers/assets/${file}`);
    })
  );
  app.get(
    '/installers/nixos',
    page(deps, async (c) =>
      c.text(
        'On an existing Fleet node run: sudo fleet-installer --no-browser\n\nFor a fresh NixOS machine, build this application checkout with:\nnix build ./packages/fleet#fleet-installer\nsudo ./result/bin/fleet-installer --no-browser\n\nEnter this Fleet app address in the installer. Approval happens under Pending in Fleet; disk confirmation is required.\n'
      )
    )
  );
}
