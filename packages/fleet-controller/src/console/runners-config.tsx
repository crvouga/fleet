/** @jsxImportSource react */
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import {
  formatRequirements,
  lines,
  parseRequirements,
  sendJson,
  type Check,
  type IntegrationData,
} from './runners-api';

interface Draft {
  scope: 'repository' | 'organization';
  organization: string;
  repositories: string;
  runnerGroup: string;
  appId: string;
  installationId: string;
  labels: string;
  maxNodes: number;
  requirements: string;
  autoRemove: boolean;
  grace: number;
  interval: number;
  queueStall: number;
  noRunners: number;
  registrationFailing: number;
}

function draftOf(value: IntegrationData): Draft {
  return {
    scope: value.scope,
    organization: value.organization,
    repositories: value.repositories.join('\n'),
    runnerGroup: value.runnerGroup ?? '',
    appId: value.appId,
    installationId: value.installationId,
    labels: value.policy.extraLabels.join(', '),
    maxNodes: value.policy.maxNodesPerRepository,
    requirements: formatRequirements(value.policy.repositoryRequirements),
    autoRemove: value.policy.orphanAutoRemoval,
    grace: value.policy.orphanGraceSeconds,
    interval: value.policy.syncIntervalSeconds,
    queueStall: value.policy.queueStallMinutes,
    noRunners: value.policy.noRunnersMinutes,
    registrationFailing: value.policy.registrationFailingMinutes,
  };
}

function bodyOf(draft: Draft) {
  return {
    scope: draft.scope,
    organization: draft.organization.trim(),
    repositories: lines(draft.repositories),
    runnerGroup:
      draft.runnerGroup.trim() === '' ? null : draft.runnerGroup.trim(),
    appId: draft.appId.trim(),
    installationId: draft.installationId.trim(),
    policy: {
      extraLabels: lines(draft.labels),
      maxNodesPerRepository: draft.maxNodes,
      repositoryRequirements: parseRequirements(draft.requirements),
      orphanAutoRemoval: draft.autoRemove,
      orphanGraceSeconds: draft.grace,
      syncIntervalSeconds: draft.interval,
      queueStallMinutes: draft.queueStall,
      noRunnersMinutes: draft.noRunners,
      registrationFailingMinutes: draft.registrationFailing,
    },
  };
}

type Patch = (change: Partial<Draft>) => void;

function Target({
  draft,
  patch,
  disabled,
}: {
  draft: Draft;
  patch: Patch;
  disabled: boolean;
}) {
  return (
    <Stack>
      <SegmentedControl
        aria-label="Scope"
        disabled={disabled}
        value={draft.scope}
        onChange={(scope) => patch({ scope: scope as Draft['scope'] })}
        data={[
          { value: 'repository', label: 'Repositories' },
          { value: 'organization', label: 'Organization' },
        ]}
      />
      <Group grow align="flex-start">
        <TextInput
          label="GitHub App ID"
          disabled={disabled}
          value={draft.appId}
          onChange={(e) => patch({ appId: e.currentTarget.value })}
        />
        <TextInput
          label="Installation ID"
          disabled={disabled}
          value={draft.installationId}
          onChange={(e) => patch({ installationId: e.currentTarget.value })}
        />
      </Group>
      {draft.scope === 'organization' ? (
        <Group grow align="flex-start">
          <TextInput
            label="Organization"
            disabled={disabled}
            value={draft.organization}
            onChange={(e) => patch({ organization: e.currentTarget.value })}
          />
          <TextInput
            label="Runner group"
            description="Optional"
            disabled={disabled}
            value={draft.runnerGroup}
            onChange={(e) => patch({ runnerGroup: e.currentTarget.value })}
          />
        </Group>
      ) : null}
      <Textarea
        label={
          draft.scope === 'organization'
            ? 'Repositories to monitor (optional)'
            : 'Repositories'
        }
        description="One owner/name per line. The App must be installed on each."
        disabled={disabled}
        minRows={3}
        autosize
        value={draft.repositories}
        onChange={(e) => patch({ repositories: e.currentTarget.value })}
      />
    </Stack>
  );
}

function HealthThresholds({
  draft,
  patch,
  disabled,
}: {
  draft: Draft;
  patch: Patch;
  disabled: boolean;
}) {
  return (
    <Group grow align="flex-start">
      <NumberInput
        label="Queue stalled after (minutes)"
        description="A queued job waiting this long with no idle runner opens an incident."
        min={1}
        max={1440}
        disabled={disabled}
        value={draft.queueStall}
        onChange={(v) => patch({ queueStall: Number(v) || 10 })}
      />
      <NumberInput
        label="No runners online after (minutes)"
        description="No online runner while a CI node reports."
        min={1}
        max={1440}
        disabled={disabled}
        value={draft.noRunners}
        onChange={(v) => patch({ noRunners: Number(v) || 10 })}
      />
      <NumberInput
        label="Registration failing after (minutes)"
        description="A node reports it cannot register runners."
        min={1}
        max={1440}
        disabled={disabled}
        value={draft.registrationFailing}
        onChange={(v) => patch({ registrationFailing: Number(v) || 5 })}
      />
    </Group>
  );
}

function Policy({
  draft,
  patch,
  disabled,
}: {
  draft: Draft;
  patch: Patch;
  disabled: boolean;
}) {
  return (
    <Stack>
      <Title order={3} size="h5">
        Policy
      </Title>
      <TextInput
        label="Extra runner labels"
        description="Added to every CI node's runners that no setting overrides."
        disabled={disabled}
        value={draft.labels}
        onChange={(e) => patch({ labels: e.currentTarget.value })}
      />
      <Textarea
        label="Repository requirements"
        description="owner/name: gpu, high-mem. Only nodes with these capabilities or labels serve it."
        disabled={disabled}
        autosize
        minRows={2}
        value={draft.requirements}
        onChange={(e) => patch({ requirements: e.currentTarget.value })}
      />
      <Group grow align="flex-start">
        <NumberInput
          label="Nodes per repository"
          description="0 means every eligible node"
          min={0}
          max={1000}
          disabled={disabled}
          value={draft.maxNodes}
          onChange={(v) => patch({ maxNodes: Number(v) || 0 })}
        />
        <NumberInput
          label="Sync every (seconds)"
          min={15}
          max={3600}
          disabled={disabled}
          value={draft.interval}
          onChange={(v) => patch({ interval: Number(v) || 60 })}
        />
      </Group>
      <Switch
        label="Remove orphan runners automatically"
        description="Never removes a runner that is busy."
        disabled={disabled}
        checked={draft.autoRemove}
        onChange={(e) => patch({ autoRemove: e.currentTarget.checked })}
      />
      <NumberInput
        label="Orphan grace period (seconds)"
        min={60}
        max={2592000}
        disabled={disabled}
        value={draft.grace}
        onChange={(v) => patch({ grace: Number(v) || 1800 })}
      />
      <HealthThresholds draft={draft} patch={patch} disabled={disabled} />
    </Stack>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  return (
    <Stack gap="xs">
      {checks.map((check) => (
        <Alert
          key={check.name}
          color={check.ok ? 'teal' : 'red'}
          title={
            check.ok
              ? check.name
              : `${check.name}${check.code ? ` (${check.code})` : ''}`
          }
        >
          {check.message}
        </Alert>
      ))}
    </Stack>
  );
}

function useActions(draft: Draft, reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [checks, setChecks] = useState<Check[] | null>(null);
  async function run(task: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await task() });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : 'The request failed.',
      });
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    run(async () => {
      await sendJson('PUT', '/v1/github/integration', bodyOf(draft));
      reload();
      return 'Saved. The next sync uses these settings.';
    });
  const verify = () =>
    run(async () => {
      const result = await sendJson<{ ok: boolean; checks: Check[] }>(
        'POST',
        '/v1/github/verify'
      );
      setChecks(result.checks);
      reload();
      return result.ok
        ? 'GitHub accepted every check.'
        : 'GitHub refused at least one check.';
    });
  return {
    busy,
    message,
    checks,
    save: () => void save(),
    verify: () => void verify(),
  };
}

export function IntegrationForm(props: {
  value: IntegrationData;
  canEdit: boolean;
  keyConfigured: boolean;
  reload: () => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(props.value));
  const patch: Patch = (change) => setDraft((old) => ({ ...old, ...change }));
  const actions = useActions(draft, props.reload);
  const { message } = actions;
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Connect GitHub
        </Title>
        {!props.canEdit ? (
          <Text size="sm" c="dimmed">
            Only administrators can change these settings.
          </Text>
        ) : null}
        <Target draft={draft} patch={patch} disabled={!props.canEdit} />
        <Policy draft={draft} patch={patch} disabled={!props.canEdit} />
        {message ? (
          <Alert
            color={message.ok ? 'teal' : 'red'}
            role={message.ok ? 'status' : 'alert'}
          >
            {message.text}
          </Alert>
        ) : null}
        <Group>
          <Button
            onClick={actions.save}
            loading={actions.busy}
            disabled={!props.canEdit}
          >
            Save
          </Button>
          <Button
            variant="default"
            onClick={actions.verify}
            loading={actions.busy}
            disabled={!props.canEdit || !props.keyConfigured}
          >
            Verify connection
          </Button>
        </Group>
        {actions.checks ? <Checks checks={actions.checks} /> : null}
      </Stack>
    </Paper>
  );
}
