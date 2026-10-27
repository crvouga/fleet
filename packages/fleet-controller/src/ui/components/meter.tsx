import { clamp } from '../lib/format';
import { cx, tw } from '../lib/tw';

/** auto: fuller is worse. health: fuller is better. neutral: just a share. */
export type MeterTone = 'auto' | 'neutral' | 'health';

function healthClass(percent: number): string {
  if (percent >= 100) return tw('bg-ok-dot');
  return percent >= 50 ? tw('bg-warn-dot') : tw('bg-bad-dot');
}

function fillClass(percent: number, tone: MeterTone): string {
  if (tone === 'neutral') return tw('bg-chart');
  if (tone === 'health') return healthClass(percent);
  if (percent >= 90) return tw('bg-bad-dot');
  if (percent >= 75) return tw('bg-warn-dot');
  return tw('bg-chart');
}

/** A thin horizontal meter. The number beside it carries the exact value. */
export function Meter(props: {
  percent: number | null;
  label: string;
  class?: string;
  tone?: MeterTone;
}) {
  const percent = props.percent === null ? 0 : clamp(props.percent, 0, 100);
  const fill = fillClass(percent, props.tone ?? 'auto');
  return (
    <div
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      class={cx(
        'h-1.5 w-full overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-line',
        props.class
      )}
    >
      <div
        class={cx('h-full rounded-full', fill)}
        style={`width:${percent.toFixed(1)}%`}
      />
    </div>
  );
}

/** Label, meter and value in one tidy row, for tables. */
export function MeterCell(props: { percent: number | null; label: string }) {
  if (props.percent === null) return <span class="text-fg-3">n/a</span>;
  return (
    <div class="flex w-28 items-center gap-2">
      <Meter percent={props.percent} label={props.label} class="flex-1" />
      <span class="tabular w-9 text-right text-xs text-fg-2">
        {Math.round(props.percent)}%
      </span>
    </div>
  );
}
