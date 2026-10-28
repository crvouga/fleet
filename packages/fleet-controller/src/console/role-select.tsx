/** @jsxImportSource react */
import { useState } from 'react';
import { Button, Group, NativeSelect } from '@mantine/core';
import { ACTIVE_ROLES, type Role } from '../types';
import type { useAction } from './action';

type Action = ReturnType<typeof useAction>;

/** Active roles, plus a retired role the node still carries so it stays visible. */
export function roleOptions(current: Role | null, none: string) {
  const roles: readonly Role[] =
    current === null || (ACTIVE_ROLES as readonly Role[]).includes(current)
      ? ACTIVE_ROLES
      : [...ACTIVE_ROLES, current];
  return [
    { value: '', label: none },
    ...roles.map((role) => ({ value: role, label: role })),
  ];
}

/** Approve, optionally assigning a role in the same step. */
export function ApproveWithRole({
  id,
  label,
  action,
  next,
  size,
}: {
  id: string;
  label: string;
  action: Action;
  next?: string;
  size?: 'xs' | 'sm';
}) {
  const [role, setRole] = useState('');
  return (
    <Group gap="xs" wrap="nowrap">
      <NativeSelect
        aria-label="Role to assign on approval"
        size={size ?? 'sm'}
        data={roleOptions(null, 'No role yet')}
        value={role}
        onChange={(event) => setRole(event.currentTarget.value)}
        disabled={action.busy}
      />
      <Button
        size={size ?? 'sm'}
        loading={action.busy}
        onClick={() =>
          action.run(`/nodes/${id}/approve`, {
            role,
            ...(next ? { next } : {}),
          })
        }
      >
        {label}
      </Button>
    </Group>
  );
}

/** Assign, change or unassign the role. The node converges on its own. */
export function AssignRole({
  id,
  current,
  action,
}: {
  id: string;
  current: Role | null;
  action: Action;
}) {
  const [role, setRole] = useState<string>(current ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(`/nodes/${id}/role`, { role });
      }}
    >
      <Group align="flex-end">
        <NativeSelect
          label="Assigned role"
          description="Applied like a kernel update: drain, reboot into the new system, roll back if unhealthy. Nothing is erased."
          data={roleOptions(current, 'No role (base)')}
          value={role}
          onChange={(event) => setRole(event.currentTarget.value)}
          disabled={action.busy}
          style={{ flex: 1 }}
        />
        <Button type="submit" loading={action.busy}>
          Assign role
        </Button>
      </Group>
    </form>
  );
}
