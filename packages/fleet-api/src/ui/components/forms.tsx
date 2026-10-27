import type { Child } from 'hono/jsx';

import { cx, tw } from '../lib/tw';

const TONE_CLASS = {
  primary: tw('btn-primary'),
  danger: tw('btn-danger'),
  default: '',
} as const;

/** A POST button. State changes are always forms, so they work without JavaScript. */
export function ActionForm(props: {
  action: string;
  label: string;
  tone?: 'primary' | 'danger' | 'default';
  hidden?: Readonly<Record<string, string>>;
  small?: boolean;
  children?: Child;
}) {
  const tone = props.tone ?? 'default';
  return (
    <form method="post" action={props.action} class="inline">
      {Object.entries(props.hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        class={cx('btn', TONE_CLASS[tone], props.small === true && 'btn-sm')}
      >
        {props.children}
        {props.label}
      </button>
    </form>
  );
}

/**
 * A destructive action behind an explicit second step. A details element
 * needs no JavaScript: opening it reveals what will happen and the button.
 */
export function Confirm(props: {
  summary: string;
  warning: string;
  action: string;
  button: string;
  id: string;
}) {
  return (
    <details
      id={props.id}
      class="group rounded-lg border border-bad/30 bg-bad-soft/40 open:bg-bad-soft/60"
    >
      <summary class="flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-bad">
        {props.summary}
      </summary>
      <form
        method="post"
        action={props.action}
        class="space-y-3 border-t border-bad/20 px-3 py-3"
      >
        <input type="hidden" name="confirm" value="yes" />
        <p class="text-sm text-fg-2">{props.warning}</p>
        <button type="submit" class="btn btn-danger">
          {props.button}
        </button>
      </form>
    </details>
  );
}

export function FieldError(props: { id: string; message: string | undefined }) {
  if (props.message === undefined) return null;
  return (
    <p
      id={props.id}
      class="mt-1 flex items-center gap-1 text-xs font-medium text-bad"
    >
      {props.message}
    </p>
  );
}
