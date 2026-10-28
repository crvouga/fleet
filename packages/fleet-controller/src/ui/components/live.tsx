import type { Child } from 'hono/jsx';

import { Icon } from './icon';

/** The block a tiny script refreshes from `src` every 10 s. Works without JS. */
export function LiveRegion(props: { src: string; children?: Child }) {
  return (
    <div id="live" data-live-src={props.src}>
      {props.children}
    </div>
  );
}

/** "Updated 5 s ago" and a pause button. Both appear only when JavaScript runs. */
export function LiveStatus(props: { now: Date }) {
  return (
    <div class="js-only items-center gap-2 text-xs text-fg-3">
      <span data-live-status data-live-at={props.now.toISOString()}>
        Updated just now
      </span>
      <button
        type="button"
        data-live-toggle
        class="btn btn-ghost btn-sm"
        aria-pressed="false"
      >
        <Icon name="clock" />
        <span data-live-toggle-label>Pause</span>
      </button>
    </div>
  );
}
