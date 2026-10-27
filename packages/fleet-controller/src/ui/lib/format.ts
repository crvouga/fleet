const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const JUST_NOW_SECONDS = 5;

/** "12 s ago", "5 min ago", "3 h ago", "2 d ago". The browser script mirrors this. */
export function relativeTime(at: Date | null, now: Date): string {
  if (at === null) return 'never';
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < JUST_NOW_SECONDS) return 'just now';
  if (seconds < MINUTE) return `${seconds} s ago`;
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} min ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)} h ago`;
  return `${Math.floor(seconds / DAY)} d ago`;
}

/** 2026-10-14 12:00:00 UTC */
export function exactTime(at: Date): string {
  return `${at.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** "45s", "12m", "3h 05m", "4d 2h". */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) return 'unknown';
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < MINUTE) return `${seconds}s`;
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) {
    const minutes = Math.floor((seconds % HOUR) / MINUTE);
    return `${Math.floor(seconds / HOUR)}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${Math.floor(seconds / DAY)}d ${Math.floor((seconds % DAY) / HOUR)}h`;
}

/** First seven characters of a commit hash. */
export function shortRevision(revision: string | null): string {
  return revision === null ? 'unknown' : revision.slice(0, 7);
}

export function formatMiB(mebibytes: number | null): string {
  if (mebibytes === null) return 'unknown';
  if (mebibytes >= 1024)
    return `${(mebibytes / 1024).toFixed(mebibytes >= 10240 ? 0 : 1)} GiB`;
  return `${Math.round(mebibytes)} MiB`;
}

export function formatLoad(load: number | null): string {
  return load === null ? 'n/a' : load.toFixed(2);
}

export function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value)}%`;
}

/** Never shows the path or query of a webhook: they usually carry the secret. */
export function maskUrl(url: string | null | undefined): string {
  if (url === null || url === undefined || url === '') return 'not set';
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return 'invalid URL';
  }
}

export function pluralize(
  count: number,
  singular: string,
  plural?: string
): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
