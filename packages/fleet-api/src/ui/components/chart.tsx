import type { Bucket } from '../lib/series';
import { cx } from '../lib/tw';

const WIDTH = 480;
const HEIGHT = 96;
const PAD = 6;

interface Segment {
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

function toSegments(buckets: readonly Bucket[], max: number): Segment[] {
  const step = WIDTH / buckets.length;
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  buckets.forEach((bucket, index) => {
    if (bucket.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    const ratio = Math.min(1, Math.max(0, bucket.value / max));
    current.push({
      x: index * step + step / 2,
      y: HEIGHT - PAD - ratio * (HEIGHT - 2 * PAD),
    });
  });
  if (current.length > 0) segments.push(current);
  return segments.map((points) => ({ points }));
}

function linePath(segment: Segment): string {
  const [first, ...rest] = segment.points;
  if (first === undefined) return '';
  if (rest.length === 0)
    return `M${first.x - 3},${first.y}L${first.x + 3},${first.y}`;
  return `M${first.x.toFixed(1)},${first.y.toFixed(1)}${rest.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}`;
}

function areaPath(segment: Segment): string {
  const first = segment.points[0];
  const last = segment.points[segment.points.length - 1];
  if (first === undefined || last === undefined || segment.points.length < 2)
    return '';
  const base = HEIGHT - PAD;
  return `${linePath(segment)}L${last.x.toFixed(1)},${base}L${first.x.toFixed(1)},${base}Z`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

export type ValueFormat = (value: number) => string;

function HoverColumns(props: {
  buckets: readonly Bucket[];
  max: number;
  format: ValueFormat;
}) {
  const step = WIDTH / props.buckets.length;
  return (
    <g>
      {props.buckets.map((bucket, index) =>
        bucket.value === null ? null : (
          <g key={bucket.start} class="group">
            <rect
              x={index * step}
              y={0}
              width={step}
              height={HEIGHT}
              fill="transparent"
            />
            <line
              x1={index * step + step / 2}
              x2={index * step + step / 2}
              y1={0}
              y2={HEIGHT}
              vector-effect="non-scaling-stroke"
              class="stroke-fg-3 opacity-0 group-hover:opacity-100"
            />
            <title>{`${clock(bucket.start)} UTC: ${props.format(bucket.value)}`}</title>
          </g>
        )
      )}
    </g>
  );
}

function HourlyTable(props: {
  buckets: readonly Bucket[];
  format: ValueFormat;
  title: string;
}) {
  const perHour = props.buckets.length / 24;
  const rows = Array.from({ length: 24 }, (_, hour) => {
    const slice = props.buckets.slice(hour * perHour, (hour + 1) * perHour);
    const values = slice
      .map((b) => b.value)
      .filter((v): v is number => v !== null);
    const first = slice[0];
    return {
      start: first?.start ?? 0,
      value:
        values.length === 0
          ? null
          : values.reduce((a, b) => a + b, 0) / values.length,
    };
  });
  return (
    <details class="mt-3 text-xs">
      <summary class="text-fg-3 hover:text-fg">Show data</summary>
      <table class="mt-2 w-full text-left">
        <caption class="sr-only">{props.title}, hourly average (UTC)</caption>
        <thead>
          <tr>
            <th scope="col" class="py-1 pr-2 font-medium text-fg-3">
              Hour
            </th>
            <th scope="col" class="py-1 font-medium text-fg-3">
              Average
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.start}>
              <th scope="row" class="py-0.5 pr-2 font-normal text-fg-2">
                {clock(row.start)}
              </th>
              <td class="tabular py-0.5">
                {row.value === null ? 'no data' : props.format(row.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function ChartPlot(props: {
  buckets: readonly Bucket[];
  max: number;
  format: ValueFormat;
  label: string;
}) {
  const segments = toSegments(props.buckets, props.max);
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      class="mt-2 h-24 w-full overflow-visible"
    >
      <line
        x1={0}
        x2={WIDTH}
        y1={HEIGHT - PAD}
        y2={HEIGHT - PAD}
        vector-effect="non-scaling-stroke"
        class="stroke-line-strong"
      />
      <line
        x1={0}
        x2={WIDTH}
        y1={HEIGHT / 2}
        y2={HEIGHT / 2}
        vector-effect="non-scaling-stroke"
        stroke-dasharray="3 4"
        class="stroke-line"
      />
      {segments.map((segment) => (
        <g key={segment.points[0]?.x}>
          <path d={areaPath(segment)} class="fill-chart/15 stroke-none" />
          <path
            d={linePath(segment)}
            fill="none"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
            class="stroke-chart"
          />
        </g>
      ))}
      <HoverColumns
        buckets={props.buckets}
        max={props.max}
        format={props.format}
      />
    </svg>
  );
}

/** A 24 h area chart: one thin line, soft fill, hover for the exact value. */
export function AreaChart(props: {
  title: string;
  buckets: readonly Bucket[];
  max: number;
  format: ValueFormat;
  headline: string;
  note?: string;
  class?: string;
}) {
  const present = props.buckets
    .map((b) => b.value)
    .filter((v): v is number => v !== null);
  const range =
    present.length === 0
      ? 'no data in the last 24 hours'
      : `low ${props.format(Math.min(...present))}, high ${props.format(Math.max(...present))}`;
  return (
    <section class={cx('card card-pad', props.class)} aria-label={props.title}>
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="text-sm font-medium text-fg-2">{props.title}</h3>
        <p class="tabular text-lg font-semibold">{props.headline}</p>
      </div>
      <ChartPlot
        buckets={props.buckets}
        max={props.max}
        format={props.format}
        label={`${props.title} over the last 24 hours: ${range}`}
      />
      <div class="mt-1 flex justify-between text-xs text-fg-3">
        <span>24 h ago</span>
        <span>{props.note ?? range}</span>
        <span>now</span>
      </div>
      <HourlyTable
        buckets={props.buckets}
        format={props.format}
        title={props.title}
      />
    </section>
  );
}

/** One cell per 15 minutes: did the node report? */
export function AvailabilityStrip(props: {
  buckets: readonly Bucket[];
  firstSeenAt: Date;
  percent: number | null;
}) {
  const cell = 10;
  const gap = 2;
  const width = props.buckets.length * (cell + gap) - gap;
  return (
    <section class="card card-pad" aria-label="Availability">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="text-sm font-medium text-fg-2">Availability, last 24 h</h3>
        <p class="tabular text-lg font-semibold">
          {props.percent === null
            ? 'n/a'
            : `${props.percent.toFixed(props.percent === 100 ? 0 : 1)}%`}
        </p>
      </div>
      <svg
        role="img"
        aria-label={`Availability over the last 24 hours: ${props.percent === null ? 'no data' : `${props.percent.toFixed(1)} percent of 15 minute periods reported`}`}
        viewBox={`0 0 ${width} 28`}
        preserveAspectRatio="none"
        class="mt-3 h-7 w-full"
      >
        {props.buckets.map((bucket, index) => {
          const before = bucket.end <= props.firstSeenAt.getTime();
          const state = before
            ? 'before first report'
            : bucket.count > 0
              ? 'reporting'
              : 'no report';
          return (
            <rect
              key={bucket.start}
              x={index * (cell + gap)}
              y={0}
              width={cell}
              height={28}
              rx={2}
              class={
                before
                  ? 'fill-muted'
                  : bucket.count > 0
                    ? 'fill-ok-dot'
                    : 'fill-bad-dot'
              }
            >
              <title>{`${clock(bucket.start)}-${clock(bucket.end)} UTC: ${state}`}</title>
            </rect>
          );
        })}
      </svg>
      <div class="mt-1 flex justify-between text-xs text-fg-3">
        <span>24 h ago</span>
        <span>green: returned sample, red: no returned sample</span>
        <span>now</span>
      </div>
    </section>
  );
}
