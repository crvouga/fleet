import { expect, test } from 'bun:test';
import { installBrowsers } from './install-browsers';

const packages = [
  { directory: '/fixture/first', version: '1' },
  { directory: '/fixture/second', version: '1' },
  { directory: '/fixture/third', version: '2' },
];

test('matching versions share a download and real render probe without unnecessary OS updates', () => {
  const calls: string[][] = [];
  installBrowsers(packages, 'linux', (args) => {
    calls.push(args);
    return { code: 0, stderr: '' };
  });
  expect(calls).toHaveLength(4);
  expect(calls.filter((args) => args.includes('install'))).toHaveLength(2);
  expect(
    calls.some(
      (args) => args.includes('install-deps') || args.includes('--with-deps')
    )
  ).toBe(false);
  expect(calls.filter((args) => args[1] === '-e')).toHaveLength(2);
});

test('missing Linux libraries require successful dependency installation and a second successful render', () => {
  const calls: string[][] = [];
  let repaired = false;
  installBrowsers(packages.slice(0, 1), 'linux', (args) => {
    calls.push(args);
    if (args.includes('install-deps')) repaired = true;
    return args[1] === '-e' && !repaired
      ? { code: 1, stderr: 'error while loading shared libraries: libX.so' }
      : { code: 0, stderr: '' };
  });
  expect(calls).toHaveLength(4);
  expect(calls[2]).toContain('install-deps');
  expect(calls[3]?.[1]).toBe('-e');
  expect(() =>
    installBrowsers(packages.slice(0, 1), 'linux', () => ({
      code: 1,
      stderr: 'download failed',
    }))
  ).toThrow();
});

test('unexpected launch failures and non-Linux failures stay failures', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as const) {
    const calls: string[][] = [];
    expect(() =>
      installBrowsers(packages.slice(0, 1), platform, (args) => {
        calls.push(args);
        return { code: args[1] === '-e' ? 1 : 0, stderr: 'browser crashed' };
      })
    ).toThrow('browser crashed');
    expect(calls.some((args) => args.includes('install-deps'))).toBe(false);
  }
});

test('Windows missing-library errors never trigger media-feature installation', () => {
  const calls: string[][] = [];
  expect(() =>
    installBrowsers(packages.slice(0, 1), 'win32', (args) => {
      calls.push(args);
      return {
        code: args[1] === '-e' ? 1 : 0,
        stderr: 'error while loading shared libraries',
      };
    })
  ).toThrow();
  expect(calls.some((args) => args.includes('install-deps'))).toBe(false);
});
