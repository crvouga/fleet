/** @jsxImportSource react */
import { Badge, Code, Group, Stack, Table, Text, Title } from '@mantine/core';
import type { AnnotatedDesiredRow } from '../domain/desired-history';

/** Why a desired document changed, in words. */
function causeLabel(cause: string | null): string {
  if (cause === null) return 'changed';
  if (cause === 'initial') return 'first document recorded';
  if (cause.startsWith('settings:'))
    return `settings saved (${cause.slice('settings:'.length)})`;
  return cause
    .split(',')
    .map((part) =>
      part === 'settings'
        ? 'settings changed'
        : part === 'role'
          ? 'role changed'
          : part === 'closure'
            ? 'closure changed'
            : part
    )
    .join(', ');
}

/** Every distinct desired document this node was told, newest first. A return to an earlier one is a rollback. */
export function DesiredHistory({
  rows,
}: {
  rows: readonly AnnotatedDesiredRow[];
}) {
  return (
    <Stack gap="xs">
      <Title order={3} size="h5">
        Desired-state history
      </Title>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing recorded yet. A row is added when the node is told a different
          desired document.
        </Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Revision</Table.Th>
              <Table.Th>Role / closure</Table.Th>
              <Table.Th>Why</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, index) => (
              <Table.Tr key={row.id}>
                <Table.Td>{row.at.toLocaleString()}</Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Code>{row.revision}</Code>
                    {index === 0 && <Badge size="xs">Current</Badge>}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {row.desired.role ?? 'no role'} /{' '}
                  {row.desired.closure ?? 'keep running'}
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Text size="sm">{causeLabel(row.cause)}</Text>
                    {row.revertsTo !== null && (
                      <Badge size="xs" color="orange" variant="light">
                        Rollback to #{row.revertsTo}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
