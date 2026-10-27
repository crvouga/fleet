import type { HeartbeatPoint } from '../../types';

export interface Bucket {
  readonly start: number;
  readonly end: number;
  readonly value: number | null;
  /** Heartbeats received in this bucket. */
  readonly count: number;
}

export const WINDOW_HOURS = 24;
export const CHART_BUCKETS = 96;

type Pick = (point: HeartbeatPoint) => number | null;

/** Averages a metric into equal time buckets ending at `end`. Empty buckets stay null. */
export function bucketize(
  points: readonly HeartbeatPoint[],
  pick: Pick,
  end: Date,
  buckets: number = CHART_BUCKETS
): Bucket[] {
  const span = WINDOW_HOURS * 3600 * 1000;
  const width = span / buckets;
  const start = end.getTime() - span;
  const sums = new Array<number>(buckets).fill(0);
  const counts = new Array<number>(buckets).fill(0);
  const beats = new Array<number>(buckets).fill(0);
  for (const point of points) {
    const index = Math.floor((point.at.getTime() - start) / width);
    if (index < 0 || index >= buckets) continue;
    beats[index] = (beats[index] ?? 0) + 1;
    const value = pick(point);
    if (value === null) continue;
    sums[index] = (sums[index] ?? 0) + value;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return sums.map((sum, index) => {
    const count = counts[index] ?? 0;
    return {
      start: start + index * width,
      end: start + (index + 1) * width,
      value: count === 0 ? null : sum / count,
      count: beats[index] ?? 0,
    };
  });
}

/** Share of the window in which the node reported at least once per bucket. */
export function availability(
  buckets: readonly Bucket[],
  firstSeenAt: Date
): number | null {
  const relevant = buckets.filter(
    (bucket) => bucket.end > firstSeenAt.getTime()
  );
  if (relevant.length === 0) return null;
  return (
    (relevant.filter((bucket) => bucket.count > 0).length / relevant.length) *
    100
  );
}
