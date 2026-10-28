import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { HARDWARE_MATRIX } from '../../src/enrollment/hardware-tiers';

const FLEET = new URL('../../../fleet/', import.meta.url);
const TIERS: Record<string, string> = {
  TIER_SUPPORTED: 'supported',
  TIER_PARTIAL: 'partially automated',
  TIER_UNSUPPORTED: 'unsupported',
};

/** The rows of HARDWARE_MATRIX as the installer's Python source states them. */
function pythonMatrix(): [string, string, string][] {
  const source = readFileSync(new URL('scripts/decide.py', FLEET), 'utf8');
  const block = source.split('HARDWARE_MATRIX = (')[1]!.split('\n)\n')[0]!;
  return [...block.matchAll(/\("([^"]+)", (TIER_\w+), (TIER_\w+)\)/g)].map(
    (m) => [m[1]!, TIERS[m[2]!]!, TIERS[m[3]!]!]
  );
}

describe('hardware tier matrix', () => {
  test('the Add node page shows exactly what the installer enforces', () => {
    expect(
      HARDWARE_MATRIX.map((row) => [row.platform, row.asNode, row.asMediaMaker])
    ).toEqual(pythonMatrix());
  });

  test('installer.md and hardware.md carry the same rows', () => {
    for (const name of ['installer.md', 'hardware.md']) {
      const text = readFileSync(new URL(`docs/${name}`, FLEET), 'utf8');
      const block = text
        .split('<!-- hardware-matrix:start -->')[1]!
        .split('<!-- hardware-matrix:end -->')[0]!;
      // Prettier pads table cells, so compare cell contents, not raw text.
      const rows = block
        .split('\n')
        .filter((line) => line.startsWith('|'))
        .map((line) =>
          line
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim())
            .join(' | ')
        );
      for (const row of HARDWARE_MATRIX)
        expect(rows).toContain(
          `${row.platform} | ${row.asNode} | ${row.asMediaMaker}`
        );
    }
  });
});
