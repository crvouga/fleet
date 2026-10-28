/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  NativeSelect,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import { ACTIVE_ROLES } from '../types';
import { relativeTime } from '../ui/lib/format';
import { sendJson } from './runners-api';
import { useJson } from './use-json';
import { ConfirmDialog } from './typed-confirm';

interface GrantRecord {
  id: string;
  role: string | null;
  label: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByNode: string | null;
  revokedAt: string | null;
  state: 'pending' | 'used' | 'expired' | 'revoked';
}

interface Issued {
  grant: GrantRecord;
  binding: Record<string, string>;
  file: string;
}

const STATE_COLOR = {
  pending: 'blue',
  used: 'teal',
  expired: 'gray',
  revoked: 'red',
} as const;

const TTL = [
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '24 hours (default)' },
  { value: '259200', label: '3 days' },
  { value: '604800', label: '7 days (longest)' },
];

function download(name: string, content: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(content, null, 2) + '\n'], {
      type: 'application/json',
    })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Request failed.';
}

function IssueForm({ onIssued }: { onIssued: (issued: Issued) => void }) {
  const [role, setRole] = useState('');
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState('86400');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await sendJson<Issued>('POST', '/v1/enrollment/grants', {
        role: role === '' ? null : role,
        label: label.trim() === '' ? null : label.trim(),
        ttlSeconds: Number(ttl),
      });
      download(result.file, result.binding);
      setLabel('');
      onIssued(result);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="sm">
      <Group align="flex-end" wrap="wrap">
        <TextInput
          label="Label"
          placeholder="Rack 3 spare"
          maxLength={80}
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        <NativeSelect
          label="Valid for"
          value={ttl}
          onChange={(event) => setTtl(event.currentTarget.value)}
          data={TTL}
        />
        <NativeSelect
          label="Role"
          value={role}
          onChange={(event) => setRole(event.currentTarget.value)}
          data={[
            { value: '', label: 'None: a person approves it (recommended)' },
            ...ACTIVE_ROLES.map((entry) => ({
              value: entry,
              label: `${entry}: approve automatically`,
            })),
          ]}
        />
        <Button loading={busy} onClick={() => void create()}>
          Create and download fleet-bind.json
        </Button>
      </Group>
      {role !== '' && (
        <Alert color="yellow">
          With a role, whoever holds the file before it is used can enroll one
          machine as <b>{role}</b> without approval. Keep it private, use a
          short validity, and revoke it below if it leaks.
        </Alert>
      )}
      <ErrorNotice message={error} />
    </Stack>
  );
}

/**
 * One single-use, expiring grant per download. The file it produces carries the
 * grant, so it is shown once and never stored by the controller.
 */
export function InstallerBinding() {
  const grants = useJson<{ grants: GrantRecord[] }>(
    '/v1/enrollment/grants?limit=25'
  );
  const [issued, setIssued] = useState<Issued | null>(null);
  return (
    <Stack gap="md" id="installer-binding">
      <Title order={2} size="h4">
        Bind the installer to this app
      </Title>
      <Text size="sm" c="dimmed">
        Create a single-use enrollment grant and save{' '}
        <code>fleet-bind.json</code> next to the installer you download (or in
        Downloads). The installer then talks only to this app and enrolls
        without anyone copying a token. The grant works once and expires; a copy
        of the file cannot enroll a second machine.
      </Text>
      <IssueForm
        onIssued={(result) => {
          setIssued(result);
          grants.reload();
        }}
      />
      {issued && (
        <Alert color="teal" title="fleet-bind.json downloaded">
          Put it in the same folder as the installer (or leave it in Downloads).
          It contains a single-use credential: do not share or commit it. This
          app keeps only a hash, so a lost file cannot be shown again; revoke
          the grant and create another.{' '}
          <Anchor
            component="button"
            type="button"
            onClick={() => download(issued.file, issued.binding)}
          >
            Download again
          </Anchor>
        </Alert>
      )}
      <GrantTable
        grants={grants.data?.grants ?? []}
        error={grants.error}
        reload={grants.reload}
      />
    </Stack>
  );
}

function GrantRow({
  grant,
  now,
  onRevoke,
}: {
  grant: GrantRecord;
  now: Date;
  onRevoke: (grant: GrantRecord) => void;
}) {
  const revocable = grant.state === 'pending' || grant.state === 'used';
  return (
    <Table.Tr>
      <Table.Td>{grant.label ?? 'Unlabeled'}</Table.Td>
      <Table.Td>
        <Badge color={STATE_COLOR[grant.state]} variant="light">
          {grant.state}
        </Badge>
      </Table.Td>
      <Table.Td>{grant.role ?? 'none'}</Table.Td>
      <Table.Td>
        {relativeTime(new Date(grant.createdAt), now)} by {grant.createdBy}
      </Table.Td>
      <Table.Td>{new Date(grant.expiresAt).toLocaleString()}</Table.Td>
      <Table.Td>
        {grant.usedByNode ? (
          <Anchor href={`/nodes/${grant.usedByNode}`}>
            {grant.usedByNode.slice(0, 4)}
          </Anchor>
        ) : (
          '-'
        )}
      </Table.Td>
      <Table.Td>
        {revocable && (
          <Button size="xs" variant="default" onClick={() => onRevoke(grant)}>
            Revoke
          </Button>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function useRevoke(reload: () => void) {
  const [target, setTarget] = useState<GrantRecord | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (!target) return;
    setBusy(true);
    setFailure('');
    try {
      await sendJson('POST', `/v1/enrollment/grants/${target.id}/revoke`);
      setTarget(null);
      reload();
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return { target, setTarget, failure, busy, confirm };
}

function GrantTable({
  grants,
  error,
  reload,
}: {
  grants: GrantRecord[];
  error: string;
  reload: () => void;
}) {
  const revoke = useRevoke(reload);
  const now = new Date();
  if (error) return <ErrorNotice message={error} retry={reload} />;
  if (grants.length === 0)
    return (
      <Text size="sm" c="dimmed">
        No installer grants yet.
      </Text>
    );
  return (
    <>
      <Table withTableBorder aria-label="Installer grants">
        <Table.Thead>
          <Table.Tr>
            {[
              'Label',
              'State',
              'Role',
              'Created',
              'Expires',
              'Used by',
              '',
            ].map((title) => (
              <Table.Th key={title}>{title}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {grants.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              now={now}
              onRevoke={revoke.setTarget}
            />
          ))}
        </Table.Tbody>
      </Table>
      <ConfirmDialog
        opened={revoke.target !== null}
        title="Revoke this installer grant?"
        expected="revoke"
        confirmLabel="Revoke grant"
        busy={revoke.busy}
        error={revoke.failure}
        onClose={() => revoke.setTarget(null)}
        onConfirm={() => void revoke.confirm()}
      >
        <Text size="sm">
          The installer file stops working at once. A machine that already used
          it stays enrolled; reject or retire it separately if needed.
        </Text>
      </ConfirmDialog>
    </>
  );
}
