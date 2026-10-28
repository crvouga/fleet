/** @jsxImportSource react */
import { Accordion, Badge, Table, Text } from '@mantine/core';
import {
  HARDWARE_MATRIX,
  TIER_MEANING,
  type HardwareTier,
} from '../enrollment/hardware-tiers';

const COLOR: Record<HardwareTier, string> = {
  supported: 'teal',
  'partially automated': 'yellow',
  unsupported: 'red',
};

function TierBadge({ tier }: { tier: HardwareTier }) {
  return (
    <Badge color={COLOR[tier]} variant="light">
      {tier}
    </Badge>
  );
}

/** What the wizard will say about a computer before it changes anything. */
export function HardwareTiers({ open = false }: { open?: boolean }) {
  return (
    <Accordion
      variant="separated"
      defaultValue={open ? 'tiers' : null}
      data-hardware-tiers
    >
      <Accordion.Item value="tiers">
        <Accordion.Control>Hardware support tiers</Accordion.Control>
        <Accordion.Panel>
          <Text size="sm" mb="sm">
            Before it changes anything the installer classifies the computer.
            Unsupported hardware is refused, not just warned about. Nodes need
            x86-64 UEFI; Apple silicon and ARM boards can still make install USB
            media.
          </Text>
          <Table withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Computer</Table.Th>
                <Table.Th>Becomes a node</Table.Th>
                <Table.Th>Makes install USB</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {HARDWARE_MATRIX.map((entry) => (
                <Table.Tr key={entry.platform}>
                  <Table.Td>{entry.platform}</Table.Td>
                  <Table.Td>
                    <TierBadge tier={entry.asNode} />
                  </Table.Td>
                  <Table.Td>
                    <TierBadge tier={entry.asMediaMaker} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed" mt="sm">
            {(Object.keys(TIER_MEANING) as HardwareTier[])
              .map((tier) => `${tier}: ${TIER_MEANING[tier]}`)
              .join(' ')}
          </Text>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
