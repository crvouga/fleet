/** Download each browser once; install OS packages only when a real launch needs them. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

type BrowserPackage = { directory: string; version: string };
type Result = { code: number; stderr: string };
type Execute = (args: string[]) => Result;
const probe = `const { chromium } = require(process.argv[1]);
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><p>CI browser validation</p>');
    await page.screenshot();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });`;
const missingLibraries =
  /error while loading shared libraries|cannot open shared object file|host system is missing dependencies|lib\S+\.so\S*.*not found/i;

function execute(args: string[]): Result {
  const result = spawnSync(args[0]!, args.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stderr: result.stderr ?? '' };
}

function requireSuccess(result: Result): void {
  if (result.code) throw new Error(`Chromium setup failed:\n${result.stderr}`);
}

export function installBrowsers(
  packages: BrowserPackage[],
  platform = process.platform,
  run: Execute = execute
): void {
  const installed = new Set<string>();
  for (const { directory, version } of packages) {
    if (!version) throw new Error('Missing Playwright version');
    if (installed.has(version)) continue;
    const cli = join(directory, 'cli.js');
    const launch = ['node', '-e', probe, directory];
    requireSuccess(run(['node', cli, 'install', '--only-shell', 'chromium']));
    const result = run(launch);
    if (
      result.code &&
      platform === 'linux' &&
      missingLibraries.test(result.stderr)
    ) {
      console.log(
        `Playwright ${version} needs system libraries; installing them`
      );
      requireSuccess(run(['node', cli, 'install-deps', 'chromium']));
      requireSuccess(run(launch));
    } else requireSuccess(result);
    installed.add(version);
    console.log(
      `Playwright ${version}: Chromium launches and renders successfully`
    );
  }
}

if (import.meta.main) {
  const packages = process.argv.slice(2).map((path) => {
    const directory = resolve(path);
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8')
    );
    if (typeof manifest.version !== 'string')
      throw new Error('Invalid Playwright manifest');
    return { directory, version: manifest.version };
  });
  if (!packages.length)
    throw new Error('Select at least one Playwright package');
  installBrowsers(packages);
}
