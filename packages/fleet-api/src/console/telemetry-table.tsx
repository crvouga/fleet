/** @jsxImportSource react */
import type { ReactNode } from 'react';
import { Paper, Stack, Table, Text, Title } from '@mantine/core';
export function TelemetryTable({
  title,
  columns,
  rows,
  empty = 'Unavailable: this node has not reported this measurement.',
}: {
  title: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  empty?: string;
}) {
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={3} size="h5">
          {title}
        </Title>
        {rows.length ? (
          <Table.ScrollContainer minWidth={480}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  {columns.map((column) => (
                    <Table.Th key={column}>{column}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row, index) => (
                  <Table.Tr key={index}>
                    {row.map((value, cell) => (
                      <Table.Td key={cell}>{value ?? 'Unavailable'}</Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Text size="sm" c="dimmed">
            {empty}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
