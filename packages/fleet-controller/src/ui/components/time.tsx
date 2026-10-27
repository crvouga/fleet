import { exactTime, relativeTime } from '../lib/format';

/** Relative text now; a tiny script keeps it fresh. The exact time is the tooltip. */
export function Time(props: { at: Date | null; now: Date; never?: string }) {
  if (props.at === null)
    return <span class="text-fg-3">{props.never ?? 'never'}</span>;
  return (
    <time
      datetime={props.at.toISOString()}
      title={exactTime(props.at)}
      data-rel
      class="whitespace-nowrap"
    >
      {relativeTime(props.at, props.now)}
    </time>
  );
}

/** The exact timestamp in plain text, for facts lists. */
export function ExactTime(props: { at: Date | null }) {
  if (props.at === null) return <span class="text-fg-3">never</span>;
  return <time datetime={props.at.toISOString()}>{exactTime(props.at)}</time>;
}
