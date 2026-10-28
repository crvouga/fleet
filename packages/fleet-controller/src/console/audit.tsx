/** @jsxImportSource react */
import {
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import type { AuditRow } from '../types';
import type { ConsoleState } from './model';
import { useJson } from './use-json';

interface AuditReply {
  entries: AuditRow[];
  nextBefore: number | null;
}

const OUTCOME_COLOR = { success: 'teal', denied: 'orange', failed: 'red' };

function Target({ entry }: { entry: AuditRow }) {
  if (entry.targetKind === 'node' && entry.targetId)
    return (
      <Anchor size="sm" href={`/nodes/${entry.targetId}`}>
        node {entry.targetId.slice(0, 8)}
      </Anchor>
    );
  return (
    <Text size="sm">
      {entry.targetKind}
      {entry.targetId ? ` ${entry.targetId.slice(0, 24)}` : ''}
    </Text>
  );
}

function AuditTable({ entries }: { entries: readonly AuditRow[] }) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Action</Table.Th>
            <Table.Th>Outcome</Table.Th>
            <Table.Th>Actor</Table.Th>
            <Table.Th>Target</Table.Th>
            <Table.Th>When</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => (
            <Table.Tr key={entry.id}>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {entry.action}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge color={OUTCOME_COLOR[entry.outcome]} variant="light">
                  {entry.outcome}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {entry.actor}
                  {entry.actorRole ? ` (${entry.actorRole})` : ''}
                </Text>
              </Table.Td>
              <Table.Td>
                <Target entry={entry} />
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {entry.at.toLocaleString()}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function AuditLog({ state }: { state: ConsoleState }) {
  const params = new URLSearchParams(window.location.search);
  const before = params.get('before');
  const list = useJson<AuditReply>(
    `/v1/audit?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`
  );
  if (state.role === 'viewer')
    return (
      <Stack>
        <PageHeading title="Audit log" description="Administrators only." />
        <Text c="dimmed">
          Your account can view the fleet but not its audit trail.
        </Text>
      </Stack>
    );
  const entries = list.data?.entries ?? [];
  return (
    <Stack>
      <PageHeading
        title="Audit log"
        description="Who did what, including refused and failed attempts. Newest first. Secrets are never recorded."
      />
      <ErrorNotice message={list.error} retry={list.reload} />
      <Paper withBorder p="lg">
        {list.data && entries.length === 0 ? (
          <Text c="dimmed">Nothing has been audited yet.</Text>
        ) : (
          <AuditTable entries={entries} />
        )}
        <Group justify="space-between" mt="md">
          <Button variant="subtle" component="a" href="/audit">
            Back to newest
          </Button>
          {list.data?.nextBefore && (
            <Button
              variant="default"
              component="a"
              href={`/audit?before=${list.data.nextBefore}`}
            >
              Older entries
            </Button>
          )}
        </Group>
      </Paper>
    </Stack>
  );
}
