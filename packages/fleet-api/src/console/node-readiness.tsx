/** @jsxImportSource react */
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { integrationIssues, integrationReady } from '../domain/readiness';

export function NodeReadiness({ entry }: { entry: FleetEntry }) {
  const { view, facts } = entry;
  const issues = integrationIssues(view, facts);
  const known =
    facts.readinessIssues !== null && facts.readinessIssues !== undefined;
  const ready = integrationReady(view, facts);
  const label = ready ? 'Ready' : known ? 'Not ready' : 'Not yet verified';
  const report = JSON.stringify(
    {
      type: 'Fleet node diagnostic',
      node: view.id,
      hostname: view.hostname,
      role: view.role,
      readiness: label,
      membership: view.approval,
      connectivity: view.status,
      revision: view.revision,
      lastSeenAt: view.lastSeenAt?.toISOString() ?? null,
      failedUnits: facts.failedUnits,
      issues: known
        ? issues
        : [
            'The node has not reported integration readiness. Update its image.',
          ],
    },
    null,
    2
  );
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            Integration readiness
          </Title>
          <Badge color={ready ? 'teal' : 'orange'}>{label}</Badge>
        </Group>
        <Text size="sm">
          Ready requires a current approved report, verified automatic updates,
          and GitHub runners online for CI nodes. An online heartbeat alone does
          not establish readiness.
        </Text>
        {issues.map((issue, index) => (
          <Alert color="orange" key={`${index}:${issue}`}>
            {issue}
          </Alert>
        ))}
        <Group>
          <CopyButton value={report}>
            {({ copied, copy }) => (
              <Button variant="light" onClick={copy}>
                {copied ? 'Copied' : 'Copy diagnostic report'}
              </Button>
            )}
          </CopyButton>
        </Group>
        <details>
          <summary>Diagnostic details</summary>
          <Code block>{report}</Code>
        </details>
      </Stack>
    </Paper>
  );
}
