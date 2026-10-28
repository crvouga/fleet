/** @jsxImportSource react */
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { CopyValue, ErrorNotice } from '@pkgs/admin-ui/components';
import type { Convergence, NodeView } from '../types';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { useAction } from './action';
import { AssignRole } from './role-select';
import { DesiredHistory } from './desired-history';
import { NodeCredential } from './node-credential';
import type { AnnotatedDesiredRow } from '../domain/desired-history';
import type { CredentialStatus } from '../domain/credential-rotation';

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

/** The secrets the operator re-encrypts for a node's next recipient. */
function roleSecretsLabel(role: NodeView['role']): string {
  return role === null ? 'its role secrets' : `the ${role} role secrets`;
}

/** The node's age recipient, a pending next one, and the rotate action. */
function AgeIdentity({
  view,
  action,
}: {
  view: NodeView;
  action: ReturnType<typeof useAction>;
}) {
  return (
    <Stack gap="xs">
      {view.ageRecipient === null ? (
        <Fact label="Age recipient" value={null} />
      ) : (
        <CopyValue label="Age recipient" value={view.ageRecipient} />
      )}
      {view.ageRecipientNext !== null && (
        <>
          <CopyValue label="Next age recipient" value={view.ageRecipientNext} />
          <Alert color="yellow" title="Rotation pending">
            Re-encrypt {roleSecretsLabel(view.role)} for the next recipient and
            merge. The node switches once it can decrypt them; remove the old
            recipient after it reports the new one.
          </Alert>
        </>
      )}
      <Group>
        <Button
          size="xs"
          variant="light"
          loading={action.busy}
          onClick={() =>
            action.run(`/nodes/${view.id}/recovery/rotate-age-key`, {})
          }
        >
          Rotate age identity
        </Button>
      </Group>
    </Stack>
  );
}

/** What Fleet wants this node to run against what it reports it runs. */
export function NodeDesiredState({
  entry,
  reload,
  history = [],
  credential,
  readOnly = false,
}: {
  entry: FleetEntry;
  reload: () => void;
  /** Desired-document history, newest first (from the console state). */
  history?: readonly AnnotatedDesiredRow[];
  credential?: CredentialStatus | null | undefined;
  /** A viewer sees the controls disabled. */
  readOnly?: boolean;
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
        <AgeIdentity view={view} action={action} />
        <NodeCredential
          view={view}
          credential={credential}
          action={action}
          readOnly={readOnly}
        />
        <DesiredHistory rows={history} />
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
