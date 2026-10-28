/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  INSTALLER_PHASES,
  installerProgress,
  type InstallerProgress,
} from '../enrollment/installer-progress';
import { relativeTime } from '../ui/lib/format';
import type { NodeView } from '../types';
import type { ConsoleState } from './model';

const TITLES: Record<string, string> = {
  network: 'Connecting to the network',
  approval: 'Waiting for approval',
  checks: 'Checking this computer',
  disk: 'Choosing the disk',
  erase: 'Erasing the disk',
  install: 'Installing the base system',
  unknown: 'Installing',
};

/** Installations that have reported, with the phase, the last error and what to do about it. */
export function InstallerProgressPanel({ state }: { state: ConsoleState }) {
  const rows = state.fleet.entries
    .map(({ view }) => ({
      view,
      progress: installerProgress(view, state.fleet.now),
    }))
    .filter(
      (row): row is { view: NodeView; progress: InstallerProgress } =>
        row.progress !== null
    );
  if (rows.length === 0) return null;
  return (
    <Stack gap="md" data-installer-progress>
      <Title order={2} size="h4">
        Installations in progress ({rows.length})
      </Title>
      {rows.map(({ view, progress }) => (
        <ProgressCard
          key={view.id}
          view={view}
          progress={progress}
          now={state.fleet.now}
        />
      ))}
    </Stack>
  );
}

function ProgressBadges({ progress }: { progress: InstallerProgress }) {
  return (
    <Group gap="xs">
      <Badge variant="light">
        {progress.step === null
          ? 'Installing'
          : `Step ${progress.step} of ${INSTALLER_PHASES.length}`}
      </Badge>
      {progress.failed && <Badge color="red">Failed</Badge>}
      {progress.stale && <Badge color="yellow">No recent report</Badge>}
    </Group>
  );
}

function NextStep({
  id,
  progress,
}: {
  id: string;
  progress: InstallerProgress;
}) {
  if (!progress.nextStep) return null;
  return (
    <Alert
      color={progress.failed ? 'red' : 'yellow'}
      title={progress.failed ? 'What to do' : 'No recent report'}
    >
      {progress.nextStep}{' '}
      <Anchor href={`/report-issue?kind=installer&node=${id}`}>
        Report this problem
      </Anchor>
    </Alert>
  );
}

function barColor(progress: InstallerProgress): string {
  if (progress.failed) return 'red';
  return progress.stale ? 'yellow' : 'blue';
}

function ProgressCard({
  view,
  progress,
  now,
}: {
  view: NodeView;
  progress: InstallerProgress;
  now: Date;
}) {
  const percent =
    progress.step === null
      ? 0
      : Math.round((progress.step / INSTALLER_PHASES.length) * 100);
  return (
    <Paper withBorder p="lg">
      <Stack gap="xs">
        <Group justify="space-between">
          <Anchor fw={600} href={`/nodes/${view.id}`}>
            {view.label}
          </Anchor>
          <ProgressBadges progress={progress} />
        </Group>
        <Progress
          value={percent}
          color={barColor(progress)}
          aria-label={`Installation progress: ${TITLES[progress.phase]}`}
        />
        <Text size="sm">
          {TITLES[progress.phase]}. Last report{' '}
          {relativeTime(view.lastSeenAt, now)}.
          {progress.nothingErased && ' Nothing has been erased yet.'}
        </Text>
        {progress.message && (
          <Text size="xs" ff="monospace" c="dimmed">
            {progress.code}: {progress.message}
          </Text>
        )}
        <NextStep id={view.id} progress={progress} />
      </Stack>
    </Paper>
  );
}
