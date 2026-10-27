/** @jsxImportSource react */
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { PageHeading } from '@pkgs/admin-ui/components';
import type { ConsoleState } from './model';
import { ACTIVE_ROLES, ROLES } from '../types';
import type { Scope } from '../config/schema';
import { SettingsEditor } from './settings-editor';
import { useAction } from './action';
export function Settings({
  state,
  path,
  reload,
}: {
  state: ConsoleState;
  path: string;
  reload: () => void;
}) {
  const scope =
    path === '/settings' ? 'fleet' : path.slice('/settings/'.length);
  const valid =
    scope === 'fleet' ||
    ROLES.some((role) => scope === `role:${role}`) ||
    state.fleet.entries.some((entry) => scope === `node:${entry.view.id}`);
  if (!valid)
    return (
      <Alert color="yellow" title="Settings scope not found">
        Choose an existing fleet, role, or node scope.
      </Alert>
    );
  return (
    <Stack gap="lg">
      <PageHeading
        title="Settings"
        description="Runtime configuration. Fleet defaults flow into roles and individual nodes."
      />
      <Group>
        {['fleet', ...ACTIVE_ROLES.map((role) => `role:${role}`)].map(
          (item) => (
            <Button
              key={item}
              component="a"
              href={`/settings/${item}`}
              variant={scope === item ? 'filled' : 'default'}
              size="xs"
            >
              {item}
            </Button>
          )
        )}
      </Group>
      <Alert color="indigo" title={scope}>
        Empty values inherit from the fleet, then the role. Changes reach nodes
        on their next heartbeat.
      </Alert>
      <SettingsEditor
        key={scope}
        scope={scope as Scope}
        state={state}
        reload={reload}
      />
      <SettingsHistory state={state} scope={scope} reload={reload} />
    </Stack>
  );
}
function SettingsHistory({
  state,
  scope,
  reload,
}: {
  state: ConsoleState;
  scope: string;
  reload: () => void;
}) {
  const action = useAction(reload);
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Change history
        </Title>
        {action.error && <Alert color="red">{action.error}</Alert>}
        {action.success && <Alert color="teal">{action.success}</Alert>}
        {!state.history.length ? (
          <Text size="sm" c="dimmed">
            No changes have been saved for this scope yet.
          </Text>
        ) : (
          <Accordion variant="separated">
            {state.history.map((row, index) => (
              <HistoryVersion
                key={row.id}
                row={row}
                index={index}
                scope={scope}
                action={action}
              />
            ))}
          </Accordion>
        )}
        <Anchor href="/nodes" size="sm">
          Choose a node to edit its overrides
        </Anchor>
      </Stack>
    </Paper>
  );
}

function HistoryVersion({
  row,
  index,
  scope,
  action,
}: {
  row: ConsoleState['history'][number];
  index: number;
  scope: string;
  action: ReturnType<typeof useAction>;
}) {
  return (
    <Accordion.Item key={row.id} value={String(row.id)}>
      <Accordion.Control>
        <Group justify="space-between">
          <Text size="sm">
            {row.changedAt.toLocaleString()} · {row.changedBy ?? 'Unknown'}
          </Text>
          {index === 0 && <Badge size="xs">Current</Badge>}
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <Table>
            <Table.Tbody>
              {Object.entries(row.value).map(([section, values]) => (
                <Table.Tr key={section}>
                  <Table.Td>{section}</Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {JSON.stringify(values)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {index > 0 && (
            <Button
              variant="light"
              loading={action.busy}
              onClick={() =>
                action.run(`/settings/${scope}/restore`, {
                  historyId: String(row.id),
                })
              }
            >
              Restore this version
            </Button>
          )}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
