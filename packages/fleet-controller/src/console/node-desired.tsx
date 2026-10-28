/** @jsxImportSource react */
import {
  Alert,
  Badge,
  Code,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { CopyValue, ErrorNotice } from '@pkgs/admin-ui/components';
import type { Convergence } from '../types';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { useAction } from './action';
import { AssignRole } from './role-select';

const CONVERGENCE: Record<Convergence, [string, string]> = {
  converged: ['Converged', 'teal'],
  progressing: ['Converging', 'indigo'],
  blocked: ['Blocked', 'red'],
  unknown: ['Not reported', 'gray'],
};

export function ConvergenceBadge({
  convergence,
}: {
  convergence: Convergence;
}) {
  const [label, color] = CONVERGENCE[convergence];
  return (
    <Badge color={color} variant="light">
      {label}
    </Badge>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <Stack gap={3}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {value === null ? (
        <Text size="sm" c="dimmed">
          Not reported
        </Text>
      ) : (
        <Code>{value}</Code>
      )}
    </Stack>
  );
}

/** What Fleet wants this node to run against what it reports it runs. */
export function NodeDesiredState({
  entry,
  reload,
}: {
  entry: FleetEntry;
  reload: () => void;
}) {
  const { view } = entry;
  const action = useAction(reload);
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Role and desired state
        </Title>
        <AssignRole id={view.id} current={view.role} action={action} />
        <ErrorNotice message={action.error} />
        {action.success && (
          <Alert color="teal" role="status">
            {action.success}
          </Alert>
        )}
        <ConvergenceBadge convergence={view.convergence} />
        <SimpleGrid cols={2}>
          <Fact label="Running role" value={view.observedRole} />
          <Fact
            label="Desired closure"
            value={view.desiredClosure ?? 'keep the running system'}
          />
          <Fact label="Running closure" value={view.observedClosure} />
          <Fact
            label="Hardware"
            value={view.hardwareCapabilities.join(', ') || 'nothing detected'}
          />
          <Fact label="Desired revision" value={view.desiredRevision} />
          <Fact label="Applied revision" value={view.appliedRevision} />
        </SimpleGrid>
        {view.ageRecipient === null ? (
          <Fact label="Age recipient" value={null} />
        ) : (
          <CopyValue label="Age recipient" value={view.ageRecipient} />
        )}
        {view.reconcileIssues.length > 0 && (
          <Alert color="orange" title="What blocks convergence">
            <List size="sm">
              {view.reconcileIssues.map((issue) => (
                <List.Item key={issue}>{issue}</List.Item>
              ))}
            </List>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}
