import { copyFile } from 'node:fs/promises';
for (const [source, target] of [
  ['standalone.css', 'admin.css'],
  ['standalone-theme.js', 'theme.js'],
]) {
  await copyFile(
    new URL(`./src/${source}`, import.meta.url),
    new URL(`../fleet/wizard/${target}`, import.meta.url)
  );
}
