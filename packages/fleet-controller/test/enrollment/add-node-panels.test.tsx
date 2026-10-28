/** @jsxImportSource react */
import { expect, test } from 'bun:test';
import { MantineProvider } from '@mantine/core';
import { renderToStaticMarkup } from 'react-dom/server';

import { AddNode } from '../../src/console/add-node';
import { HardwareTiers } from '../../src/console/hardware-tiers';
import { HARDWARE_MATRIX } from '../../src/enrollment/hardware-tiers';

function render() {
  return renderToStaticMarkup(
    <MantineProvider>
      <AddNode />
    </MantineProvider>
  );
}

test('Add node offers the installer binding with a person-approved default', () => {
  const html = render();
  expect(html).toContain('Bind the installer to this app');
  expect(html).toContain('fleet-bind.json');
  expect(html).toContain('None: a person approves it (recommended)');
  expect(html).toContain('ci: approve automatically');
  expect(html).toContain('7 days (longest)');
  expect(html).toContain('24 hours (default)');
});

test('Add node carries the hardware tiers panel', () => {
  expect(render()).toContain('Hardware support tiers');
});

test('the tiers panel lists every row the installer enforces', () => {
  const html = renderToStaticMarkup(
    <MantineProvider>
      <HardwareTiers open />
    </MantineProvider>
  );
  for (const row of HARDWARE_MATRIX)
    expect(html).toContain(row.platform.replaceAll('&', '&amp;'));
  for (const tier of ['supported', 'partially automated', 'unsupported'])
    expect(html).toContain(tier);
});
