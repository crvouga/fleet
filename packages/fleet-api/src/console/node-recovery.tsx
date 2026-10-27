/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import type { EventRow } from '../types';
import type { FleetEntry } from '../ui/lib/fleet-data';
import {
  recoveryView,
  type RecoveryAction,
  type RecoveryItem,
  type RecoveryTone,
} from '../domain/recovery';
import { useAction } from './action';

const COLORS: Readonly<Record<RecoveryTone, string>> = {
  ok: 'teal',
  warn: 'yellow',
  error: 'red',
  muted: 'gray',
};

const BADGES = {
  ok: ['Nothing to recover', 'teal'],
  recovered: ['Recovered', 'yellow'],
  attention: ['Needs a decision', 'red'],
  unknown: ['Not reported', 'gray'],
} as const;

const ACTIONS: Readonly<
  Record<RecoveryAction, { path: string; label: string }>
> = {
  'retry-update': { path: 'retry-update', label: 'Retry the update' },
  'reopen-admission': {
    path: 'reopen-admission',
    label: 'Reopen runner admission',
  },
};

/** What the node recovered from and what still needs a person (domain/recovery.ts). */
export function NodeRecovery({
  entry,
  events,
  now,
  reload,
}: {
  entry: FleetEntry;
  events: readonly EventRow[];
  now: Date;
  reload: () => void;
}) {
  const action = useAction(reload);
  const view = recoveryView(entry.view.facts, events, now, entry.view.role);
  const [label, color] = BADGES[view.state];
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            Recovery
          </Title>
          <Badge color={color} variant="light">
            {label}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {view.summary} Interrupted CI jobs are never re-run automatically:
          only a person knows whether repeating one is safe.
        </Text>
        <ErrorNotice message={action.error} />
        {action.success && <Alert color="teal">{action.success}</Alert>}
        {view.items.map((item, index) => (
          <RecoveryLine
            key={`${item.label}-${index}`}
            item={item}
            busy={action.busy}
            run={() =>
              item.action &&
              action.run(
                `/nodes/${entry.view.id}/recovery/${ACTIONS[item.action].path}`,
                {}
              )
            }
          />
        ))}
      </Stack>
    </Paper>
  );
}

function RecoveryLine({
  item,
  busy,
  run,
}: {
  item: RecoveryItem;
  busy: boolean;
  run: () => void;
}) {
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Badge color={COLORS[item.tone]} variant="dot">
          {item.label}
        </Badge>
      </Group>
      <Text size="sm">{item.detail}</Text>
      {item.link && (
        <Anchor size="sm" href={item.link} target="_blank" rel="noreferrer">
          Open the run on GitHub
        </Anchor>
      )}
      {item.action && (
        <Group>
          <Button size="xs" variant="light" loading={busy} onClick={run}>
            {ACTIONS[item.action].label}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
