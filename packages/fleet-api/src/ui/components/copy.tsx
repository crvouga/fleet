import { cx } from '../lib/tw';
import { Icon } from './icon';

/** Copies `text` with a tiny script. Hidden when JavaScript is off. */
export function CopyButton(props: {
  text: string;
  label: string;
  class?: string;
}) {
  return (
    <button
      type="button"
      data-copy={props.text}
      aria-label={props.label}
      title={props.label}
      class={cx(
        'js-only btn btn-ghost btn-sm min-h-6 p-1! text-fg-3 hover:text-fg',
        props.class
      )}
    >
      <Icon name="copy" class="size-3.5" />
    </button>
  );
}

/** A command or hostname in monospace with a copy button beside it. */
export function CopyableCode(props: { text: string; label: string }) {
  return (
    <span class="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-muted py-0.5 pl-2 pr-0.5 font-mono text-xs">
      <code class="truncate">{props.text}</code>
      <CopyButton text={props.text} label={props.label} />
    </span>
  );
}
