import type { NodeStatus, Role } from '../../types';
import type { AttentionLevel } from '../lib/attention';
import { cx, tw } from '../lib/tw';

interface StatusMeta {
  readonly label: string;
  readonly dot: string;
  readonly text: string;
  readonly soft: string;
}

export const STATUS_META: Readonly<Record<NodeStatus, StatusMeta>> = {
  online: {
    label: 'Online',
    dot: tw('bg-ok-dot'),
    text: tw('text-ok'),
    soft: tw('bg-ok-soft'),
  },
  stale: {
    label: 'Stale',
    dot: tw('bg-warn-dot'),
    text: tw('text-warn'),
    soft: tw('bg-warn-soft'),
  },
  offline: {
    label: 'Offline',
    dot: tw('bg-bad-dot'),
    text: tw('text-bad'),
    soft: tw('bg-bad-soft'),
  },
  pending: {
    label: 'Pending',
    dot: tw('bg-accent'),
    text: tw('text-accent-ink'),
    soft: tw('bg-accent-soft'),
  },
  rejected: {
    label: 'Rejected',
    dot: tw('bg-fg-3'),
    text: tw('text-fg-2'),
    soft: tw('bg-muted'),
  },
  retired: {
    label: 'Retired',
    dot: tw('bg-fg-3'),
    text: tw('text-fg-2'),
    soft: tw('bg-muted'),
  },
};

/** A dot and the status in words: never color alone. */
export function StatusBadge(props: { status: NodeStatus; class?: string }) {
  const meta = STATUS_META[props.status];
  const pulse = props.status === 'pending' ? tw('pulse-dot') : null;
  return (
    <span
      class={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap font-medium',
        meta.text,
        props.class
      )}
    >
      <span
        role="presentation"
        class={cx('size-2 rounded-full', meta.dot, pulse)}
      />
      {meta.label}
    </span>
  );
}

const LEVEL_STYLE: Record<AttentionLevel, string> = {
  error: tw('bg-bad-soft text-bad'),
  warn: tw('bg-warn-soft text-warn'),
  info: tw('bg-accent-soft text-accent-ink'),
};

const LEVEL_LABEL: Record<AttentionLevel, string> = {
  error: 'Error',
  warn: 'Warning',
  info: 'Notice',
};

export function LevelPill(props: { level: AttentionLevel }) {
  return (
    <span
      class={cx(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        LEVEL_STYLE[props.level]
      )}
    >
      {LEVEL_LABEL[props.level]}
    </span>
  );
}

export function RoleBadge(props: { role: Role }) {
  return (
    <span class="inline-flex items-center rounded-md border border-line bg-muted px-1.5 py-0.5 text-xs font-medium text-fg-2">
      {props.role}
    </span>
  );
}

export function Chip(props: { text: string }) {
  return <span class="chip">{props.text}</span>;
}

export function ChipList(props: { items: readonly string[]; empty?: string }) {
  if (props.items.length === 0) {
    return props.empty === undefined ? null : (
      <span class="text-fg-3">{props.empty}</span>
    );
  }
  return (
    <ul class="flex flex-wrap gap-1" aria-label="Labels">
      {props.items.map((item) => (
        <li key={item}>
          <Chip text={item} />
        </li>
      ))}
    </ul>
  );
}
